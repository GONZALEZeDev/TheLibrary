/**
 * The zstd codec of the archive: compresses at level 19 and decompresses, with the WebAssembly
 * build of zstd.
 *
 * This module is the compression itself, free of any worker plumbing: the worker entry point
 * wraps these two functions behind messages (see `core/compression/zstd-protocol.ts`), and tests
 * call them directly because jsdom has no `Worker`. The WebAssembly module is embedded in the
 * library's JavaScript, so loading it fetches no file and needs no asset in the build; the
 * Content-Security-Policy allows it through `'wasm-unsafe-eval'`.
 *
 * @packageDocumentation
 */
import { Zstd } from '@hpcc-js/wasm-zstd';
import { ZSTD_LEVEL, type ZstdErrorKind } from '../core/compression/zstd-protocol';

/**
 * The codec could not be loaded: the WebAssembly was refused or failed to start. The bytes were
 * never read, so this says nothing about them. The library keeps a failed load for the life of the
 * worker, so the worker cannot recover: the page stops it and starts another one.
 */
export class ZstdLoadError extends Error {
  /** @param cause - The error of the library, kept for the logs. */
  constructor(cause: unknown) {
    super(`The zstd codec could not be loaded: ${messageOf(cause)}`, { cause });
    this.name = 'ZstdLoadError';
  }
}

/**
 * The codec ran and failed on the bytes it was given: they are not a zstd frame, or they could not
 * be encoded or decoded. The worker is healthy; the bytes are to blame.
 */
export class ZstdDataError extends Error {
  /** @param cause - The error of the library, kept for the logs. Its message is this one's. */
  constructor(cause: unknown) {
    super(messageOf(cause), { cause });
    this.name = 'ZstdDataError';
  }
}

/**
 * The message of anything that was thrown.
 *
 * @param thrown - An `Error`, or whatever else the library threw.
 * @returns Its message, or its text.
 */
function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The library once it is loaded. It is started on the first call, not when the module is
 * imported, so importing the codec costs nothing until a file is compressed. Every call shares
 * this one promise, so the WebAssembly module is compiled once.
 */
let zstd: Promise<Zstd> | undefined;

/**
 * Load the library on the first call and reuse it afterwards. A failed load is kept too (as the
 * library itself keeps it): there is no point in trying again in the same worker.
 *
 * @returns The loaded library.
 * @throws {@link ZstdLoadError} when the library cannot be loaded.
 */
function loadZstd(): Promise<Zstd> {
  zstd ??= Zstd.load().catch((error: unknown) => {
    throw new ZstdLoadError(error);
  });
  return zstd;
}

/**
 * Compress bytes into one zstd frame, at level 19 unless told otherwise.
 *
 * Uses the library's one-shot call: the whole input is in memory and the frame comes back in one
 * piece, which suits an archive file of a few hundred kilobytes.
 *
 * @param bytes - The data to compress.
 * @param level - The zstd level. The app always uses {@link ZSTD_LEVEL}; tests that write many
 *   archives pass a faster one, since the level changes only the size of the frame, never what it
 *   decodes to.
 * @returns The zstd frame.
 * @throws {@link ZstdLoadError} when the library cannot be loaded, {@link ZstdDataError} when it
 *   fails on `bytes`.
 */
export async function compressBytes(
  bytes: Uint8Array,
  level: number = ZSTD_LEVEL,
): Promise<Uint8Array> {
  const library = await loadZstd();
  try {
    return library.compress(bytes, level);
  } catch (error) {
    throw new ZstdDataError(error);
  }
}

/**
 * Decompress one zstd frame, whatever level made it.
 *
 * @param bytes - The zstd frame.
 * @returns The original data.
 * @throws {@link ZstdLoadError} when the library cannot be loaded, {@link ZstdDataError} when
 *   `bytes` is not a valid zstd frame (the library's error is its cause).
 */
export async function decompressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const library = await loadZstd();
  try {
    return library.decompress(bytes);
  } catch (error) {
    throw new ZstdDataError(error);
  }
}

/**
 * Turn a failure of a request into the answer of the worker: the message, and whose fault it is.
 *
 * Only a {@link ZstdDataError} is about the bytes. Everything else is `unavailable`: the codec
 * could not be loaded ({@link ZstdLoadError}), and the failures of the worker itself (an unknown
 * operation, a malformed request, a result that cannot be posted). The message is the error's own,
 * never the data.
 *
 * @param error - What the request threw.
 * @returns The message and the kind to answer with.
 */
export function describeFailure(error: unknown): { error: string; kind: ZstdErrorKind } {
  return {
    error: messageOf(error),
    kind: error instanceof ZstdDataError ? 'data' : 'unavailable',
  };
}
