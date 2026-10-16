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
import { describe, expect, it } from 'vitest';
import { compressBytes, decompressBytes } from './zstd-codec';

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

  it('reads a frame made by the reference zstd', async () => {
    const frame = Uint8Array.from(atob(ORACLE_FRAME_BASE64), (char) => char.charCodeAt(0));

    const restored = await decompressBytes(frame);

    expect(new TextDecoder().decode(restored)).toBe(ORACLE_TEXT);
  });

  it('rejects bytes that are not a zstd frame', async () => {
    // The error of the library is not wrapped; the caller (the service) decides what it means.
    await expect(decompressBytes(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
