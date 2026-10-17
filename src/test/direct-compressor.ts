/**
 * Test {@link Compressor}: runs the zstd codec on the calling thread.
 *
 * The desktop app compresses in a Web Worker so a large file does not freeze the window; jsdom has
 * no `Worker`, so tests use this class instead. It runs the same codec at the same level, so the
 * bytes it makes are the bytes the app makes. It does not translate the errors of the codec into
 * `AppError`s as the worker adapter does: a bad frame rejects with the codec's own `Error`.
 *
 * @packageDocumentation
 */
import type { Compressor } from '../ports/compressor.port';
import { compressBytes, decompressBytes } from '../workers/zstd-codec';

/** {@link Compressor} that calls the zstd codec directly, without a worker. */
export class DirectCompressor implements Compressor {
  /**
   * Compress bytes with zstd at level 19.
   *
   * @param bytes - The data to compress.
   * @returns The zstd frame.
   */
  compress(bytes: Uint8Array): Promise<Uint8Array> {
    return compressBytes(bytes);
  }

  /**
   * Decompress a zstd frame.
   *
   * @param bytes - The zstd frame.
   * @returns The original data.
   */
  decompress(bytes: Uint8Array): Promise<Uint8Array> {
    return decompressBytes(bytes);
  }
}
