/**
 * Tests of the zstd codec: the compression the archive uses, run directly (jsdom has no `Worker`).
 *
 * Bytes are compared by content, as decoded text or as lengths, never with `instanceof` nor on the
 * typed arrays themselves: under jsdom a `Uint8Array` made by a Node API is not an `instanceof`
 * the one of the test realm, so such a comparison would be unreliable.
 *
 * @packageDocumentation
 */
import { Zstd } from '@hpcc-js/wasm-zstd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compressBytes,
  decompressBytes,
  describeFailure,
  ZstdDataError,
  ZstdLoadError,
} from './zstd-codec';

/**
 * Synthetic JSON document of about 200 KB: a list of match-like records with repeated keys and
 * varied numbers, the shape of data the archive compresses. Deterministic, so every run compresses
 * the same bytes.
 */
function syntheticDocument(): string {
  const records = Array.from({ length: 260 }, (_, index) => ({
    matchId: 100_000_000 + index,
    startTime: 1_790_000_000 + index * 2_117,
    durationS: 1_200 + ((index * 37) % 1_500),
    players: Array.from({ length: 12 }, (_, slot) => ({
      slot,
      heroId: 1 + ((index + slot * 7) % 40),
      kills: (index * (slot + 3)) % 17,
      deaths: (index + slot) % 11,
      netWorth: 15_000 + ((index * 131 + slot * 977) % 30_000),
    })),
  }));
  return JSON.stringify({ matches: records });
}

/** A short text and the zstd frame the reference zstd implementation made of it. */
const ORACLE_TEXT = 'Paige keeps her book of souls: every match is read once and archived forever.';
// Made once with Node's `zlib.zstdCompressSync(Buffer.from(ORACLE_TEXT))`, outside the repository:
// an independent oracle, so a codec that only agrees with itself cannot pass.
const ORACLE_FRAME_BASE64 =
  'KLUv/SBNLQIA0kQQF6Cl6QDI/3f53X4fIUtCmr38hS+//fcaA3YVz1y60CFoF2WXqLtY8UQfMrDABezqRAIIl5s73Rljzylo0z2QFQEA';

describe('zstd codec', () => {
  it('round-trips a document', async () => {
    const json = syntheticDocument();
    const original = new TextEncoder().encode(json);
    // The document is the size of a real archive, not a toy.
    expect(original.length).toBeGreaterThan(200_000);

    const compressed = await compressBytes(original);
    const restored = await decompressBytes(compressed);

    expect(compressed.length).toBeLessThan(original.length);
    expect(new TextDecoder().decode(restored)).toBe(json);
  });

  it('compresses at level 19', async () => {
    const original = new TextEncoder().encode(syntheticDocument());

    const compressed = await compressBytes(original);
    const zstd = await Zstd.load();

    // Equality, not just "smaller": every level up to 17 gives another size on this document (18 to
    // 22 happen to give the same frame as 19), so a lowered level fails.
    expect(compressed.length).toBe(zstd.compress(original, 19).length);
    // Sanity check of the comparison: the library's default level 3 gives a larger frame.
    expect(compressed.length).toBeLessThan(zstd.compress(original, 3).length);
  });

  it('compresses at the level it is given, into a frame that decodes the same', async () => {
    const json = syntheticDocument();
    const original = new TextEncoder().encode(json);

    const compressed = await compressBytes(original, 1);
    const zstd = await Zstd.load();

    expect(compressed.length).toBe(zstd.compress(original, 1).length);
    expect(compressed.length).not.toBe(zstd.compress(original, 19).length);
    expect(new TextDecoder().decode(await decompressBytes(compressed))).toBe(json);
  });

  it('reads a frame made by the reference zstd', async () => {
    const frame = Uint8Array.from(atob(ORACLE_FRAME_BASE64), (char) => char.charCodeAt(0));

    const restored = await decompressBytes(frame);

    expect(new TextDecoder().decode(restored)).toBe(ORACLE_TEXT);
  });

  it('rejects bytes that are not a zstd frame with an error about the data', async () => {
    const failure = await decompressBytes(new Uint8Array([1, 2, 3])).then(
      () => null,
      (reason: unknown) => reason,
    );

    // The error of the library is kept as the cause of the error of the codec.
    expect(failure).toBeInstanceOf(ZstdDataError);
    expect(failure).not.toBeInstanceOf(ZstdLoadError);
    expect((failure as ZstdDataError).cause).toBeInstanceOf(Error);
    expect((failure as ZstdDataError).message).toBe(
      ((failure as ZstdDataError).cause as Error).message,
    );
  });
});

describe('describeFailure', () => {
  it('tells a failure of the codec on the bytes from one that is about the worker', async () => {
    const dataFailure = await decompressBytes(new Uint8Array([1, 2, 3])).then(
      () => null,
      (reason: unknown) => reason,
    );

    // The message is the one of the library, the one the log needs.
    expect(describeFailure(dataFailure)).toEqual({
      error: (dataFailure as Error).message,
      kind: 'data',
    });
  });

  it.each([
    ['a codec that cannot be loaded', () => new ZstdLoadError(new Error('blocked'))],
    ['an operation the worker does not know', () => new Error('Unknown operation: reverse')],
    ['a request without bytes', () => new TypeError('The request holds no bytes')],
  ])('says the worker is unavailable on %s', (_name, makeFailure) => {
    const failure = makeFailure();

    expect(describeFailure(failure)).toEqual({ error: failure.message, kind: 'unavailable' });
  });

  it('says the worker is unavailable on a failure that is not an error', () => {
    expect(describeFailure('out of memory')).toEqual({
      error: 'out of memory',
      kind: 'unavailable',
    });
  });
});

describe('zstd codec when the library cannot be loaded', () => {
  afterEach(() => {
    vi.doUnmock('@hpcc-js/wasm-zstd');
    vi.resetModules();
  });

  it('reports the failure to load as a load error, for both operations, never as a data error', async () => {
    // A fresh copy of the codec, on a library whose WebAssembly cannot be instantiated: the codec
    // keeps the library it loaded for the whole life of the module, so the other tests' codec
    // (loaded already) cannot be used.
    vi.resetModules();
    vi.doMock('@hpcc-js/wasm-zstd', () => ({
      Zstd: { load: () => Promise.reject(new Error('WebAssembly.instantiate() was blocked')) },
    }));
    const codec = await import('./zstd-codec');

    const compression = await codec.compressBytes(Uint8Array.of(1, 2, 3)).then(
      () => null,
      (reason: unknown) => reason,
    );
    const decompression = await codec.decompressBytes(Uint8Array.of(1, 2, 3)).then(
      () => null,
      (reason: unknown) => reason,
    );

    for (const failure of [compression, decompression]) {
      expect(failure).toBeInstanceOf(codec.ZstdLoadError);
      expect(failure).not.toBeInstanceOf(codec.ZstdDataError);
      expect((failure as Error).cause).toMatchObject({
        message: 'WebAssembly.instantiate() was blocked',
      });
      // The worker would answer "unavailable" for it: the bytes were never read.
      expect(codec.describeFailure(failure)).toMatchObject({ kind: 'unavailable' });
      expect(codec.describeFailure(failure).error).toContain(
        'WebAssembly.instantiate() was blocked',
      );
    }
  });
});
