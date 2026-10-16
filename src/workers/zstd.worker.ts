/**
 * Entry point of the zstd Web Worker: compresses and decompresses off the main thread.
 *
 * The page posts a {@link ZstdRequest}; the worker runs the codec (`./zstd-codec`) and posts back
 * the {@link ZstdResponse} with the same `id`. Every request that has an `id` gets an answer: the
 * result bytes, or `{ id, error }` when anything goes wrong (the codec throws, the operation is
 * unknown, the result cannot be posted). The page has no timeout, so an unanswered request would
 * leave its caller waiting forever. Compressing a large file at level 19 takes long enough to
 * freeze the window, which is why this runs in a worker. The adapter that starts it is
 * `adapters/browser/worker-compressor.adapter.ts`; it names this file in a
 * `new Worker(new URL(…))` expression, which is how Vite finds and bundles the worker.
 *
 * @packageDocumentation
 */
import type { ZstdRequest, ZstdResponse } from '../core/compression/zstd-protocol';
import { compressBytes, decompressBytes } from './zstd-codec';

/**
 * The part of the worker scope this file uses. The application is type-checked with the DOM
 * library, not the WebWorker one (the two clash if both are loaded), so the scope is described
 * here instead of being typed with `DedicatedWorkerGlobalScope`.
 */
interface ZstdWorkerScope {
  /**
   * Receive the requests of the page. The data is typed `unknown` on purpose: it comes from
   * outside this file, so the handler checks what it reads instead of trusting the declared type.
   */
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  /** Answer the page, handing over (not copying) the buffers of `transfer`. */
  postMessage(message: ZstdResponse, transfer: Transferable[]): void;
}

/** The scope of this worker: `self` is the global object of a worker. */
const scope = self as unknown as ZstdWorkerScope;

/**
 * Read the id of a request.
 *
 * @param data - What the page posted.
 * @returns The id, or `null` when `data` carries none that the page could match to a call.
 */
function readRequestId(data: unknown): number | null {
  if (typeof data === 'object' && data !== null && 'id' in data && Number.isSafeInteger(data.id)) {
    return data.id as number;
  }
  return null;
}

/**
 * Run one operation of the codec.
 *
 * @param operation - What to do: `compress` or `decompress`. Anything else is an error, never a
 *   guess: a mistyped or future operation must not be run as a decompression.
 * @param bytes - The data to compress, or the zstd frame to decompress.
 * @returns The result bytes.
 */
function runCodec(operation: string, bytes: Uint8Array): Promise<Uint8Array> {
  switch (operation) {
    case 'compress':
      return compressBytes(bytes);
    case 'decompress':
      return decompressBytes(bytes);
    default:
      return Promise.reject(new Error(`Unknown operation: ${operation}`));
  }
}

/**
 * Post an answer to the page, handing over the result buffer instead of copying it. The codec
 * returns a fresh array that owns its whole buffer (it copies out of the WebAssembly memory), so
 * nothing else uses that buffer.
 *
 * @param response - The answer.
 */
function postResponse(response: ZstdResponse): void {
  scope.postMessage(response, 'bytes' in response ? [response.bytes.buffer] : []);
}

/**
 * Answer one request. Never throws and never rejects: every failure becomes an `{ id, error }`
 * answer, so the page is never left waiting.
 *
 * @param data - What the page posted, which is not trusted to be a well-formed request.
 */
async function handle(data: unknown): Promise<void> {
  const id = readRequestId(data);
  if (id === null) {
    // Nothing to answer to: the page matches an answer to its call by `id`, and an answer without
    // one would match nothing. The adapter always sends an id, so this is not a request of the app.
    return;
  }
  try {
    // Read inside the `try`: a request that lacks the fields is answered with an error, not lost.
    const { operation, bytes } = data as ZstdRequest;
    postResponse({ id, bytes: await runCodec(operation, bytes) });
  } catch (error) {
    // The failure may come from posting the result (a result that cannot be cloned), so the
    // answer is a new, plain message: a number and a string, which can always be posted.
    try {
      postResponse({ id, error: error instanceof Error ? error.message : String(error) });
    } catch {
      // Only a worker scope that is itself broken gets here, and no answer can be posted from it;
      // there is nothing left to try, and a rejection nobody handles would only add noise.
    }
  }
}

scope.addEventListener('message', (event) => {
  // `handle` never rejects, so there is nothing to catch here.
  void handle(event.data);
});
