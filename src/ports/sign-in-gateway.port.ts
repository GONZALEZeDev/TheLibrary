/**
 * Sign-in gateway port: the two things the Steam sign-in needs from the machine.
 *
 * Steam signs the player in on its own page, in the system browser, then sends the browser back to
 * a one-shot HTTP listener on the loopback address. The gateway starts that listener, tells the app
 * the URL the browser came back with, stops the listener, and opens a page in the browser. It
 * decides nothing: the URL is handed over as it came, and checking it is the job of
 * `core/steam/steam-openid.ts` and of the sign-in service.
 *
 * The listener is not trusted ([ADR 0005](../../docs/adr/0005-steam-openid-linking.md)): any local
 * process can reach its port and send it a URL. A URL delivered by the gateway therefore proves
 * nothing; the proof comes from Steam, when the service has it confirm the assertion.
 *
 * Adapters do not wrap their failures: whatever the plugin throws (a port that cannot be bound, a
 * browser that cannot be launched, a listener already ended) propagates as it is (see
 * `src/adapters/README.md`), and the service that calls the port wraps it.
 *
 * @packageDocumentation
 */

/** Starts and stops the loopback listener of a Steam sign-in, and opens the system browser. */
export interface SignInGateway {
  /**
   * Start the one-shot loopback listener on 127.0.0.1, on a port the system chooses.
   *
   * The listener answers every request with `callbackPage` and ends after the first request that
   * carries the full callback URL, so a second request, or a probe of the port, finds it closed.
   *
   * @param callbackPage - The HTML the browser shows once Steam has sent the player back.
   * @returns The port the listener is bound to.
   */
  start(callbackPage: string): Promise<{ readonly port: number }>;

  /**
   * Be told the full callback URL, as the browser requested it.
   *
   * The listener is not trusted: the URL may be anything a local process sent. An empty string
   * means the listener received a URL it could not parse; the caller treats it like any other
   * callback that does not validate. Subscribe before {@link SignInGateway.start}, so no callback
   * can arrive unheard.
   *
   * @param listener - Called with each callback URL, or with `''` for an unreadable one.
   * @returns A function that stops the subscription.
   */
  onCallback(listener: (url: string) => void): Promise<() => void>;

  /**
   * Stop a listener that got no callback (the player gave up, or the time ran out). It fails once
   * the listener has ended by itself.
   *
   * @param port - The port {@link SignInGateway.start} returned.
   * @returns A promise resolved once the listener is stopped.
   * @throws Whatever the plugin rejects with once the listener has ended by itself (after the
   *   first callback): there is then nothing left to stop.
   */
  cancel(port: number): Promise<void>;

  /**
   * Open a URL in the system browser.
   *
   * The URL is the login URL, which carries the nonce, and a plugin rejection may quote it: the
   * caller must never log the message of what this rejects with, only its kind.
   *
   * @param url - The URL, here the Steam login page.
   * @returns A promise resolved once the browser is asked to open it.
   * @throws Whatever the plugin rejects with when the browser cannot be launched. Its message may
   *   hold the URL.
   */
  openBrowser(url: string): Promise<void>;
}
