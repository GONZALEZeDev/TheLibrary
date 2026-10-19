/**
 * One Steam OpenID 2.0 sign-in: the loopback listener, the system browser, and Steam's own
 * confirmation of the assertion (ADR 0005, `docs/adr/0005-steam-openid-linking.md`).
 *
 * The player signs in on Steam's page, in the system browser, and Steam sends the browser back to a
 * one-shot listener on `127.0.0.1`. Any local process can reach that port, so what the listener
 * hears proves nothing: {@link SteamSignInService.signIn} only says the player is who Steam says
 * after the callback passed `validateCallback` *and* Steam answered `is_valid:true` to a
 * `check_authentication` request (which Steam answers once per assertion, so a replay fails).
 *
 * A sign-in is settled once, by whichever comes first: the first callback, `cancel()`, the
 * five-minute timeout, or a browser that could not be opened. Whatever happens later is ignored.
 * The service never rejects: every failure is an outcome, and an outcome is all the account service
 * (the only caller) needs to know.
 *
 * Privacy: the login URL and the callback URL carry the nonce, the callback and the confirmation
 * request carry the player's SteamID64, and the message of a plugin error may quote any of them. So
 * a line is logged with the step and the kind of what happened, never with an error's message, a
 * URL, a nonce or an id.
 *
 * @packageDocumentation
 */
import { REQUEST_TIMEOUT_MS, userAgent } from '../core/deadlock-api/endpoints';
import type { AccountId } from '../core/domain/account';
import { toAppError } from '../core/errors/app-error';
import { CALLBACK_PAGE_HTML } from '../core/steam/callback-page';
import { steamId64ToAccountId } from '../core/steam/steam-id';
import {
  buildCheckAuthenticationBody,
  buildSignInRequest,
  CHECK_AUTHENTICATION_MAX_BYTES,
  NONCE_BYTES,
  nonceFromBytes,
  parseCheckAuthenticationAnswer,
  SIGN_IN_TIMEOUT_MS,
  STEAM_OPENID_ENDPOINT,
  validateCallback,
  type CallbackCheck,
  type CallbackRefusal,
  type PendingSignIn,
} from '../core/steam/steam-openid';
import type { HttpClient } from '../ports/http-client.port';
import type { LogContext, Logger, LogLevel } from '../ports/logger.port';
import type { SignInGateway } from '../ports/sign-in-gateway.port';

/** Scope of every log line of this service. */
const LOG_SCOPE = 'steam';

/**
 * How a sign-in ended. Each failure has its own word because the interface tells the player what
 * to do differently: try again, try later, or nothing (they cancelled).
 *
 * - `signed_in`: Steam confirmed the player, who is the account `accountId`;
 * - `cancelled`: the player gave up in the app;
 * - `timed_out`: Steam sent nobody back within `SIGN_IN_TIMEOUT_MS`;
 * - `cancelled_on_steam`: the player cancelled on Steam's page;
 * - `refused`: the callback is not a genuine sign-in, or Steam does not confirm it;
 * - `steam_unavailable`: Steam could not be asked (unreachable, or it answered an error);
 * - `start_failed`: the listener or the browser could not be started.
 */
export type SignInOutcome =
  | { readonly kind: 'signed_in'; readonly accountId: AccountId }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'cancelled_on_steam' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'steam_unavailable' }
  | { readonly kind: 'start_failed' };

/** What {@link SteamSignInService} needs. */
export interface SteamSignInServiceDependencies {
  /** The loopback listener and the system browser. */
  readonly gateway: SignInGateway;
  /** Asks Steam to confirm the assertion. */
  readonly http: HttpClient;
  /** Structured logger. */
  readonly logger: Logger;
  /** Version of the app, sent in the User-Agent of the confirmation request. */
  readonly appVersion: string;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
  /**
   * Draws random bytes, for the nonce; `crypto.getRandomValues` by default. A test passes a fixed
   * source to know the nonce.
   */
  readonly randomBytes?: (length: number) => Uint8Array;
}

/** What a sign-in was doing when it could not start, for the log line. */
type StartStep = 'nonce' | 'listener' | 'browser';

