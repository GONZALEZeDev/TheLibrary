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
 * One worker and the requests it has not answered yet. A crash, or an answer saying the worker is
 * unavailable, drops the whole session, and the next call starts a new one: an answer or a report that comes late from a dropped session only
 * reaches its own (empty) map of requests, never the requests of the session that replaced it.
 */
interface WorkerSession {
  readonly worker: WorkerLike;
  /** The requests sent to `worker` and not answered yet, by request `id`. */
  readonly pending: Map<number, PendingRequest>;
}

/** Message of the error a broken compressor is reported with (kind `storage`). */
const COMPRESSOR_FAILED = 'The compressor failed';

/** Message of the error a codec failure on the caller's data is reported with (kind `invalid_payload`). */
const COMPRESSOR_REJECTED_DATA = 'The compressor could not read the data';

/**
 * Report a broken compressor: the worker cannot be created or reached, it crashed, or it answered
 * that it is unavailable.
 *
 * @param cause - What failed, kept for the logs.
 * @returns The error the calls that the failure hit reject with.
 */
function compressorFailure(cause: unknown): AppError {
  return new AppError('storage', COMPRESSOR_FAILED, { cause });
}

/**
 * Report a codec failure on the data of a request: the worker is healthy and answered that the
 * codec ran and could not process the bytes (for example a decompression of bytes that are not a
 * zstd frame).
 *
 * @param cause - The message the worker reported, kept for the logs.
 * @returns The error the call that the failure hit rejects with.
 */
function compressorRejectedData(cause: unknown): AppError {
  return new AppError('invalid_payload', COMPRESSOR_REJECTED_DATA, { cause });
}

/**
 * {@link Compressor} that delegates to the zstd Web Worker.
 *
 * A call rejects with an {@link AppError} that keeps the original failure as its `cause`, and the
 * kind tells the caller whose fault it is:
 * - `invalid_payload`, with the message `The compressor could not read the data`: the worker
 *   answered `kind: 'data'`, that is, the codec ran and could not process the bytes it got (for
 *   example bytes that are not a zstd frame). This is a problem of the data, and the worker stays
 *   in use.
 * - `storage`, with the message `The compressor failed`: the compressor itself is broken, and says
 *   nothing about the data. The worker cannot be created, a request cannot be copied or sent, the
 *   worker crashes or fails to load its script, or it answers `kind: 'unavailable'` (its codec
 *   could not be loaded, which includes a refused WebAssembly, the operation is unknown, or the
 *   request is malformed). In all these cases except the creation, copy and send failures, the
 *   worker is stopped and the next call starts a new one, which can recover from a failed load.
 *
 * Errors cross the worker boundary as text, so only this adapter can classify them, from the
 * `kind` of the answer.
 */
export class WorkerCompressor implements Compressor {
  /** Starts the worker. Called on the first request, and again after the worker was dropped. */
  readonly #createWorker: () => WorkerLike;

  /** The worker in use, or `null` before the first call and after the worker was dropped. */
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
   * @throws {@link AppError} of kind `storage` when the compressor is broken, or of kind
   *   `invalid_payload` when the codec cannot process the bytes (see the class).
   */
  compress(bytes: Uint8Array): Promise<Uint8Array> {
    return this.#request('compress', bytes);
  }

  /**
   * Decompress a zstd frame, in the worker.
   *
   * @param bytes - The zstd frame. The caller keeps it: the worker gets a copy.
   * @returns The original data.
   * @throws {@link AppError} of kind `invalid_payload` when the bytes are not a valid zstd frame,
   *   or of kind `storage` when the compressor is broken (see the class).
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
   * Stop trusting a worker: stop it, forget it, fail the requests it still owes, and let the next
   * call start a new one. A worker that failed to load, or that kept running after an uncaught
   * error, must not stay in memory.
   *
   * A report from a worker already replaced must not touch the session that replaced it, and it
   * has no request left to fail: nothing happens.
   *
   * @param session - The session of the worker.
   * @param cause - What went wrong, kept for the logs as the cause of each failure.
   */
  #dropSession(session: WorkerSession, cause: unknown): void {
    if (this.#session !== session) {
      return;
    }
    session.worker.terminate();
    this.#session = null;
    const pending = [...session.pending.values()];
    session.pending.clear();
    for (const request of pending) {
      request.reject(compressorFailure(cause));
    }
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
        // Answer to a request that was already rejected (its worker was dropped meanwhile).
        return;
      }
      session.pending.delete(response.id);
      if (!('error' in response)) {
        request.resolve(response.bytes);
        return;
      }
      // The worker caught a failure and sent its message (never the data). Keep it as the cause,
      // for the logs.
      const cause = new Error(response.error);
      if (response.kind === 'data') {
        // The codec ran and failed on the bytes of this request. The worker is healthy, so this is
        // a problem of the data, not of the compressor, and nothing else is touched.
        request.reject(compressorRejectedData(cause));
      } else {
        // Anything else (the kind is checked for `data` only: an answer without a kind is not
        // trusted either): the codec could not do its job, which says nothing about the bytes.
        // The worker is broken the way a crash would break it, and a failed load of the
        // WebAssembly is kept by the library for the life of the worker: it is replaced, so that
        // the next call can succeed.
        request.reject(compressorFailure(cause));
        this.#dropSession(session, cause);
      }
    });

    worker.addEventListener('error', (event) => {
      // `event.error` is empty when the script could not be loaded; the message then tells what
      // happened.
      this.#dropSession(session, (event.error as unknown) ?? event.message);
    });

    this.#session = session;
    return session;
  }
}
