/**
 * Messages exchanged with the zstd worker, and the compression level the archive uses.
 *
 * The worker (`src/workers/zstd-codec.ts`) compresses and decompresses off the main thread: the
 * main thread posts a {@link ZstdRequest} and gets back one {@link ZstdResponse} with the same `id`.
 * The types live in `core` so both sides (the worker and the adapter that talks to it) share one
 * definition without importing each other, and without `core` importing the compression library.
 *
 * @packageDocumentation
 */

/**
 * zstd compression level of the archive. Archives are written once and read often, so the slowest
 * practical level, which gives the smallest files, is the right trade. Level 19 stays below the
 * levels 20 and above, which the library documents as needing much more memory.
 */
export const ZSTD_LEVEL = 19;

/** What a worker request asks for. */
export type ZstdOperation = 'compress' | 'decompress';

/** A request to the zstd worker. */
export interface ZstdRequest {
  /** Identifies the request: the response carries the same value, so concurrent requests pair up. */
  readonly id: number;
  /** Whether to compress `bytes` or to decompress them. */
  readonly operation: ZstdOperation;
  /** The data to compress, or the zstd frame to decompress. */
  readonly bytes: Uint8Array;
}

/**
 * Whose fault a failed request is, as the worker tells it:
 * - `data`: the codec ran and failed on the bytes of the request (a frame that is not zstd, a
 *   decoding or encoding error on the input). The worker is healthy, and the bytes are to blame;
 * - `unavailable`: everything else. The codec could not be loaded (the WebAssembly was refused or
 *   failed to start), the operation is unknown, the request is malformed, or the answer could not
 *   be posted. Nothing is known about the bytes, and the worker cannot be trusted any more.
 */
export type ZstdErrorKind = 'data' | 'unavailable';

/**
 * The answer to a {@link ZstdRequest}: the result bytes, or the message of the failure and whose
 * fault it is. The two shapes are told apart by the presence of `error`.
 */
export type ZstdResponse =
  | { readonly id: number; readonly bytes: Uint8Array }
  | { readonly id: number; readonly error: string; readonly kind: ZstdErrorKind };