/** A callback that {@link validateCallback} accepted. */
type AcceptedCallback = Extract<CallbackCheck, { readonly ok: true }>;

/**
 * What Steam's answer to `check_authentication` comes to:
 *
 * - `valid`: Steam confirms the assertion;
 * - `invalid`: it does not (`is_valid:false`), or what came back is not Steam's confirmation (an
 *   unexpected status, a redirect, a body over the cap). `status` is the HTTP status when there was
 *   a response: it is logged with the refusal, so a change on Steam's side (a redirect, a new
 *   status) can be told from a plain `is_valid:false`;
 * - `unavailable`: Steam could not be asked or is in trouble. `context` is what to log about it.
 */
type Confirmation =
  | { readonly verdict: 'valid' }
  | { readonly verdict: 'invalid'; readonly status?: number }
  | { readonly verdict: 'unavailable'; readonly context: LogContext };

/** The sign-in in progress. Mutated by the service only; one exists at a time. */
interface Attempt {
  /**
   * The anti-forgery value of this sign-in. It exists before the listener does, so a callback can
   * never be matched against a nonce that is not there yet.
   */
  readonly nonce: string;
  /** What `signIn()` returns: settled once, never rejected. */
  readonly outcome: Promise<SignInOutcome>;
  /** Settles {@link Attempt.outcome}. */
  readonly resolve: (outcome: SignInOutcome) => void;
  /** The sign-in as the core checks a callback against, known once the listener is up. */
  pending: PendingSignIn | null;
  /** Whether the outcome is decided: nothing but cleanup happens to the attempt after that. */
  settled: boolean;
  /**
   * Whether the first callback came: the nonce is consumed, whatever that callback turns out to be.
   * It is set synchronously inside the listener, because unsubscribing is asynchronous and a second
   * callback can still reach the listener after the first one.
   */
  callbackReceived: boolean;
  /** The timer that ends the sign-in when Steam sends nobody back; `undefined` when not running. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Removes the subscription to the callbacks; `null` before it exists and after it was used. */
  unsubscribe: (() => void) | null;
}

/** Runs one Steam sign-in at a time. */
export class SteamSignInService {
  readonly #gateway: SignInGateway;
  readonly #http: HttpClient;
  readonly #logger: Logger;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;

  /** The sign-in in progress, or `null`. It is cleared the moment its outcome is decided. */
  #attempt: Attempt | null = null;

