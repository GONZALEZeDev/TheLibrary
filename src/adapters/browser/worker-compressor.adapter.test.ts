/**
 * Tests of the worker compressor, against a fake worker.
 *
 * jsdom has no `Worker`, so the tests hand the compressor a {@link WorkerLike} of their own. It
 * receives each request as a structured clone with the transfer list applied (like a real worker,
 * and the clone detaches every transferred buffer), and answers by reversing the bytes, for
 * `compress` and for `decompress` alike. Reversing twice gives the original back, so a round trip
 * is easy to check. The test can answer by hand, in any order, or make the worker fail.
 *
 * Bytes are compared as plain arrays, never with `instanceof`: under jsdom a typed array made by a
 * Node API (here, the structured clone) is not an `instanceof` the one of the test realm.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import type {
  ZstdErrorKind,
  ZstdRequest,
  ZstdResponse,
} from '../../core/compression/zstd-protocol';
import { AppError } from '../../core/errors/app-error';
import { WorkerCompressor, type WorkerLike } from './worker-compressor.adapter';

/** Fake {@link WorkerLike}: what a real worker would receive, and answers made on demand. */
class FakeWorker implements WorkerLike {
  /** The requests received so far, in arrival order, as the structured clones a worker gets. */
  readonly received: ZstdRequest[] = [];

  /** The transfer list of each request, in arrival order. */
  readonly transfers: Transferable[][] = [];

  /** Whether the compressor has stopped this worker with `terminate`. */
  terminated = false;

  /** When set, `postMessage` throws it instead of receiving the request (a request that cannot be cloned). */
  postError: Error | null = null;

  /** Whether each request is answered by itself, in a later microtask; if not, the test answers. */
  readonly #autoAnswer: boolean;

  readonly #messageListeners: ((event: MessageEvent<ZstdResponse>) => void)[] = [];
  readonly #errorListeners: ((event: ErrorEvent) => void)[] = [];

  /** @param autoAnswer - Whether to answer each request without waiting for the test. */
  constructor(autoAnswer: boolean) {
    this.#autoAnswer = autoAnswer;
  }

  postMessage(message: ZstdRequest, transfer: Transferable[]): void {
    if (this.postError !== null) {
      throw this.postError;
    }
    // Like a real `postMessage`: the worker gets a copy, and the transferred buffers are detached
    // from the sender.
    const request = structuredClone(message, { transfer });
    this.received.push(request);
    this.transfers.push(transfer);
    if (this.#autoAnswer) {
      queueMicrotask(() => {
        this.answer(this.received.indexOf(request));
      });
    }
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<ZstdResponse>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    if (type === 'message') {
      this.#messageListeners.push(listener as (event: MessageEvent<ZstdResponse>) => void);
    } else {
      this.#errorListeners.push(listener as (event: ErrorEvent) => void);
    }
  }

  /**
   * Answer a received request with its bytes reversed.
   *
   * @param index - Position of the request in {@link FakeWorker.received}.
   */
  answer(index: number): void {
    const request = this.#requestAt(index);
    this.#send({ id: request.id, bytes: Uint8Array.from(request.bytes).reverse() });
  }

  /**
   * Answer a received request with an error, like the real worker does when the codec throws.
   *
   * @param index - Position of the request in {@link FakeWorker.received}.
   * @param message - The error message.
   * @param kind - Whose fault it is: `data` when the codec failed on the bytes of the request,
   *   `unavailable` when the worker could not do its job at all (the codec failed to load...).
   */
  fail(index: number, message: string, kind: ZstdErrorKind): void {
    this.#send({ id: this.#requestAt(index).id, error: message, kind });
  }

  terminate(): void {
    this.terminated = true;
  }

  /**
   * Make the worker report a crash.
   *
   * @param error - The error the event carries. Without one, the event only has a message, like
   *   the event of a worker whose script could not be loaded.
   */
  crash(error?: Error): void {
    for (const listener of this.#errorListeners) {
      listener(
        new ErrorEvent('error', {
          message: 'The worker crashed',
          ...(error === undefined ? {} : { error }),
        }),
      );
    }
  }

