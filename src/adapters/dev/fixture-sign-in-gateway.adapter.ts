/**
 * {@link SignInGateway} that starts no listener and opens no browser, for tests and the browser
 * dev mode.
 *
 * It plays two parts at once. As the loopback listener, it keeps the callback page it was given and
 * hands the callbacks it is told to the subscribed listeners. As the system browser, it records the
 * URLs it was asked to open and, unless told otherwise, plays Steam's part: the player signs in on
 * the spot, and the callback of the fixture account is delivered after a delay
 * (`createSteamCallbackUrl`). A test can instead switch the answer off and deliver any callback it
 * wants, forged or unreadable, with {@link FixtureSignInGateway.deliver}.
 *
 * It has no logger: the dev environment already announces itself in the console, and in the tests a
 * quiet gateway keeps the output pristine.
 *
 * @packageDocumentation
 */
import type { SignInGateway } from '../../ports/sign-in-gateway.port';
import { createSteamCallbackUrl, FIXTURE_STEAM_ID64 } from './fixtures/steam.fixture';

/** The port the fake listener reports, in the range the system gives to short-lived ports. */
export const FIXTURE_LOOPBACK_PORT = 49152;

/** Options of {@link FixtureSignInGateway}. */
export interface FixtureSignInGatewayOptions {
  /**
   * Time between the opening of the browser and the answer, in milliseconds, so the browser dev mode
   * shows the "waiting for Steam" state. Defaults to 0.
   */
  readonly delayMs?: number;
  /**
   * Whether opening the browser makes Steam answer by itself. Defaults to `true`. A test that wants
   * to deliver its own callback turns it off.
   */
  readonly autoAnswer?: boolean;
  /** The clock that dates the assertion Steam gives (Unix ms). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** The SteamID64 of the player who signs in. Defaults to the fixture account's. */
  readonly steamId64?: string;
}

/** {@link SignInGateway} whose listener and browser are simulated in memory. */
export class FixtureSignInGateway implements SignInGateway {
  /**
   * Every URL the browser was asked to open, oldest first. A failed opening
   * ({@link FixtureSignInGateway.failNextOpen}) is not recorded: nothing was opened.
   */
  readonly openedUrls: readonly string[];

  /** Every port {@link FixtureSignInGateway.cancel} was called with, oldest first. */
  readonly cancelledPorts: readonly number[];

  /** The same arrays as the public ones, typed as writable for this class only. */
  readonly #opened: string[] = [];
  readonly #cancelled: number[] = [];

  /** Who is subscribed to the callbacks. */
  readonly #listeners = new Set<(url: string) => void>();

  /** The answers still waiting for their delay: dropped when the listener is cancelled. */
  readonly #pendingAnswers = new Set<ReturnType<typeof setTimeout>>();

  readonly #delayMs: number;
  readonly #autoAnswer: boolean;
  readonly #now: () => number;
  #steamId64: string;

  /** The page of the last listener started, or `null` before the first start. */
  #callbackPage: string | null = null;

  /** The failure the next {@link FixtureSignInGateway.start} throws instead of starting. */
  #nextStartError: Error | null = null;

  /** The failure the next {@link FixtureSignInGateway.openBrowser} throws instead of opening. */
  #nextOpenError: Error | null = null;

  /** The failure the next {@link FixtureSignInGateway.cancel} rejects with, once it is recorded. */
  #nextCancelError: Error | null = null;

  /**
   * @param options - See {@link FixtureSignInGatewayOptions}.
   */
  constructor(options: FixtureSignInGatewayOptions = {}) {
    this.openedUrls = this.#opened;
    this.cancelledPorts = this.#cancelled;
    this.#delayMs = options.delayMs ?? 0;
    this.#autoAnswer = options.autoAnswer ?? true;
    this.#now = options.now ?? Date.now;
    this.#steamId64 = options.steamId64 ?? FIXTURE_STEAM_ID64;
  }

  /**
   * The page the last started listener answers with.
   *
   * @returns The page, or `null` before the first successful start.
   */
  get lastCallbackPage(): string | null {
    return this.#callbackPage;
  }

  /**
   * Keep the callback page and report the fixed port.
   *
   * @param callbackPage - The HTML the listener would answer every request with.
   * @returns The port, always {@link FIXTURE_LOOPBACK_PORT}.
   * @throws The error given to {@link FixtureSignInGateway.failNextStart}, once, when one is queued.
   */
  start(callbackPage: string): Promise<{ readonly port: number }> {
    if (this.#nextStartError !== null) {
      const error = this.#nextStartError;
      this.#nextStartError = null;
      return Promise.reject(error);
    }
    this.#callbackPage = callbackPage;
    return Promise.resolve({ port: FIXTURE_LOOPBACK_PORT });
  }

