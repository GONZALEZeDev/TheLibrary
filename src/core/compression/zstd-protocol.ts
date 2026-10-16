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
 * The answer to a {@link ZstdRequest}: the result bytes, or the message of the failure. The two
 * shapes are told apart by the presence of `error`.
 */
export type ZstdResponse =
  | { readonly id: number; readonly bytes: Uint8Array }
  | { readonly id: number; readonly error: string };
