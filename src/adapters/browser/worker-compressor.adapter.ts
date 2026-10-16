/**
 * Compressor adapter for the desktop app: runs the zstd codec in a Web Worker.
 *
 * Compressing at level 19 takes long enough on a large file to freeze the window, so the work
 * happens in `src/workers/zstd.worker.ts` and this class only exchanges messages with it. The
 * worker is created on the first call and kept. Each request gets an `id` that the worker echoes
 * in its answer, so several calls can be in flight at once and their answers may come in any
 * order. The worker file is reached through its URL (`new URL(…, import.meta.url)`), never
 * imported, so this layer does not depend on the `workers` layer.
 *
 * @packageDocumentation
 */
import type {
  ZstdOperation,
  ZstdRequest,
  ZstdResponse,
} from '../../core/compression/zstd-protocol';
import { AppError } from '../../core/errors/app-error';
import type { Compressor } from '../../ports/compressor.port';

/**
 * The part of a `Worker` the compressor uses, so tests can stand in a fake: jsdom has no `Worker`.
 */
export interface WorkerLike {
  /**
   * Send a request, handing over (not copying) the buffers of `transfer`.
   *
   * @param message - The request.
   * @param transfer - The buffers to hand over: the sender loses them.
   */
  postMessage(message: ZstdRequest, transfer: Transferable[]): void;

  /**
   * Listen to the answers of the worker.
   *
   * @param type - The event: one `message` per answer.
   * @param listener - Called with each answer.
   */
  addEventListener(type: 'message', listener: (event: MessageEvent<ZstdResponse>) => void): void;

  /**
   * Listen to the crashes of the worker.
   *
   * @param type - The event: `error` when the worker fails outside a request, for example when
   *   its script cannot be loaded.
   * @param listener - Called with the failure.
   */
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;

  /** Stop the worker at once. Its pending work is abandoned and nothing it sends is delivered. */
  terminate(): void;
}

/** A call waiting for the answer of the worker. */
interface PendingRequest {
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * One worker and the requests it has not answered yet. A crash drops the whole session, and the
 * next call starts a new one: an answer or a report that comes late from a dropped session only
 * reaches its own (empty) map of requests, never the requests of the session that replaced it.
 */
interface WorkerSession {
  readonly worker: WorkerLike;
  /** The requests sent to `worker` and not answered yet, by request `id`. */
  readonly pending: Map<number, PendingRequest>;
}

/** Message of the error every failure of the compressor is reported with. */
const COMPRESSOR_FAILED = 'The compressor failed';

/**
 * Report a failure of the compressor.
 *
 * @param cause - What failed, kept for the logs.
 * @returns The error every call of the compressor rejects with.
 */
function compressorFailure(cause: unknown): AppError {
  return new AppError('storage', COMPRESSOR_FAILED, { cause });
}

/**
 * {@link Compressor} that delegates to the zstd Web Worker.
 *
 * Every failure rejects with the same error, an {@link AppError} of kind `storage` with the message
 * `The compressor failed` and the original failure as its `cause`: the worker cannot be created,
 * a request cannot be sent, the worker crashes, or it reports an error (which includes bytes that
 * are not a zstd frame). Errors cross the worker boundary as text, so only this adapter can report
 * them; the archive, the only caller, cannot go on without its compressor.
 */
export class WorkerCompressor implements Compressor {
  /** Starts the worker. Called on the first request, and again after a crash. */
  readonly #createWorker: () => WorkerLike;

  /** The worker in use, or `null` before the first call and after a crash. */
  #session: WorkerSession | null = null;

  /** Id of the next request. Never reused, so an old answer cannot be taken for a new one. */
  #nextId = 0;

