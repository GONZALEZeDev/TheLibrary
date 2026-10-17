/**
 * Compressor port: shrinks the match-detail archive files.
 *
 * The archive is zstd-compressed JSON. The port only knows bytes in and bytes out, so the
 * services and their tests do not depend on the compression library or on how it is loaded.
 *
 * Adapters do not wrap their failures (see `src/adapters/README.md`), with one exception here. The
 * Web Worker adapter of the desktop app is a boundary where errors cross as text, so only the
 * adapter can classify them, and it keeps the original failure as the cause.
 * - A problem of the data rejects with `AppError('invalid_payload', …)`: the worker answered that
 *   the codec ran and failed on the bytes it got, for example input that is not valid zstd.
 * - A broken compressor rejects with `AppError('storage', …)`, and says nothing about the data: the
 *   worker cannot be created or reached, it crashes, or it answers that it is unavailable (its
 *   codec could not be loaded, for example because the WebAssembly was refused). After a crash or
 *   such an answer, the adapter replaces the worker, so the next call can succeed.
 *
 * The test compressor (`src/test/direct-compressor.ts`) calls the codec on the calling thread and
 * lets its own errors through, plain `Error`s that are not `AppError`s, so a caller must treat an
 * error that is not an `AppError` as a problem of the data, and wrap it.
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
