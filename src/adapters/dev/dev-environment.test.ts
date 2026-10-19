/**
 * Tests of the development environment module: its development-only marker, and the sign-in gateway
 * it creates, which needs neither a network nor a browser. The other adapters it creates are used
 * by running `pnpm dev`, since under Node sql.js cannot load its WebAssembly file from a URL.
 *
 * @packageDocumentation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSignInRequest,
  nonceFromBytes,
  validateCallback,
} from '../../core/steam/steam-openid';
import { createBrowserDevAdapters, DEV_ONLY_MARKER } from './dev-environment';
import { FixtureSignInGateway } from './fixture-sign-in-gateway.adapter';
import { FIXTURE_STEAM_ID64 } from './fixtures/steam.fixture';
import { MemoryLogger } from './memory-logger.adapter';

/** The time of the sign-in test (Unix ms): the clock is faked, since the gateway answers on a timer. */
const NOW = 1_792_154_119_000;

/** A synthetic nonce: 16 bytes, as a real sign-in draws. */
const NONCE = nonceFromBytes(new Uint8Array(16).fill(7));

afterEach(() => {
  // Puts the timers and the console back, even when an assertion failed before the end of the test.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createBrowserDevAdapters', () => {
  it('marks the browser adapters as development-only code', () => {
    // The logger mirrors its lines to the console, which a developer reads in the browser: the
    // `info` line of the marker is silenced so that the test output stays clean.
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const { logger } = createBrowserDevAdapters();

    // `scripts/check-dev-code.ts` looks for the marker in the build, so it must stay in a log line.
    expect(logger).toBeInstanceOf(MemoryLogger);
    const messages =
      logger instanceof MemoryLogger ? logger.entries.map(({ message }) => message) : [];
    expect(messages.join('\n')).toContain(DEV_ONLY_MARKER);
  });

  it('gives the browser dev mode a sign-in gateway that signs in the fixture account', async () => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { signInGateway } = createBrowserDevAdapters();
    const received: string[] = [];

    // The same steps as the sign-in: listen, start the listener, open the login page.
    await signInGateway.onCallback((url) => received.push(url));
    const { port } = await signInGateway.start('<!doctype html><p>Synthetic callback page</p>');
    const request = buildSignInRequest(port, NONCE);
    await signInGateway.openBrowser(request.loginUrl);

    expect(signInGateway).toBeInstanceOf(FixtureSignInGateway);
    // Steam answers after a short delay, so that the "waiting for Steam" state shows.
    vi.advanceTimersByTime(799);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);
    // The callback is the one the core accepts for this sign-in, for the fixture account.
    const pending = { port, nonce: NONCE, returnTo: request.returnTo };
    expect(validateCallback(received[0] ?? '', pending, NOW)).toMatchObject({
      ok: true,
      steamId64: FIXTURE_STEAM_ID64,
    });
  });
});