  /**
   * @param dependencies - See {@link SteamSignInServiceDependencies}.
   */
  constructor(dependencies: SteamSignInServiceDependencies) {
    this.#gateway = dependencies.gateway;
    this.#http = dependencies.http;
    this.#logger = dependencies.logger;
    this.#userAgent = userAgent(dependencies.appVersion);
    this.#now = dependencies.now ?? Date.now;
    this.#randomBytes =
      dependencies.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  /**
   * Sign the player in with Steam.
   *
   * A call made while a sign-in is pending gets that sign-in's outcome and starts nothing: the
   * player clicking twice opens one browser tab, not two.
   *
   * @returns A promise of the outcome. It never rejects.
   */
  signIn(): Promise<SignInOutcome> {
    if (this.#attempt !== null) {
      return this.#attempt.outcome;
    }
    let nonce: string;
    try {
      nonce = nonceFromBytes(this.#randomBytes(NONCE_BYTES));
    } catch (error) {
      // A source of randomness that fails is a bug, but the service still never rejects.
      this.#logCouldNotStart('nonce', error);
      return Promise.resolve({ kind: 'start_failed' });
    }
    // The resolver is captured by the executor, which runs synchronously, so it is set below.
    let resolve: (outcome: SignInOutcome) => void = () => undefined;
    const outcome = new Promise<SignInOutcome>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const attempt: Attempt = {
      nonce,
      outcome,
      resolve,
      pending: null,
      settled: false,
      callbackReceived: false,
      timer: undefined,
      unsubscribe: null,
    };
    this.#attempt = attempt;
    void this.#run(attempt);
    return outcome;
  }

  /**
   * End the pending sign-in with `cancelled`: the player closed the dialog, or pressed Escape.
   * Nothing happens when no sign-in is pending.
   *
   * It works at every point of the sign-in, including while Steam is being asked to confirm the
   * assertion: the answer is then dropped.
   */
  cancel(): void {
    const attempt = this.#attempt;
    if (attempt === null) {
      return;
    }
    this.#log('info', 'Steam sign-in cancelled', { by: 'user' });
    this.#end(attempt, { kind: 'cancelled' });
  }

  /**
   * Tell whether a sign-in is pending, i.e. its outcome is not decided yet. The service tells
   * nobody when it changes, so a caller that must react to the end of a sign-in follows the promise
   * `signIn()` returned. An arrow function, so that it can be handed over as a plain callback.
   *
   * @returns `true` from `signIn()` until its outcome is decided.
   */
  readonly isPending = (): boolean => this.#attempt !== null;

  /**
   * Bring the sign-in up: subscribe to the callbacks, start the listener, start the timer, and open
   * the browser. What happens next is up to the callback, `cancel()` and the timer.
   *
   * Every step may find the sign-in already settled (`cancel()` does not wait for the gateway); it
   * then only undoes what the step just made. It never rejects.
   *
   * @param attempt - The sign-in.
   */
  async #run(attempt: Attempt): Promise<void> {
    // The subscription comes before the listener: no callback can arrive unheard.
    try {
      attempt.unsubscribe = await this.#gateway.onCallback((url) => {
        this.#onCallback(attempt, url);
      });
    } catch (error) {
      this.#failToStart(attempt, 'listener', error);
      return;
    }
    if (this.#hasEnded(attempt)) {
      this.#release(attempt);
      return;
    }

    let port: number;
    try {
      ({ port } = await this.#gateway.start(CALLBACK_PAGE_HTML));
    } catch (error) {
      this.#failToStart(attempt, 'listener', error);
      return;
    }
    if (this.#hasEnded(attempt)) {
      // The sign-in ended while the listener was starting, so only now is its port known, and the
      // listener is stopped whatever ended it. That includes a callback: heard before the port was
      // known, it cannot have come from this listener (it was not up), so this listener has heard
      // nothing and would stay open. It may be that of an earlier sign-in, still stopping.
      await this.#stopListener(port);
      return;
    }

    const request = buildSignInRequest(port, attempt.nonce);
    attempt.pending = { port, nonce: attempt.nonce, returnTo: request.returnTo };
    this.#log('info', 'Steam sign-in started');
    // The timer starts with the listener, before the browser: the time the player has is the time
    // the listener stays open, however long the browser takes to show the page.
    attempt.timer = setTimeout(() => {
      this.#log('info', 'Steam sign-in cancelled', { by: 'timeout' });
      this.#end(attempt, { kind: 'timed_out' });
    }, SIGN_IN_TIMEOUT_MS);
    try {
      await this.#gateway.openBrowser(request.loginUrl);
    } catch (error) {
      this.#failToStart(attempt, 'browser', error);
    }
  }

  /**
   * Receive a callback from the listener. The first one decides the sign-in, whatever it is.
   *
   * It is synchronous on purpose: the flag that consumes the nonce is set before anything else can
   * run, so a second callback that reaches this listener (unsubscribing is asynchronous) finds the
   * sign-in decided and is dropped.
   *
   * @param attempt - The sign-in this listener was subscribed for.
   * @param url - The full callback URL, or `''` when the listener could not read it.
   */
  #onCallback(attempt: Attempt, url: string): void {
    if (attempt.settled || attempt.callbackReceived) {
      return;
    }
    attempt.callbackReceived = true;
    // No further callback is wanted, and the timer would end a sign-in that is no longer waiting.
    this.#release(attempt);
    // A callback heard before the listener was up cannot be this sign-in's: no URL could have been
    // built without its port. It is refused like any callback whose URL is not the expected one.
    const check: CallbackCheck =
      attempt.pending === null
        ? { ok: false, refusal: 'url' }
        : validateCallback(url, attempt.pending, this.#now());
    if (check.ok) {
      void this.#confirm(attempt, check);
    } else {
      this.#refuse(attempt, check.refusal);
    }
  }

