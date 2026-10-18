/**
 * Tests of the Tauri sign-in gateway against fakes of the `@fabianlars/tauri-plugin-oauth` and
 * `@tauri-apps/plugin-opener` functions: no IPC call is made and no listener or browser is
 * started. The fake of the oauth plugin keeps the callbacks it was given, as the real plugin does
 * with its two events, so a test can emit an event and see who hears it.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  TauriSignInGateway,
  type OauthFunctions,
  type OpenUrlFunction,
} from './tauri-sign-in-gateway.adapter';

/** A synthetic callback page and a synthetic callback URL: nothing a real sign-in carries. */
const CALLBACK_PAGE = '<!doctype html><p>Synthetic callback page</p>';
const CALLBACK_URL = 'http://127.0.0.1:49152/callback?nonce=synthetic';

/** The port the fake listener is bound to. */
const FAKE_PORT = 49152;

/** The fake plugin and what a test can do with it. */
interface FakeOauth {
  /** The functions to give to the adapter. */
  readonly functions: OauthFunctions;
  /** The configuration of every `start` call, as the adapter gave it. */
  readonly startConfigs: unknown[];
  /** The port of every `cancel` call. */
  readonly cancelledPorts: number[];
  /** How many callbacks are subscribed to the `oauth://url` event. */
  urlSubscriptions(): number;
  /** How many callbacks are subscribed to the `oauth://invalid-url` event. */
  invalidUrlSubscriptions(): number;
  /** Emit the `oauth://url` event: the listener got a URL it could parse. */
  emitUrl(url: string): void;
  /** Emit the `oauth://invalid-url` event: the listener got a URL it could not parse. */
  emitInvalidUrl(error: string): void;
  /** Make the next `onInvalidUrl` call reject, as an IPC failure would. */
  failNextInvalidUrlSubscription(error: Error): void;
}

/**
 * Build a fake of the oauth plugin.
 *
 * @returns The fake.
 */
function createFakeOauth(): FakeOauth {
  const startConfigs: unknown[] = [];
  const cancelledPorts: number[] = [];
  const urlCallbacks = new Set<(url: string) => void>();
  const invalidUrlCallbacks = new Set<(error: string) => void>();
  let nextInvalidUrlFailure: Error | null = null;

  const functions: OauthFunctions = {
    start: (config) => {
      startConfigs.push(config);
      return Promise.resolve(FAKE_PORT);
    },
    cancel: (port) => {
      cancelledPorts.push(port);
      return Promise.resolve();
    },
    onUrl: (callback) => {
      urlCallbacks.add(callback);
      return Promise.resolve(() => {
        urlCallbacks.delete(callback);
      });
    },
    onInvalidUrl: (callback) => {
      if (nextInvalidUrlFailure !== null) {
        const failure = nextInvalidUrlFailure;
        nextInvalidUrlFailure = null;
        return Promise.reject(failure);
      }
      invalidUrlCallbacks.add(callback);
      return Promise.resolve(() => {
        invalidUrlCallbacks.delete(callback);
      });
    },
  };

  return {
    functions,
    startConfigs,
    cancelledPorts,
    urlSubscriptions: () => urlCallbacks.size,
    invalidUrlSubscriptions: () => invalidUrlCallbacks.size,
    emitUrl: (url) => {
      for (const callback of [...urlCallbacks]) {
        callback(url);
      }
    },
    emitInvalidUrl: (error) => {
      for (const callback of [...invalidUrlCallbacks]) {
        callback(error);
      }
    },
    failNextInvalidUrlSubscription: (error) => {
      nextInvalidUrlFailure = error;
    },
  };
}

/** The arguments of every call a fake opener received. */
type OpenerCall = Parameters<OpenUrlFunction>;

/**
 * Build a fake of the opener plugin's `openUrl`.
 *
 * @returns The function and the arguments of every call it received.
 */