  #requestAt(index: number): ZstdRequest {
    const request = this.received[index];
    if (request === undefined) {
      throw new Error(`The fake worker received no request at position ${String(index)}`);
    }
    return request;
  }

  #send(response: ZstdResponse): void {
    for (const listener of this.#messageListeners) {
      listener(new MessageEvent('message', { data: response }));
    }
  }
}

/**
 * Build a compressor on fake workers.
 *
 * @param options - `autoAnswer: false` leaves the answering to the test; `postError` makes
 *   `postMessage` of the workers throw it.
 * @returns The compressor, and every worker it created so far (the array grows as it creates more).
 */
function createCompressor(
  options: { readonly autoAnswer?: boolean; readonly postError?: Error } = {},
): {
  readonly compressor: WorkerCompressor;
  readonly workers: readonly FakeWorker[];
} {
  const workers: FakeWorker[] = [];
  const compressor = new WorkerCompressor(() => {
    const worker = new FakeWorker(options.autoAnswer ?? true);
    worker.postError = options.postError ?? null;
    workers.push(worker);
    return worker;
  });
  return { compressor, workers };
}

/**
 * Get a worker the compressor created.
 *
 * @param workers - The workers of {@link createCompressor}.
 * @param index - Order of creation, from 0.
 * @returns The worker.
 */
function workerAt(workers: readonly FakeWorker[], index: number): FakeWorker {
  const worker = workers[index];
  if (worker === undefined) {
    throw new Error(`The compressor created no worker at position ${String(index)}`);
  }
  return worker;
}

/**
 * Wait for a promise to reject and check that it did so with an {@link AppError}.
 *
 * @param promise - The promise of a compressor call.
 * @returns The error, so a test can look at its kind, its message and its cause.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/**
 * Expect a promise to reject with the error of a broken compressor: the worker cannot be created
 * or reached, or it crashed.
 *
 * @param promise - The promise of a compressor call.
 * @returns The error, once the expectation holds, so a test can look at its cause.
 */
async function expectStorageError(promise: Promise<unknown>): Promise<AppError> {
  const error = await rejectionOf(promise);
  expect(error).toMatchObject({ kind: 'storage', message: 'The compressor failed' });
  return error;
}

/**
 * Expect a promise to reject with the error of bad data: the worker answered, and reported that
 * the codec could not process the bytes it got.
 *
 * @param promise - The promise of a compressor call.
 * @returns The error, once the expectation holds, so a test can look at its cause.
 */
async function expectInvalidPayloadError(promise: Promise<unknown>): Promise<AppError> {
  const error = await rejectionOf(promise);
  expect(error).toMatchObject({
    kind: 'invalid_payload',
    message: 'The compressor could not read the data',
  });
  return error;
}