  /**
   * Subscribe to the callbacks.
   *
   * @param listener - Called with each callback URL delivered, or with `''` for an unreadable one.
   * @returns A function that stops the subscription.
   */
  onCallback(listener: (url: string) => void): Promise<() => void> {
    this.#listeners.add(listener);
    return Promise.resolve(() => {
      this.#listeners.delete(listener);
    });
  }

  /**
   * Record the cancelled listener and drop the answers still waiting for their delay: a closed
   * listener hears nothing from the browser any more.
   *
   * The real listener rejects a cancel once it has ended by itself; this one accepts it always,
   * unless {@link FixtureSignInGateway.failNextCancel} queued a failure.
   *
   * @param port - The port to stop.
   * @returns A promise resolved at once.
   * @throws The error given to {@link FixtureSignInGateway.failNextCancel}, once, when one is
   *   queued. The cancel is recorded all the same: it was asked for.
   */
  cancel(port: number): Promise<void> {
    this.#cancelled.push(port);
    for (const timer of this.#pendingAnswers) {
      clearTimeout(timer);
    }
    this.#pendingAnswers.clear();
    if (this.#nextCancelError !== null) {
      const error = this.#nextCancelError;
      this.#nextCancelError = null;
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  /**
   * Record the URL and, unless the answer is switched off, play Steam's part: the callback of the
   * signed-in player is delivered after the delay.
   *
   * The callback is built now, not when the delay ends: a login URL that is not Steam's rejects
   * this call, instead of throwing later from a timer where nothing could catch it. For the same
   * reason the player and the time of the assertion are those of the opening.
   *
   * @param url - The URL to open, here the login URL.
   * @returns A promise resolved once the URL is recorded.
   * @throws The error given to {@link FixtureSignInGateway.failNextOpen}, once, when one is queued;
   *   an `Error` when the answer is on and `url` carries no `openid.return_to`.
   */
  openBrowser(url: string): Promise<void> {
    if (this.#nextOpenError !== null) {
      const error = this.#nextOpenError;
      this.#nextOpenError = null;
      return Promise.reject(error);
    }
    let callbackUrl: string | null = null;
    if (this.#autoAnswer) {
      try {
        callbackUrl = createSteamCallbackUrl(url, {
          steamId64: this.#steamId64,
          now: this.#now(),
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.#opened.push(url);
    if (callbackUrl !== null) {
      this.#deliverLater(callbackUrl);
    }
    return Promise.resolve();
  }

  /**
   * Hand a callback URL to the subscribed listeners, synchronously, as the plugin's event would.
   * Nothing is checked: a test delivers forged and unreadable (`''`) URLs on purpose.
   *
   * @param url - The callback URL.
   */
  deliver(url: string): void {
    // A copy, so a listener that unsubscribes while it is told does not skip the next one.
    for (const listener of [...this.#listeners]) {
      listener(url);
    }
  }

  /**
   * Make the next {@link FixtureSignInGateway.start} fail with `error`, once.
   *
   * @param error - The failure to throw.
   */
  failNextStart(error: Error): void {
    this.#nextStartError = error;
  }

  /**
   * Make the next {@link FixtureSignInGateway.openBrowser} fail with `error`, once.
   *
   * @param error - The failure to throw.
   */
  failNextOpen(error: Error): void {
    this.#nextOpenError = error;
  }

  /**
   * Make the next {@link FixtureSignInGateway.cancel} reject with `error`, once: the way the real
   * listener answers a cancel after it ended by itself.
   *
   * @param error - The failure to reject with.
   */
  failNextCancel(error: Error): void {
    this.#nextCancelError = error;
  }

  /**
   * Change the player the simulated Steam signs in, for the browser openings that follow.
   *
   * @param steamId64 - The SteamID64 of the player.
   */
  setSteamId64(steamId64: string): void {
    this.#steamId64 = steamId64;
  }

  /**
   * Hand a callback to the listeners once the delay has passed. The timer is tracked while it is
   * pending, so that {@link FixtureSignInGateway.cancel} can drop it.
   *
   * @param url - The callback URL.
   */
  #deliverLater(url: string): void {
    const timer = setTimeout(() => {
      this.#pendingAnswers.delete(timer);
      this.deliver(url);
    }, this.#delayMs);
    this.#pendingAnswers.add(timer);
  }
}
