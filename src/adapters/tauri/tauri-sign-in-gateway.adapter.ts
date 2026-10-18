/**
 * {@link SignInGateway} backed by two Tauri plugins (desktop app): the community
 * `tauri-plugin-oauth` for the one-shot loopback listener, and the official `plugin-opener` for the
 * system browser.
 *
 * The oauth plugin binds a port of its choice on 127.0.0.1, answers every request with the page it
 * was given, and ends after the first request that carries the full URL. It tells the app that URL
 * with one of two events: `oauth://url` when it could parse it, `oauth://invalid-url` (with a
 * message) when it could not. The gateway merges the two into one callback: the message of the
 * second may quote the URL, which carries the nonce and the player's Steam assertion, so it is
 * dropped and the app is told an empty string instead.
 *
 * The listener is not trusted ([ADR 0005](../../docs/adr/0005-steam-openid-linking.md)): any local
 * process can reach its port, so the gateway forwards what it hears without judging it. The
 * permissions of the two plugins are granted in `src-tauri/capabilities/default.json`: the webview
 * may start and stop the listener and open URLs, nothing more.
 *
 * @packageDocumentation
 */
import { cancel, onInvalidUrl, onUrl, start } from '@fabianlars/tauri-plugin-oauth';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { SignInGateway } from '../../ports/sign-in-gateway.port';

/** The functions of `@fabianlars/tauri-plugin-oauth` this adapter uses; tests pass a fake. */
export type OauthFunctions = Pick<
  typeof import('@fabianlars/tauri-plugin-oauth'),
  'start' | 'cancel' | 'onUrl' | 'onInvalidUrl'
>;

/** The `openUrl` function of `@tauri-apps/plugin-opener`; tests pass a fake. */
export type OpenUrlFunction = typeof import('@tauri-apps/plugin-opener').openUrl;

/** The real oauth plugin, the default of the adapter. */
const pluginOauth: OauthFunctions = { start, cancel, onUrl, onInvalidUrl };

/** {@link SignInGateway} running the loopback listener with `tauri-plugin-oauth`. */
export class TauriSignInGateway implements SignInGateway {
  readonly #oauth: OauthFunctions;
  readonly #openUrl: OpenUrlFunction;

  /**
   * @param oauth - The oauth plugin's functions; replaced by a fake in tests.
   * @param openUrlFunction - The opener plugin's `openUrl`; replaced by a fake in tests.
   */
  constructor(oauth: OauthFunctions = pluginOauth, openUrlFunction: OpenUrlFunction = openUrl) {
    this.#oauth = oauth;
    this.#openUrl = openUrlFunction;
  }

  /**
   * Start the listener on a port the system chooses.
   *
   * No `ports` option is given: a fixed port could already be taken by another program, and a
   * port the player's other tools know is one more thing for a local process to aim at.
   *
   * @param callbackPage - The HTML the listener answers every request with.
   * @returns The port the listener is bound to.
   * @throws Whatever the plugin rejects with: no port could be bound…
   */
  async start(callbackPage: string): Promise<{ readonly port: number }> {
    const port = await this.#oauth.start({ response: callbackPage });
    return { port };
  }

  /**
   * Listen to both events of the plugin.
   *
   * @param listener - Called with the callback URL, or with `''` for a URL the plugin could not parse.
   * @returns One function that stops listening to both events.
   * @throws Whatever the plugin rejects with when it cannot subscribe to an event.
   */
  async onCallback(listener: (url: string) => void): Promise<() => void> {
    const stopUrl = await this.#oauth.onUrl(listener);
    let stopInvalidUrl: () => void;
    try {
      // The plugin's message is dropped on purpose: see the header of this file.
      stopInvalidUrl = await this.#oauth.onInvalidUrl(() => {
        listener('');
      });
    } catch (error) {
      // The caller never gets the function that would remove the first subscription: do it here.
      stopUrl();
      throw error;
    }
    return () => {
      stopUrl();
      stopInvalidUrl();
    };
  }

  /**
   * Stop a listener that got no callback.
   *
   * @param port - The port {@link TauriSignInGateway.start} returned.
   * @returns A promise resolved once the listener is stopped.
   * @throws Whatever the plugin rejects with once the listener has ended by itself.
   */
  async cancel(port: number): Promise<void> {
    await this.#oauth.cancel(port);
  }

  /**
   * Open a URL in the system default browser.
   *
   * @param url - The URL to open.
   * @returns A promise resolved once the browser is asked to open it.
   * @throws Whatever the plugin rejects with: the URL is refused by the plugin's scope, no
   *   browser could be launched…
   */
  async openBrowser(url: string): Promise<void> {
    await this.#openUrl(url);
  }
}
