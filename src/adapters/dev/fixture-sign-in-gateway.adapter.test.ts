/**
 * Tests of the fixture sign-in gateway. A callback it delivers is checked with the real
 * `validateCallback`, so the gateway is proven to play Steam's part in a way the core accepts.
 *
 * The timers are faked: the gateway answers through `setTimeout`, and a test must never leave a
 * real one running after it ends.
 *
 * @packageDocumentation
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountIdToSteamId64 } from '../../core/steam/steam-id';
import {
  buildSignInRequest,
  nonceFromBytes,
  validateCallback,
  type PendingSignIn,
} from '../../core/steam/steam-openid';
import { testAccountId } from '../../test/test-data';
import {
  FIXTURE_LOOPBACK_PORT,
  FixtureSignInGateway,
  type FixtureSignInGatewayOptions,
} from './fixture-sign-in-gateway.adapter';
import { createSteamCallbackUrl, FIXTURE_STEAM_ID64 } from './fixtures/steam.fixture';

/** A synthetic callback page. */
const CALLBACK_PAGE = '<!doctype html><p>Synthetic callback page</p>';

/** The time of the tests (Unix ms), the one the gateway's clock gives. */
const NOW = 1_792_154_119_000;

/** A synthetic nonce: 16 bytes, as a real sign-in draws. */
const NONCE = nonceFromBytes(new Uint8Array(16).fill(7));

/** Another synthetic player than the fixture one. */
const OTHER_STEAM_ID64 = accountIdToSteamId64(testAccountId(2000001));

/**
 * Subscribe a collector to a gateway and start its listener.
 *
 * @param options - Options of the gateway.
 * @returns The gateway, the sign-in in progress as the core knows it, the login URL to open, and
 *   the callbacks received so far.
 */
async function startSignIn(options: FixtureSignInGatewayOptions = {}): Promise<{
  readonly gateway: FixtureSignInGateway;
  readonly pending: PendingSignIn;
  readonly loginUrl: string;
  readonly received: string[];
}> {
  const gateway = new FixtureSignInGateway({ now: () => NOW, ...options });
  const received: string[] = [];
  await gateway.onCallback((url) => received.push(url));
  const { port } = await gateway.start(CALLBACK_PAGE);
  const request = buildSignInRequest(port, NONCE);
  return {
    gateway,
    pending: { port, nonce: NONCE, returnTo: request.returnTo },
    loginUrl: request.loginUrl,
    received,
  };
}

