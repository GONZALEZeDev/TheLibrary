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
import { ZSTD_LEVEL } from '../core/compression/zstd-protocol';

/**
 * The library once it is loaded. It is started on the first call, not when the module is
 * imported, so importing the codec costs nothing until a file is compressed. Every call shares
 * this one promise, so the WebAssembly module is compiled once.
 */
let zstd: Promise<Zstd> | undefined;

/**
 * Load the library on the first call and reuse it afterwards.
 *
 * @returns The loaded library.
 */
function loadZstd(): Promise<Zstd> {
  zstd ??= Zstd.load();
  return zstd;
}

/**
 * Compress bytes into one zstd frame at level 19.
 *
 * Uses the library's one-shot call: the whole input is in memory and the frame comes back in one
 * piece, which suits an archive file of a few hundred kilobytes.
 *
 * @param bytes - The data to compress.
 * @returns The zstd frame.
 */
export async function compressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return (await loadZstd()).compress(bytes, ZSTD_LEVEL);
}

/**
 * Decompress one zstd frame, whatever level made it.
 *
 * @param bytes - The zstd frame.
 * @returns The original data.
 * @throws When `bytes` is not a valid zstd frame (the library's error is not wrapped).
 */
export async function decompressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return (await loadZstd()).decompress(bytes);
}