  /**
   * Have Steam confirm an accepted callback, then decide the sign-in. A `cancel()` that came
   * meanwhile has decided it already: the answer is dropped.
   *
   * @param attempt - The sign-in.
   * @param callback - The accepted callback: the fields to send back, and the SteamID64.
   */
  async #confirm(attempt: Attempt, callback: AcceptedCallback): Promise<void> {
    const confirmation = await this.#askSteam(callback.fields);
    if (this.#hasEnded(attempt)) {
      return;
    }
    if (confirmation.verdict === 'unavailable') {
      this.#log('warn', 'Steam could not confirm the sign-in', confirmation.context);
      this.#end(attempt, { kind: 'steam_unavailable' });
      return;
    }
    if (confirmation.verdict === 'invalid') {
      this.#refuse(attempt, 'check_authentication', confirmation.status);
      return;
    }
    let accountId: AccountId;
    try {
      accountId = steamId64ToAccountId(callback.steamId64);
    } catch {
      // Steam confirmed an id that is no individual account. The error is not logged: it is the
      // outcome that matters here, and the id must stay out of the logs.
      this.#refuse(attempt, 'claimed_id');
      return;
    }
    this.#log('info', 'Steam sign-in confirmed');
    this.#end(attempt, { kind: 'signed_in', accountId });
  }

  /**
   * Ask Steam whether it issued an assertion (`check_authentication`).
   *
   * The request goes to Steam's endpoint as written in the code, never to a URL of the callback;
   * no redirect is followed (a 3xx is returned as it is by the HTTP port); the answer is read up to
   * `CHECK_AUTHENTICATION_MAX_BYTES`. The status is read before the body: only a 200 can confirm.
   *
   * @param fields - The `openid.*` fields of the accepted callback.
   * @returns What the answer comes to. It never rejects.
   */
  async #askSteam(fields: Readonly<Record<string, string>>): Promise<Confirmation> {
    let status: number;
    let body: string;
    try {
      ({ status, body } = await this.#http.postForm({
        url: STEAM_OPENID_ENDPOINT,
        headers: { 'User-Agent': this.#userAgent },
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBodyBytes: CHECK_AUTHENTICATION_MAX_BYTES,
        form: buildCheckAuthenticationBody(fields),
      }));
    } catch (error) {
      const { kind } = toAppError(error);
      // An answer over the cap is not Steam's two short lines. Any other failure is the transport's
      // (`network`, `timeout`): the player can try again later.
      return kind === 'invalid_payload'
        ? { verdict: 'invalid' }
        : { verdict: 'unavailable', context: { kind } };
    }
    // Steam asks to wait (429), blocks the app (403) or fails (5xx): none of them is an answer
    // about this assertion, so the player is not told it was refused.
    if (status === 403 || status === 429 || status >= 500) {
      return { verdict: 'unavailable', context: { status } };
    }
    return status === 200 && parseCheckAuthenticationAnswer(body) === 'valid'
      ? { verdict: 'valid' }
      : { verdict: 'invalid', status };
  }

  /**
   * End the sign-in because a callback or Steam's answer was refused, or because the player
   * cancelled on Steam's page. Only the name of the check is logged, and the HTTP status of Steam's
   * answer when there is one: the callback holds the nonce and the player's assertion.
   *
   * @param attempt - The sign-in.
   * @param check - The check that failed.
   * @param status - The HTTP status of Steam's answer, for a refusal that comes from it. A refusal
   *   of the callback itself has none.
   */
  #refuse(
    attempt: Attempt,
    check: CallbackRefusal | 'check_authentication',
    status?: number,
  ): void {
    if (check === 'cancelled_on_steam') {
      this.#log('info', 'Steam sign-in cancelled', { by: 'steam' });
      this.#end(attempt, { kind: 'cancelled_on_steam' });
      return;
    }
    this.#log(
      'warn',
      'Steam sign-in refused',
      status === undefined ? { check } : { check, status },
    );
    this.#end(attempt, { kind: 'refused' });
  }

  /**
   * End the sign-in because the listener or the browser could not be started. Nothing is done when
   * the sign-in is decided already: a failure that comes second is not the outcome.
   *
   * @param attempt - The sign-in.
   * @param step - What was being done.
   * @param error - What the gateway threw; only its kind is logged, as its message may quote the
   *   login URL.
   */
  #failToStart(attempt: Attempt, step: 'listener' | 'browser', error: unknown): void {
    if (attempt.settled || attempt.callbackReceived) {
      return;
    }
    this.#logCouldNotStart(step, error);
    this.#end(attempt, { kind: 'start_failed' });
  }

  /**
   * Log that a sign-in could not start.
   *
   * @param step - What was being done.
   * @param error - What failed; only its kind is logged.
   */
  #logCouldNotStart(step: StartStep, error: unknown): void {
    this.#log('warn', 'Steam sign-in could not start', { step, kind: toAppError(error).kind });
  }

  /**
   * Decide the sign-in, once: free what it holds, stop the listener if it is still open, and give
   * the outcome to the caller of `signIn()`. A call on a decided sign-in does nothing.
   *
   * @param attempt - The sign-in.
   * @param outcome - How it ended.
   */
  #end(attempt: Attempt, outcome: SignInOutcome): void {
    if (attempt.settled) {
      return;
    }
    attempt.settled = true;
    this.#release(attempt);
    // The listener ends by itself after the first callback it hears, so a callback never stops it
    // here: every other end does. This sign-in's listener heard that callback only if its port was
    // known when the callback came (`pending` is set with the port). A sign-in that ends before the
    // port is known stops the listener in `#run`, when the port arrives, whatever ended it.
    if (!attempt.callbackReceived && attempt.pending !== null) {
      void this.#stopListener(attempt.pending.port);
    }
    // Cleared before the outcome is given, so a caller that signs in again at once starts afresh.
    if (this.#attempt === attempt) {
      this.#attempt = null;
    }
    attempt.resolve(outcome);
  }

  /**
   * Tell whether the outcome of a sign-in is decided. It is read through a method after an `await`,
   * because TypeScript keeps what it learnt about a property from before the `await` (a sign-in
   * seen as running stays one), though `cancel()` or a callback may have decided it meanwhile.
   *
   * @param attempt - The sign-in.
   * @returns `true` once the outcome is decided.
   */
  #hasEnded(attempt: Attempt): boolean {
    return attempt.settled;
  }

  /**
   * Stop listening to the callbacks and stop the timer. It can be called more than once.
   *
   * @param attempt - The sign-in.
   */
  #release(attempt: Attempt): void {
    clearTimeout(attempt.timer);
    attempt.timer = undefined;
    const { unsubscribe } = attempt;
    attempt.unsubscribe = null;
    try {
      unsubscribe?.();
    } catch (error) {
      // The sign-in has its outcome already: a subscription that cannot be removed changes nothing
      // for the player, and the attempt ignores what it hears anyway.
      this.#log('debug', 'Steam sign-in callbacks could not be unsubscribed', {
        kind: toAppError(error).kind,
      });
    }
  }

  /**
   * Stop the loopback listener of a sign-in that heard no callback of its own. It never rejects.
   *
   * @param port - The port of the listener.
   */
  async #stopListener(port: number): Promise<void> {
    try {
      await this.#gateway.cancel(port);
    } catch (error) {
      // A listener that ended by itself (a callback arrived at the same time) makes the plugin
      // reject: there was nothing left to stop. The player never needs to know.
      this.#log('debug', 'Steam sign-in listener could not be stopped', {
        kind: toAppError(error).kind,
      });
    }
  }

  /**
   * Write one line in this service's scope.
   *
   * @param level - Severity.
   * @param message - What happened.
   * @param context - Details. Never a URL, a nonce, an id or an error's message.
   */
  #log(level: LogLevel, message: string, context?: LogContext): void {
    this.#logger.log(level, LOG_SCOPE, message, context);
  }
}