describe('FixtureSignInGateway', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drops every timer a test left pending, so none outlives it.
    vi.useRealTimers();
  });

  it('starts on its fixed port and keeps the callback page', async () => {
    const gateway = new FixtureSignInGateway();
    expect(gateway.lastCallbackPage).toBeNull();

    await expect(gateway.start(CALLBACK_PAGE)).resolves.toEqual({ port: FIXTURE_LOOPBACK_PORT });

    expect(gateway.lastCallbackPage).toBe(CALLBACK_PAGE);
  });

  it('answers like Steam after the browser opens', async () => {
    const { gateway, pending, loginUrl, received } = await startSignIn();

    await gateway.openBrowser(loginUrl);
    expect(gateway.openedUrls).toEqual([loginUrl]);
    vi.advanceTimersByTime(0);

    expect(received).toHaveLength(1);
    // The callback is the one the core accepts for this sign-in, for the fixture player.
    const check = validateCallback(received[0] ?? '', pending, NOW);
    expect(check).toMatchObject({ ok: true, steamId64: FIXTURE_STEAM_ID64 });
  });

  it('answers only once the delay has passed', async () => {
    const { gateway, loginUrl, received } = await startSignIn({ delayMs: 1_500 });

    await gateway.openBrowser(loginUrl);
    vi.advanceTimersByTime(1_499);
    expect(received).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);
  });

  it('waits to be told when it does not answer by itself', async () => {
    const { gateway, pending, loginUrl, received } = await startSignIn({ autoAnswer: false });

    await gateway.openBrowser(loginUrl);
    vi.advanceTimersByTime(60_000);
    expect(gateway.openedUrls).toEqual([loginUrl]);
    expect(received).toEqual([]);

    // The test plays the part of the browser, and of the listener that got an unreadable URL.
    const callback = createSteamCallbackUrl(loginUrl, { steamId64: FIXTURE_STEAM_ID64, now: NOW });
    gateway.deliver(callback);
    gateway.deliver('');

    // Delivered synchronously, as the plugin's event would be, and untouched.
    expect(received).toEqual([callback, '']);
    expect(validateCallback(callback, pending, NOW).ok).toBe(true);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const gateway = new FixtureSignInGateway({ autoAnswer: false });
    const received: string[] = [];
    const stopListening = await gateway.onCallback((url) => received.push(url));

    gateway.deliver('first');
    stopListening();
    gateway.deliver('second');

    expect(received).toEqual(['first']);
  });

  it('records the cancelled listeners', async () => {
    const gateway = new FixtureSignInGateway();
    const { port } = await gateway.start(CALLBACK_PAGE);

    await gateway.cancel(port);

    expect(gateway.cancelledPorts).toEqual([port]);
  });

  it('gives no answer to a listener that was cancelled', async () => {
    const { gateway, loginUrl, received } = await startSignIn({ delayMs: 1_000 });

    await gateway.openBrowser(loginUrl);
    await gateway.cancel(FIXTURE_LOOPBACK_PORT);
    vi.advanceTimersByTime(10_000);

    // A closed listener hears nothing from the browser, whatever the browser is still doing.
    expect(received).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails the next start or browser opening when asked', async () => {
    const { gateway, loginUrl, received } = await startSignIn();
    const startFailure = new Error('synthetic start failure');
    const openFailure = new Error('synthetic open failure');

    gateway.failNextStart(startFailure);
    await expect(gateway.start('<p>second page</p>')).rejects.toBe(startFailure);
    // A listener that did not start answers nothing: the page stays the one of the first start.
    expect(gateway.lastCallbackPage).toBe(CALLBACK_PAGE);
    await expect(gateway.start('<p>third page</p>')).resolves.toEqual({
      port: FIXTURE_LOOPBACK_PORT,
    });
    expect(gateway.lastCallbackPage).toBe('<p>third page</p>');

    gateway.failNextOpen(openFailure);
    await expect(gateway.openBrowser(loginUrl)).rejects.toBe(openFailure);
    // A browser that did not open shows nothing, so Steam answers nothing.
    vi.advanceTimersByTime(0);
    expect(gateway.openedUrls).toEqual([]);
    expect(received).toEqual([]);

    // Each failure is for one call only.
    await gateway.openBrowser(loginUrl);
    vi.advanceTimersByTime(0);
    expect(gateway.openedUrls).toEqual([loginUrl]);
    expect(received).toHaveLength(1);
  });

  it('signs in the account it is told', async () => {
    const { gateway, pending, loginUrl, received } = await startSignIn();

    gateway.setSteamId64(OTHER_STEAM_ID64);
    await gateway.openBrowser(loginUrl);
    vi.advanceTimersByTime(0);

    const check = validateCallback(received[0] ?? '', pending, NOW);
    expect(check).toMatchObject({ ok: true, steamId64: OTHER_STEAM_ID64 });
  });

  it('is told the account at construction too', async () => {
    const { gateway, pending, loginUrl, received } = await startSignIn({
      steamId64: OTHER_STEAM_ID64,
    });

    await gateway.openBrowser(loginUrl);
    vi.advanceTimersByTime(0);

    expect(validateCallback(received[0] ?? '', pending, NOW)).toMatchObject({
      ok: true,
      steamId64: OTHER_STEAM_ID64,
    });
  });
});