function createFakeOpener(): { readonly openUrl: OpenUrlFunction; readonly calls: OpenerCall[] } {
  const calls: OpenerCall[] = [];
  return {
    calls,
    openUrl: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
  };
}

describe('TauriSignInGateway', () => {
  it('starts the listener with the callback page and no fixed port', async () => {
    const oauth = createFakeOauth();
    const gateway = new TauriSignInGateway(oauth.functions, createFakeOpener().openUrl);

    await expect(gateway.start(CALLBACK_PAGE)).resolves.toEqual({ port: FAKE_PORT });

    // Strict equality: a `ports` key, even undefined, would not be "no fixed port" for the plugin.
    expect(oauth.startConfigs).toStrictEqual([{ response: CALLBACK_PAGE }]);
  });

  it('forwards the callback URL, and an unreadable one as an empty string', async () => {
    const oauth = createFakeOauth();
    const gateway = new TauriSignInGateway(oauth.functions, createFakeOpener().openUrl);
    const received: string[] = [];
    await gateway.onCallback((url) => received.push(url));

    oauth.emitUrl(CALLBACK_URL);
    // The plugin's message describes the failure and may quote the URL: it must not reach the app.
    oauth.emitInvalidUrl(`invalid URL: ${CALLBACK_URL}`);

    expect(received).toEqual([CALLBACK_URL, '']);
  });

  it('stops listening to both events', async () => {
    const oauth = createFakeOauth();
    const gateway = new TauriSignInGateway(oauth.functions, createFakeOpener().openUrl);
    const received: string[] = [];
    const stopListening = await gateway.onCallback((url) => received.push(url));
    expect([oauth.urlSubscriptions(), oauth.invalidUrlSubscriptions()]).toEqual([1, 1]);

    stopListening();

    expect([oauth.urlSubscriptions(), oauth.invalidUrlSubscriptions()]).toEqual([0, 0]);
    oauth.emitUrl(CALLBACK_URL);
    oauth.emitInvalidUrl('invalid URL');
    expect(received).toEqual([]);
  });

  it('removes the first subscription when the second one fails', async () => {
    const oauth = createFakeOauth();
    const gateway = new TauriSignInGateway(oauth.functions, createFakeOpener().openUrl);
    const failure = new Error('synthetic IPC failure');
    oauth.failNextInvalidUrlSubscription(failure);

    await expect(gateway.onCallback(() => undefined)).rejects.toBe(failure);

    // No listener is left behind: the caller never got the function that would remove it.
    expect([oauth.urlSubscriptions(), oauth.invalidUrlSubscriptions()]).toEqual([0, 0]);
  });

  it('cancels a listener by its port', async () => {
    const oauth = createFakeOauth();
    const gateway = new TauriSignInGateway(oauth.functions, createFakeOpener().openUrl);

    await gateway.cancel(FAKE_PORT);

    expect(oauth.cancelledPorts).toEqual([FAKE_PORT]);
  });

  it('lets the failures of the plugin through', async () => {
    const failure = new Error('synthetic plugin failure');
    const oauth: OauthFunctions = {
      ...createFakeOauth().functions,
      start: () => Promise.reject(failure),
      cancel: () => Promise.reject(failure),
    };
    const gateway = new TauriSignInGateway(oauth, () => Promise.reject(failure));

    await expect(gateway.start(CALLBACK_PAGE)).rejects.toBe(failure);
    await expect(gateway.cancel(FAKE_PORT)).rejects.toBe(failure);
    await expect(gateway.openBrowser('https://steamcommunity.com/openid/login')).rejects.toBe(
      failure,
    );
  });

  it('opens the URL in the system browser', async () => {
    const opener = createFakeOpener();
    const gateway = new TauriSignInGateway(createFakeOauth().functions, opener.openUrl);
    const url = 'https://steamcommunity.com/openid/login?synthetic=1';

    await gateway.openBrowser(url);

    // Only the URL: no `openWith`, so the system default browser is used.
    expect(opener.calls).toEqual([[url]]);
  });
});
