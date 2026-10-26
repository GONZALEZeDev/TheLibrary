/**
 * Test {@link Compressor}: runs the zstd codec on the calling thread.
 *
 * The desktop app compresses in a Web Worker so a large file does not freeze the window; jsdom has
 * no `Worker`, so tests use this class instead. It runs the same codec, but at a fast level by
 * default: the tests archive hundreds of matches, level 19 makes them several times slower, and the
 * level changes only the size of a frame, never what it decodes to. A test that needs the very bytes
 * of the app passes the app's level, `ZSTD_LEVEL` (19). It does not translate the errors of the
 * codec into `AppError`s as the worker adapter does: a bad frame rejects with the codec's own
 * `Error`.
 *
 * @packageDocumentation
 */
import type { Compressor } from '../ports/compressor.port';
import { compressBytes, decompressBytes } from '../workers/zstd-codec';

/** The zstd level the tests compress at unless told otherwise: the fastest one. */
export const TEST_ZSTD_LEVEL = 1;

/** {@link Compressor} that calls the zstd codec directly, without a worker. */
export class DirectCompressor implements Compressor {
  /** The zstd level of the frames this compressor makes. */
  readonly #level: number;

  /**
   * @param level - The zstd level to compress at: {@link TEST_ZSTD_LEVEL} by default, or
   *   `ZSTD_LEVEL` (19) for the app's own bytes.
   */
  constructor(level: number = TEST_ZSTD_LEVEL) {
    this.#level = level;
  }

  /**
   * Compress bytes with zstd at the level of this compressor.
   *
   * @param bytes - The data to compress.
   * @returns The zstd frame.
   */
  compress(bytes: Uint8Array): Promise<Uint8Array> {
    return compressBytes(bytes, this.#level);
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