  /**
   * @param createWorker - Starts the zstd worker. The default is the exact
   *   `new Worker(new URL(…, import.meta.url), { type: 'module' })` form: it is the one Vite
   *   recognises to bundle the worker file (and the codec it imports) as a separate chunk loaded
   *   from the app's own origin, which the Content-Security-Policy allows (`worker-src 'self'`).
   *   An inline worker (`?worker&inline`) would need `blob:` there.
   */
  constructor(
    createWorker: () => WorkerLike = () =>
      new Worker(new URL('../../workers/zstd.worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.#createWorker = createWorker;
  }

  /**
   * Compress bytes with zstd at level 19, in the worker.
   *
   * @param bytes - The data to compress. The caller keeps them: the worker gets a copy.
   * @returns The zstd frame.
   * @throws {@link AppError} of kind `storage` when the compressor fails (see the class).
   */
  compress(bytes: Uint8Array): Promise<Uint8Array> {
    return this.#request('compress', bytes);
  }

  /**
   * Decompress a zstd frame, in the worker.
   *
   * @param bytes - The zstd frame. The caller keeps it: the worker gets a copy.
   * @returns The original data.
   * @throws {@link AppError} of kind `storage` when the compressor fails (see the class), which
   *   includes bytes that are not a valid zstd frame.
   */
  decompress(bytes: Uint8Array): Promise<Uint8Array> {
    return this.#request('decompress', bytes);
  }

  /**
   * Send one request to the worker and wait for its answer.
   *
   * @param operation - What to do with the bytes.
   * @param bytes - The caller's bytes, which are copied, not handed over.
   * @returns The bytes of the answer.
   */
  #request(operation: ZstdOperation, bytes: Uint8Array): Promise<Uint8Array> {
    // Everything runs inside the promise executor and its `try`, so a failure to copy the bytes,
    // to create the worker or to send the message rejects the promise with the compressor's error
    // instead of throwing at the caller.
    return new Promise((resolve, reject) => {
      try {
        // The worker gets a copy, and the copy's buffer is the one handed over: transferring the
        // caller's own buffer would detach it, and the caller still needs its bytes (and a view of
        // a few bytes in a large buffer would hand over the whole buffer). `slice` copies the
        // viewed bytes into a new buffer of exactly their size. It comes first: if it throws,
        // nothing is registered yet.
        const copy = bytes.slice();
        const session = this.#session ?? this.#startSession();
        const id = this.#nextId++;
        session.pending.set(id, { resolve, reject });
        try {
          session.worker.postMessage({ id, operation, bytes: copy }, [copy.buffer]);
        } catch (error) {
          // Nothing was sent, so no answer will ever clear this entry.
          session.pending.delete(id);
          throw error;
        }
      } catch (error) {
        reject(compressorFailure(error));
      }
    });
  }

  /**
   * Create a worker and start listening to it.
   *
   * @returns The new session, which is also the one the next requests use.
   */
  #startSession(): WorkerSession {
    const worker = this.#createWorker();
    const session: WorkerSession = { worker, pending: new Map() };

    worker.addEventListener('message', (event) => {
      const response = event.data;
      const request = session.pending.get(response.id);
      if (request === undefined) {
        // Answer to a request that was already rejected (the worker crashed meanwhile).
        return;
      }
      session.pending.delete(response.id);
      if ('error' in response) {
        // The worker caught the failure and sent its message (never the data). Keep it as the
        // cause, for the logs.
        request.reject(compressorFailure(new Error(response.error)));
      } else {
        request.resolve(response.bytes);
      }
    });

    worker.addEventListener('error', (event) => {
      // A report from a worker already replaced must not touch the session that replaced it.
      if (this.#session !== session) {
        return;
      }
      // The worker is not trusted any more: stop it (a worker that failed to load, or that kept
      // running after an uncaught error, must not stay in memory), forget it, fail what it still
      // owed, and let the next call start a new one. `event.error` is empty when the script could
      // not be loaded; the message then tells what happened.
      session.worker.terminate();
      this.#session = null;
      const pending = [...session.pending.values()];
      session.pending.clear();
      const cause = (event.error as unknown) ?? event.message;
      for (const request of pending) {
        request.reject(compressorFailure(cause));
      }
    });

    this.#session = session;
    return session;
  }
}
