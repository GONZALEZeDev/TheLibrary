/**
 * Compressor port: shrinks the match-detail archive files.
 *
 * The archive is zstd-compressed JSON. The port only knows bytes in and bytes out, so the
 * services and their tests do not depend on the compression library or on how it is loaded.
 *
 * Adapters do not wrap their failures (see `src/adapters/README.md`), with one exception here. The
 * Web Worker adapter of the desktop app is a boundary where errors cross as text, so only the
 * adapter can report them: every one of its failures (the worker cannot be created or reached,
 * crashes, or reports an error, which includes input that is not valid zstd) rejects with
 * `AppError('storage', …)` and keeps the original failure as the cause. The test compressor
 * (`src/test/direct-compressor.ts`) calls the library on the calling thread and lets the library's
 * errors through as they are. The service that calls the port therefore wraps what is not an
 * `AppError` yet.
 *
 * @packageDocumentation
 */

/** Compresses and decompresses archive files. */
export interface Compressor {
  /**
   * Compress bytes with zstd at level 19: archives are written once and read often, so a slower
   * write for a smaller file is the right trade.
   *
   * @param bytes - The data to compress.
   * @returns The zstd frame.
   */
  compress(bytes: Uint8Array): Promise<Uint8Array>;

  /**
   * Decompress a zstd frame made by {@link Compressor.compress}.
   *
   * @param bytes - The zstd frame.
   * @returns The original data.
   */
  decompress(bytes: Uint8Array): Promise<Uint8Array>;
}