describe('WorkerCompressor', () => {
  it('compresses through the worker', async () => {
    const { compressor, workers } = createCompressor();

    const result = await compressor.compress(Uint8Array.of(1, 2, 3, 4));

    expect(Array.from(result)).toEqual([4, 3, 2, 1]);
    expect(workerAt(workers, 0).received.map((request) => request.operation)).toEqual(['compress']);
  });

  it('decompresses through the worker', async () => {
    const { compressor, workers } = createCompressor();

    const result = await compressor.decompress(Uint8Array.of(4, 3, 2, 1));

    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    expect(workerAt(workers, 0).received.map((request) => request.operation)).toEqual([
      'decompress',
    ]);
  });

  it('creates its worker on the first call and keeps it', async () => {
    const { compressor, workers } = createCompressor();
    expect(workers).toHaveLength(0);

    await compressor.compress(Uint8Array.of(1));
    await compressor.decompress(Uint8Array.of(2));

    expect(workers).toHaveLength(1);
  });

  it('matches concurrent answers to their requests', async () => {
    const { compressor, workers } = createCompressor({ autoAnswer: false });

    const first = compressor.compress(Uint8Array.of(1, 2, 3));
    const second = compressor.decompress(Uint8Array.of(4, 5, 6, 7));
    const third = compressor.compress(Uint8Array.of(8, 9));
    const worker = workerAt(workers, 0);
    expect(workers).toHaveLength(1);
    expect(worker.received).toHaveLength(3);

    // The worker answers in another order than it was asked.
    worker.answer(2);
    worker.answer(0);
    worker.answer(1);

    expect(Array.from(await first)).toEqual([3, 2, 1]);
    expect(Array.from(await second)).toEqual([7, 6, 5, 4]);
    expect(Array.from(await third)).toEqual([9, 8]);
  });

  it('rejects with an invalid_payload error when the worker reports a codec error', async () => {
    const { compressor, workers } = createCompressor({ autoAnswer: false });

    const failing = compressor.decompress(Uint8Array.of(1, 2, 3));
    const healthy = compressor.compress(Uint8Array.of(4, 5));
    const worker = workerAt(workers, 0);
    const failure = expectInvalidPayloadError(failing);
    worker.fail(0, 'decompress failed: Unknown frame descriptor', 'data');
    worker.answer(1);

    // Only the request that failed is rejected, and the technical message is kept as its cause.
    const error = await failure;
    expect(error.cause).toMatchObject({ message: 'decompress failed: Unknown frame descriptor' });
    expect(Array.from(await healthy)).toEqual([5, 4]);

    // A bad frame is a problem of the data, not of the worker: the worker is still the one in use,
    // and it was not stopped.
    expect(worker.terminated).toBe(false);
    const later = compressor.compress(Uint8Array.of(6, 7));
    worker.answer(2);
    expect(Array.from(await later)).toEqual([7, 6]);
    expect(workers).toHaveLength(1);
  });

  it('rejects with a storage error, stops the worker and starts a new one when the worker is unavailable', async () => {
    const { compressor, workers } = createCompressor({ autoAnswer: false });

    const failing = compressor.decompress(Uint8Array.of(1, 2, 3));
    const other = compressor.compress(Uint8Array.of(4, 5));
    const unavailable = workerAt(workers, 0);
    const failure = expectStorageError(failing);
    const otherFailure = expectStorageError(other);
    // The worker answers that it could not load its codec: nothing it says about the bytes counts.
    unavailable.fail(0, 'The zstd codec could not be loaded', 'unavailable');

    // The request is rejected as a broken compressor, with the message of the worker as the cause,
    // not as a problem of its data...
    const error = await failure;
    expect(error.cause).toMatchObject({ message: 'The zstd codec could not be loaded' });
    // ...and so is the other request the worker still owed, like for a crash of the worker.
    expect((await otherFailure).cause).toBe(error.cause);
    expect(unavailable.terminated).toBe(true);

    // The next call starts again on a new worker, whose load of the codec can succeed this time.
    const later = compressor.compress(Uint8Array.of(6, 7));
    expect(workers).toHaveLength(2);
    // The worker that was stopped is not heard any more: its late answer reaches nobody.
    unavailable.answer(1);
    workerAt(workers, 1).answer(0);
    expect(Array.from(await later)).toEqual([7, 6]);
    expect(workerAt(workers, 1).terminated).toBe(false);
    expect(workers).toHaveLength(2);
  });

  it('keeps the worker that reports an error on the data, and the requests it still owes', async () => {
    const { compressor, workers } = createCompressor({ autoAnswer: false });

    const failing = compressor.decompress(Uint8Array.of(1, 2, 3));
    const owed = compressor.compress(Uint8Array.of(4, 5));
    const worker = workerAt(workers, 0);
    const failure = expectInvalidPayloadError(failing);
    worker.fail(0, 'Unknown frame descriptor', 'data');
    await failure;

    // A bad frame says nothing about the worker: it stays, it is not stopped, and the other
    // request is answered by it.
    expect(worker.terminated).toBe(false);
    worker.answer(1);
    expect(Array.from(await owed)).toEqual([5, 4]);
    expect(workers).toHaveLength(1);
  });

  it('creates a new worker after the worker crashed', async () => {
    const { compressor, workers } = createCompressor({ autoAnswer: false });
    const crash = new Error('The worker script failed');

    const first = compressor.compress(Uint8Array.of(1, 2));
    const second = compressor.decompress(Uint8Array.of(3, 4));
    const rejections = Promise.all([expectStorageError(first), expectStorageError(second)]);
    const crashed = workerAt(workers, 0);
    expect(crashed.terminated).toBe(false);
    crashed.crash(crash);

    // Every request the worker still had is rejected, with the error of the crash as the cause,
    // and the crashed worker is stopped.
    const errors = await rejections;
    expect(errors.map((error) => error.cause)).toEqual([crash, crash]);
    expect(crashed.terminated).toBe(true);

    // The next call starts again on a new worker.
    const third = compressor.compress(Uint8Array.of(5, 6));
    expect(workers).toHaveLength(2);
    workerAt(workers, 1).answer(0);
    expect(Array.from(await third)).toEqual([6, 5]);
    expect(workerAt(workers, 1).terminated).toBe(false);
  });

  it('keeps the message of a crash report that carries no error object', async () => {
    const { compressor, workers } = createCompressor({ autoAnswer: false });

    const request = expectStorageError(compressor.compress(Uint8Array.of(1)));
    workerAt(workers, 0).crash();

    // A worker whose script cannot be loaded reports a message only.
    expect((await request).cause).toBe('The worker crashed');
  });

  it('ignores the late reports of a worker it already replaced', async () => {
    const { compressor, workers } = createCompressor({ autoAnswer: false });
    const crashed = compressor.compress(Uint8Array.of(1));
    const crashRejection = expectStorageError(crashed);
    workerAt(workers, 0).crash();
    await crashRejection;

    const pending = compressor.compress(Uint8Array.of(2, 3));
    // The old worker reports again, and answers a request that was already rejected.
    workerAt(workers, 0).crash();
    workerAt(workers, 0).answer(0);
    workerAt(workers, 1).answer(0);

    expect(Array.from(await pending)).toEqual([3, 2]);
    expect(workers).toHaveLength(2);
  });

  it('rejects with a storage error when the worker cannot be created', async () => {
    const failure = new Error('Workers are not supported');
    let attempts = 0;
    const compressor = new WorkerCompressor(() => {
      attempts += 1;
      throw failure;
    });

    // The call rejects instead of throwing, with the failure as the cause, and the next call
    // tries again.
    expect((await expectStorageError(compressor.compress(Uint8Array.of(1)))).cause).toBe(failure);
    expect((await expectStorageError(compressor.decompress(Uint8Array.of(1)))).cause).toBe(failure);
    expect(attempts).toBe(2);
  });

  it('rejects with a storage error when the request cannot be sent', async () => {
    const failure = new Error('The request cannot be cloned');
    const { compressor, workers } = createCompressor({ postError: failure });

    const error = await expectStorageError(compressor.compress(Uint8Array.of(1, 2)));
    expect(error.cause).toBe(failure);

    // The worker was kept, and the next call works on it once sending works again.
    const worker = workerAt(workers, 0);
    worker.postError = null;
    expect(Array.from(await compressor.compress(Uint8Array.of(3, 4)))).toEqual([4, 3]);
    expect(workers).toHaveLength(1);
  });

  it('rejects with a storage error when the bytes cannot be copied', async () => {
    const { compressor, workers } = createCompressor();
    // A typed array whose buffer was transferred away cannot be read any more.
    const detached = Uint8Array.of(1, 2, 3);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });

    const error = await expectStorageError(compressor.compress(detached));

    expect(error.cause).toMatchObject({ name: 'TypeError' });
    // Nothing was started or sent for it.
    expect(workers).toHaveLength(0);
  });

  it("leaves the caller's bytes untouched", async () => {
    const { compressor, workers } = createCompressor();
    // The caller's bytes are a view in the middle of a larger buffer.
    const whole = Uint8Array.of(9, 9, 1, 2, 3, 4, 9, 9);
    const input = whole.subarray(2, 6);

    const result = await compressor.compress(input);

    expect(Array.from(result)).toEqual([4, 3, 2, 1]);
    // The caller's buffer was neither detached nor changed...
    expect(whole.byteLength).toBe(8);
    expect(Array.from(whole)).toEqual([9, 9, 1, 2, 3, 4, 9, 9]);
    // ...because the worker received a transferred copy of the four bytes only.
    const worker = workerAt(workers, 0);
    expect(worker.transfers).toHaveLength(1);
    expect(worker.transfers[0]).toHaveLength(1);
    expect(worker.transfers[0]?.[0]).not.toBe(whole.buffer);
    expect(worker.received[0]?.bytes.byteLength).toBe(4);
  });
});
