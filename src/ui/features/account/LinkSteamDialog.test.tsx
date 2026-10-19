/**
 * Tests of the Steam link dialog and of the button that opens it, rendered with the real providers
 * on the development adapters: the fixture gateway plays the loopback listener and the browser, the
 * fixture API plays deadlock-api and Steam, and the database is in memory. Accounts are synthetic:
 * 1000001 is the account of the fixtures.
 *
 * Most tests drive the dialog through the button, as a player does. The sentences each language must
 * say are written out in full below, not read from the catalogues: they are what the player reads,
 * and a test that took them from the catalogue would pass whatever the catalogue says.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent, type UserEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  type FixtureHandler,
  type FixtureRequest,
} from '../../../adapters/dev/fixture-http-client.adapter';
import {
  FIXTURE_LOOPBACK_PORT,
  FixtureSignInGateway,
} from '../../../adapters/dev/fixture-sign-in-gateway.adapter';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import {
  createSteamCallbackUrl,
  FIXTURE_STEAM_ID64,
} from '../../../adapters/dev/fixtures/steam.fixture';
import type { AccountId } from '../../../core/domain/account';
import { AppError } from '../../../core/errors/app-error';
import { SUPPORTED_LANGUAGES, type Language } from '../../../core/settings/language';
import { SIGN_IN_TIMEOUT_MS, STEAM_OPENID_ENDPOINT } from '../../../core/steam/steam-openid';
import type { AppServices } from '../../../services/app-services';
import type { LinkResult } from '../../../services/account.service';
import type { SyncService } from '../../../services/sync.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
} from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { LinkAccountButton, type LinkAccountButtonProps } from './LinkAccountButton';
import { LinkSteamDialog } from './LinkSteamDialog';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const START = Date.UTC(2026, 9, 19, 12, 0, 0);

/**
 * Size of the synthetic history. A link starts a real synchronisation of it, and the tests wait for
 * it to end, so it is kept short: just long enough to have a Paige match archived.
 */
const SMALL_HISTORY = 8;

/**
 * How long a test waits for a sign-in to end, in milliseconds. A sign-in is a chain of services (the
 * listener, Steam, the profile, the database, the first synchronisation), not a single read: the
 * default of `waitFor` (one second) is too tight for a busy machine.
 */
const SIGN_IN_WAIT_MS = 5_000;

/** The persona name of the account a player switches away from (synthetic). */
const CURRENT_NAME = 'Test Player';

/** What the dialog says in a language: the buttons, the title and the sentences of the steps. */
interface Texts {
  readonly opener: string;
  readonly title: string;
  readonly explanation: string;
  readonly continue: string;
  readonly cancel: string;
  readonly close: string;
  readonly retry: string;
  readonly waiting: string;
  readonly alreadyLinked: string;
  readonly storage: string;
  readonly unexpected: string;
  /** What the warning calls an account that has no persona name. */
  readonly placeholderName: string;
  /** The warning shown before an account is replaced, for the account named `name`. */
  readonly switchWarning: (name: string) => string;
}

/** The texts of the dialog in each language. */
const TEXTS: Readonly<Record<Language, Texts>> = {
  en: {
    opener: 'Link my Steam account',
    title: 'Link your Steam account',
    explanation:
      "Steam's sign-in page opens in your browser. Steam will show the site as 127.0.0.1: that is TheLibrary on this PC. TheLibrary never sees your password.",
    continue: 'Continue',
    cancel: 'Cancel',
    close: 'Close',
    retry: 'Try again',
    waiting: 'Waiting for Steam in your browser…',
    alreadyLinked: 'This account is already linked.',
    storage: 'Local data could not be read or saved.',
    unexpected: 'An unexpected error occurred.',
    placeholderName: 'Steam player',
    switchWarning: (name) =>
      `Linking another account deletes all the data of ${name} on this PC: its matches, archived details and history.`,
  },
  fr: {
    opener: 'Lier mon compte Steam',
    title: 'Lier ton compte Steam',
    explanation:
      "La page de connexion de Steam s'ouvre dans ton navigateur. Steam affichera le site « 127.0.0.1 » : c'est TheLibrary sur ce PC. TheLibrary ne voit jamais ton mot de passe.",
    continue: 'Continuer',
    cancel: 'Annuler',
    close: 'Fermer',
    retry: 'Réessayer',
    waiting: 'En attente de Steam dans ton navigateur…',
    alreadyLinked: 'Ce compte est déjà lié.',
    storage: "Impossible de lire ou d'enregistrer les données locales.",
    unexpected: 'Une erreur inattendue est survenue.',
    placeholderName: 'Joueur Steam',
    switchWarning: (name) =>
      `Lier un autre compte supprime toutes les données de ${name} sur ce PC : ses parties, ses détails archivés et son historique.`,
  },
};

/** The English texts, for the tests that do not care about the language. */
const EN = TEXTS.en;

/** What can be set up for a test. */
interface SetUpOptions {
  /** Whether the browser comes back from Steam by itself once opened; `true` by default. */
  readonly autoAnswer?: boolean;
  /** Answers the requests to deadlock-api and Steam; the fixtures (a short history) by default. */
  readonly handler?: FixtureHandler;
  /** The account linked before the test starts; none by default (a first launch). */
  readonly accountId?: AccountId | null;
}

/** The services built so far: any sign-in still waiting is cancelled after each test. */
const builtServices: AppServices[] = [];

afterEach(() => {
  // The components go first, so that cancelling a sign-in does not update a screen that is still
  // there. A sign-in left waiting would keep its listener and its five-minute timer alive.
  cleanup();
  for (const services of builtServices.splice(0)) {
    services.account.cancelLink();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Build the services of a test: a clock that does not move, a short synthetic history, and a
 * gateway whose browser answers by itself unless told otherwise.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The services and their adapters.
 */
function setUp({
  autoAnswer = true,
  handler = createFixtureApi({ now: START, matchCount: SMALL_HISTORY }),
  accountId = null,
}: SetUpOptions = {}): TestServices {
  const signInGateway = new FixtureSignInGateway({ autoAnswer, now: () => START });
  const test = createTestServices({ now: () => START, handler, accountId, signInGateway });
  builtServices.push(test.services);
  return test;
}

/**
 * The synthetic Steam, except that it answers every confirmation of a sign-in with an HTTP 503.
 *
 * @returns The handler.
 */
function steamUnavailable(): FixtureHandler {
  const fixtures = createFixtureApi({ now: START, matchCount: SMALL_HISTORY });
  return (request) =>
    request.method === 'POST' && request.url === STEAM_OPENID_ENDPOINT
      ? { status: 503, headers: {}, body: '' }
      : fixtures(request);
}

/**
 * Tell whether a request asks deadlock-api for a Steam profile.
 *
 * @param request - The request.
 * @returns `true` for a profile request.
 */
function isProfileRequest(request: FixtureRequest): boolean {
  return request.url.includes('/v1/players/steam');
}

/**
 * The synthetic API, except that the answers about the Steam profile wait until the test lets them
 * go. A sign-in then gets as far as Steam's confirmation, which ends it, and the link waits for the
 * profile of the account it just got: the point where giving up is too late.
 *
 * @returns The handler, and `release`, which lets the held answers go.
 */
function holdingProfile(): { handler: FixtureHandler; release: () => void } {
  const fixtures = createFixtureApi({ now: START, matchCount: SMALL_HISTORY });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    handler: async (request) => {
      if (isProfileRequest(request)) {
        await released;
      }
      return fixtures(request);
    },
    release,
  };
}

/**
 * Render a tree inside the providers of the app.
 *
 * @param test - The services of the test.
 * @param language - Language of the interface.
 * @param children - What to render.
 * @returns The query client, and a simulated user.
 */
async function renderInApp(
  test: TestServices,
  language: Language,
  children: ReactNode,
): Promise<{ queryClient: QueryClient; user: UserEvent }> {
  const queryClient = createTestQueryClient();
  const i18n = await createI18n(language);
  render(
    <AppProviders services={test.services} queryClient={queryClient} i18n={i18n}>
      {children}
    </AppProviders>,
  );
  return { queryClient, user: userEvent.setup() };
}

/**
 * Render the button that opens the dialog.
 *
 * @param test - The services of the test.
 * @param props - Props of the button.
 * @param language - Language of the interface.
 * @returns The query client, and a simulated user.
 */
function renderButton(
  test: TestServices,
  props: LinkAccountButtonProps = {},
  language: Language = 'en',
) {
  return renderInApp(test, language, <LinkAccountButton {...props} />);
}

/**
 * Open the dialog with the button of the page.
 *
 * @param user - The simulated user.
 * @param label - Label of the button.
 */
async function openDialog(user: UserEvent, label = EN.opener): Promise<void> {
  await user.click(screen.getByRole('button', { name: label }));
}

/**
 * Click the "Continue" button of the step that is shown.
 *
 * @param user - The simulated user.
 * @param texts - The texts of the language of the interface.
 */
async function pressContinue(user: UserEvent, texts: Texts = EN): Promise<void> {
  await user.click(screen.getByRole('button', { name: texts.continue }));
}

/**
 * Wait until the browser is open on Steam's login page, i.e. until the sign-in is up.
 *
 * @param test - The services of the test.
 * @returns The login URL.
 */
async function loginUrlOf(test: TestServices): Promise<string> {
  const { openedUrls } = test.signInGateway;
  await vi.waitFor(
    () => {
      expect(openedUrls).toHaveLength(1);
    },
    { timeout: SIGN_IN_WAIT_MS },
  );
  return openedUrls[0] ?? expect.unreachable('The browser was opened');
}

/**
 * Play the browser coming back from Steam with the callback of the fixture player, changed as the
 * test needs.
 *
 * @param test - The services of the test; the sign-in must be waiting (`autoAnswer: false`).
 * @param overrides - Query parameters to replace or remove in the genuine callback.
 */
async function deliverCallback(
  test: TestServices,
  overrides: Readonly<Record<string, string | null>>,
): Promise<void> {
  test.signInGateway.deliver(
    createSteamCallbackUrl(await loginUrlOf(test), {
      steamId64: FIXTURE_STEAM_ID64,
      now: START,
      overrides,
    }),
  );
}

/**
 * Wait until the synchronisation is idle: a link starts the first synchronisation of the account in
 * the background, and a test must not end under it.
 *
 * @param sync - The synchronisation.
 * @returns A promise settled once no run is going (at once when none is).
 */
function whenIdle(sync: SyncService): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!sync.isRunning()) {
      resolve();
      return;
    }
    const unsubscribe = sync.subscribe(() => {
      if (!sync.isRunning()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * The link mutation of the page, from the cache of the query client: it outlives the dialog that
 * started it, which is what lets a test see how a sign-in ended after the dialog was closed.
 *
 * @param queryClient - The query client of the page.
 * @returns The mutation, or `undefined` when none was started.
 */
function linkMutation(queryClient: QueryClient) {
  return queryClient.getMutationCache().find<LinkResult>({ mutationKey: ['account', 'link'] });
}

describe('LinkAccountButton', () => {
  it('has the label of the link and the look of a main action by default', async () => {
    await renderButton(setUp());

    const button = screen.getByRole('button', { name: EN.opener });
    expect(button).toHaveClass('bg-accent-bright');
    // The dialog is not there before the player asks for it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('takes the label and the subtle look it is given', async () => {
    await renderButton(setUp(), { label: 'Use another Steam account', variant: 'subtle' });

    const button = screen.getByRole('button', { name: 'Use another Steam account' });
    expect(button).toHaveClass('bg-surface-raised');
    expect(button).not.toHaveClass('bg-accent-bright');
  });
});

describe('LinkSteamDialog', () => {
  it('explains the sign-in before opening the browser', async () => {
    const test = setUp({ autoAnswer: false });
    const link = vi.spyOn(test.services.account, 'link');
    const { user, queryClient } = await renderButton(test);

    await openDialog(user);

    expect(screen.getByRole('dialog', { name: EN.title })).toBeVisible();
    expect(screen.getByText(EN.explanation)).toBeVisible();
    // Nothing was started: no sign-in was asked of the service (so no mutation exists), no listener,
    // no browser. Steam is reached after Continue only.
    expect(link).not.toHaveBeenCalled();
    expect(linkMutation(queryClient)).toBeUndefined();
    expect(test.signInGateway.lastCallbackPage).toBeNull();
    expect(test.signInGateway.openedUrls).toEqual([]);
    // Screen readers read the explanation with the button that has the focus, whichever it is (the
    // browser picks the first one when it opens the dialog, which jsdom does not do).
    expect(screen.getByRole('button', { name: EN.cancel })).toHaveAccessibleDescription(
      EN.explanation,
    );
    expect(screen.getByRole('button', { name: EN.continue })).toHaveAccessibleDescription(
      EN.explanation,
    );

    await pressContinue(user);

    expect(await screen.findByRole('status')).toHaveTextContent(EN.waiting);
    const loginUrl = await loginUrlOf(test);
    expect(loginUrl.startsWith(`${STEAM_OPENID_ENDPOINT}?`)).toBe(true);
    expect(link).toHaveBeenCalledTimes(1);
  });

  it('links the account after Steam answers', async () => {
    const test = setUp();
    const { user } = await renderButton(test);

    await openDialog(user);
    await pressContinue(user);

    // The dialog closes by itself once the account is linked: there is nothing left to say.
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      },
      { timeout: SIGN_IN_WAIT_MS },
    );
    await expect(test.services.account.getLinkedAccount()).resolves.toMatchObject({
      accountId: FIXTURE_ACCOUNT_ID,
      personaName: 'Fixture Player',
    });
    await whenIdle(test.services.sync);
  });

  it('shows the waiting state and cancels the sign-in', async () => {
    const test = setUp({ autoAnswer: false });
    const { user } = await renderButton(test);
    await openDialog(user);

    await pressContinue(user);

    // One status line, and the focus on the way out: the button just pressed is gone.
    expect(await screen.findByRole('status')).toHaveTextContent(EN.waiting);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    const cancel = screen.getByRole('button', { name: EN.cancel });
    expect(cancel).toHaveFocus();
    await loginUrlOf(test);

    await user.click(cancel);

    // The dialog stays open to say how it ended, and the status line is gone, not repeated.
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in cancelled.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(test.signInGateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
    await expect(test.services.account.getLinkedAccount()).resolves.toBeNull();
  });

  it('goes on to link the account when Cancel is pressed after Steam confirmed', async () => {
    const { handler, release } = holdingProfile();
    const test = setUp({ handler });
    const { user, queryClient } = await renderButton(test);
    await openDialog(user);
    await pressContinue(user);
    // Steam confirmed the sign-in, which is over: the link waits for the profile of the account.
    await vi.waitFor(
      () => {
        expect(test.http.requests.some(isProfileRequest)).toBe(true);
      },
      { timeout: SIGN_IN_WAIT_MS },
    );
    const cancel = await screen.findByRole('button', { name: EN.cancel });

    await user.click(cancel);

    // Too late to give up: Cancel is spent, the dialog goes on waiting, and says nothing of a
    // cancellation.
    expect(cancel).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(EN.waiting);
    expect(screen.queryByText('Sign-in cancelled.')).not.toBeInTheDocument();
    release();

    // The account is linked all the same, and the dialog closes as for any link.
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      },
      { timeout: SIGN_IN_WAIT_MS },
    );
    expect(linkMutation(queryClient)?.state.data).toMatchObject({ kind: 'linked' });
    await expect(test.services.account.getLinkedAccount()).resolves.toMatchObject({
      accountId: FIXTURE_ACCOUNT_ID,
    });
    await whenIdle(test.services.sync);
  });

  it('lets the player cancel a new attempt once a first one was cancelled', async () => {
    const test = setUp({ autoAnswer: false });
    const { user } = await renderButton(test);
    await openDialog(user);
    await pressContinue(user);
    // The first attempt is up (the browser is open) before it is given up.
    await loginUrlOf(test);
    await user.click(await screen.findByRole('button', { name: EN.cancel }));
    await user.click(await screen.findByRole('button', { name: EN.retry }));

    await pressContinue(user);

    // The second wait is a new one: what the first Cancel spent does not carry over.
    await vi.waitFor(
      () => {
        expect(test.signInGateway.openedUrls).toHaveLength(2);
      },
      { timeout: SIGN_IN_WAIT_MS },
    );
    expect(await screen.findByRole('status')).toHaveTextContent(EN.waiting);
    expect(screen.getByRole('button', { name: EN.cancel })).toBeEnabled();
  });

  it('cancels the sign-in when the dialog is closed with Escape', async () => {
    const test = setUp({ autoAnswer: false });
    const { user, queryClient } = await renderButton(test);
    await openDialog(user);
    await pressContinue(user);
    await screen.findByRole('status');
    await loginUrlOf(test);

    // Escape: the browser fires `cancel` on the dialog before it closes it.
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(test.signInGateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
    });
    // The sign-in ends as cancelled after the dialog is gone: that neither reopens it nor fails.
    await waitFor(() => {
      expect(linkMutation(queryClient)?.state.data).toEqual({ kind: 'cancelled' });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(test.services.account.getLinkedAccount()).resolves.toBeNull();
  });

  it('gives up the sign-in once when one gesture asks to close it twice', async () => {
    const test = setUp({ autoAnswer: false });
    const onClose = vi.fn();
    // A parent that keeps the dialog open: it may ignore Escape, but not the close the browser makes.
    const { user, queryClient } = await renderInApp(
      test,
      'en',
      <LinkSteamDialog open mode="link" currentName={null} onClose={onClose} />,
    );
    await pressContinue(user);
    await screen.findByRole('status');
    await loginUrlOf(test);
    const dialog = screen.getByRole<HTMLDialogElement>('dialog');

    // A second Escape in a row: the `cancel` event, then the close that follows it.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    act(() => {
      dialog.close();
    });

    expect(onClose).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(linkMutation(queryClient)?.state.data).toEqual({ kind: 'cancelled' });
    });
    expect(test.signInGateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
  });

  it('starts from the explanation again when it is closed and opened again', async () => {
    const test = setUp({ autoAnswer: false });
    const { user } = await renderButton(test);
    await openDialog(user);
    await pressContinue(user);
    await user.click(await screen.findByRole('button', { name: EN.cancel }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: EN.close }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await openDialog(user);

    // Nothing of the last attempt is left.
    expect(screen.getByText(EN.explanation)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: EN.continue })).toBeVisible();
  });

  describe('when the sign-in fails', () => {
    /** What a test needs to bring a sign-in to a failure in the language it runs in. */
    interface Scene {
      readonly test: TestServices;
      readonly user: UserEvent;
      readonly texts: Texts;
    }

    /** One way a sign-in fails: how the test plays it, and what each language says. */
    interface FailureCase {
      readonly kind: Exclude<LinkResult['kind'], 'linked' | 'already_linked'>;
      readonly sentences: Readonly<Record<Language, string>>;
      readonly options: SetUpOptions;
      /** Presses Continue and plays the sign-in up to its end. */
      readonly play: (scene: Scene) => Promise<void>;
    }

    const FAILURES: readonly FailureCase[] = [
      {
        kind: 'cancelled',
        sentences: { en: 'Sign-in cancelled.', fr: 'Connexion annulée.' },
        options: { autoAnswer: false },
        play: async ({ user, texts }) => {
          await pressContinue(user, texts);
          await screen.findByRole('status');
          await user.click(screen.getByRole('button', { name: texts.cancel }));
        },
      },
      {
        kind: 'timed_out',
        sentences: { en: 'Sign-in timed out.', fr: 'La connexion a expiré.' },
        options: { autoAnswer: false },
        play: async ({ test, texts }) => {
          // Only the timers, and after the dialog is open: the clock of the services is the test's own.
          // The click is not simulated by `user-event`, which waits on a timer after each action.
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          fireEvent.click(screen.getByRole('button', { name: texts.continue }));
          await loginUrlOf(test);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
          });
        },
      },
      {
        kind: 'cancelled_on_steam',
        sentences: { en: 'Sign-in cancelled on Steam.', fr: 'Connexion annulée sur Steam.' },
        options: { autoAnswer: false },
        play: async ({ test, user, texts }) => {
          await pressContinue(user, texts);
          await deliverCallback(test, { 'openid.mode': 'cancel' });
        },
      },
      {
        kind: 'refused',
        sentences: {
          en: 'Steam did not confirm this sign-in. Try again.',
          fr: "Steam n'a pas confirmé cette connexion. Réessaie.",
        },
        options: { autoAnswer: false },
        play: async ({ test, user, texts }) => {
          await pressContinue(user, texts);
          // A callback that carries another nonce than the one of this sign-in.
          await deliverCallback(test, { nonce: 'f'.repeat(32) });
        },
      },
      {
        kind: 'steam_unavailable',
        sentences: {
          en: 'Steam is unavailable right now. Try again later.',
          fr: 'Steam est indisponible pour le moment. Réessaie plus tard.',
        },
        options: { handler: steamUnavailable() },
        play: async ({ user, texts }) => {
          await pressContinue(user, texts);
        },
      },
      {
        kind: 'start_failed',
        sentences: {
          en: 'The sign-in could not start.',
          fr: "La connexion n'a pas pu démarrer.",
        },
        options: {},
        play: async ({ test, user, texts }) => {
          test.signInGateway.failNextStart(new Error('The port is in use'));
          await pressContinue(user, texts);
        },
      },
    ];

    /** Every failure in every language: `[kind, language, case]`, the first two named in the title. */
    const CASES = FAILURES.flatMap((failure) =>
      SUPPORTED_LANGUAGES.map((language): [FailureCase['kind'], Language, FailureCase] => [
        failure.kind,
        language,
        failure,
      ]),
    );

    it.each(CASES)('says why the sign-in failed: %s (%s)', async (_kind, language, failure) => {
      const texts = TEXTS[language];
      const test = setUp(failure.options);
      const { user } = await renderButton(test, {}, language);
      await openDialog(user, texts.opener);

      await failure.play({ test, user, texts });

      await vi.waitFor(
        () => {
          expect(screen.getByRole('alert').textContent).toBe(failure.sentences[language]);
        },
        { timeout: SIGN_IN_WAIT_MS },
      );
      // The player can try again or give up, and the waiting line is gone.
      expect(screen.getByRole('button', { name: texts.retry })).toBeVisible();
      expect(screen.getByRole('button', { name: texts.close })).toBeVisible();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      // A sign-in that failed linked nothing.
      await expect(test.services.account.getLinkedAccount()).resolves.toBeNull();
    });

    it('lets the player try again, from the explanation', async () => {
      const test = setUp();
      test.signInGateway.failNextStart(new Error('The port is in use'));
      const { user } = await renderButton(test);
      await openDialog(user);
      await pressContinue(user);
      expect(await screen.findByRole('alert')).toHaveTextContent('The sign-in could not start.');

      await user.click(screen.getByRole('button', { name: EN.retry }));

      // Back to the explanation, with nothing left of the failed attempt.
      expect(screen.getByText(EN.explanation)).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(test.signInGateway.openedUrls).toEqual([]);

      await pressContinue(user);

      await waitFor(
        () => {
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        },
        { timeout: SIGN_IN_WAIT_MS },
      );
      await expect(test.services.account.getLinkedAccount()).resolves.toMatchObject({
        accountId: FIXTURE_ACCOUNT_ID,
      });
      await whenIdle(test.services.sync);
    });

    it.each(SUPPORTED_LANGUAGES)(
      'says what went wrong when the link cannot be saved (%s)',
      async (language) => {
        const texts = TEXTS[language];
        const test = setUp();
        vi.spyOn(test.services.account, 'link').mockRejectedValue(
          new AppError('storage', 'The link cannot be saved'),
        );
        const { user } = await renderButton(test, {}, language);
        await openDialog(user, texts.opener);

        await pressContinue(user, texts);

        // A failure of the storage is told by its kind, like everywhere else in the app.
        expect((await screen.findByRole('alert')).textContent).toBe(texts.storage);
        expect(screen.getByRole('button', { name: texts.retry })).toBeVisible();
        expect(screen.getByRole('button', { name: texts.close })).toBeVisible();
      },
    );

    it.each(SUPPORTED_LANGUAGES)(
      'says an unexpected error occurred when something other than an error is thrown (%s)',
      async (language) => {
        const texts = TEXTS[language];
        const test = setUp();
        // Anything can be thrown: the dialog must not show a key or a raw value for it.
        vi.spyOn(test.services.account, 'link').mockRejectedValue('not an error');
        const { user } = await renderButton(test, {}, language);
        await openDialog(user, texts.opener);

        await pressContinue(user, texts);

        expect((await screen.findByRole('alert')).textContent).toBe(texts.unexpected);
        expect(screen.getByRole('button', { name: texts.retry })).toBeVisible();
      },
    );
  });

  describe('when an account is linked already', () => {
    it('asks before replacing a linked account', async () => {
      const test = setUp({ autoAnswer: false, accountId: FIXTURE_ACCOUNT_ID });
      const link = vi.spyOn(test.services.account, 'link');
      const { user, queryClient } = await renderButton(test, {
        mode: 'switch',
        currentName: CURRENT_NAME,
        label: 'Use another Steam account',
      });

      await openDialog(user, 'Use another Steam account');

      // The warning names the account that goes, and comes before the explanation.
      expect(screen.getByText(EN.switchWarning(CURRENT_NAME))).toBeVisible();
      expect(screen.queryByText(EN.explanation)).not.toBeInTheDocument();
      // Screen readers read the warning with the button that has the focus, whichever it is.
      const cancel = screen.getByRole('button', { name: EN.cancel });
      expect(cancel).toHaveAccessibleDescription(EN.switchWarning(CURRENT_NAME));
      expect(screen.getByRole('button', { name: EN.continue })).toHaveAccessibleDescription(
        EN.switchWarning(CURRENT_NAME),
      );

      await user.click(cancel);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(test.signInGateway.openedUrls).toEqual([]);
      // Opened again, it asks again: the answer of the last time is not kept.
      await openDialog(user, 'Use another Steam account');
      expect(screen.getByText(EN.switchWarning(CURRENT_NAME))).toBeVisible();

      await pressContinue(user);

      // Accepting the warning leads to the explanation, and still starts nothing: no sign-in was
      // asked of the service (so no mutation exists) and no browser was opened.
      expect(screen.getByText(EN.explanation)).toBeVisible();
      expect(screen.queryByText(EN.switchWarning(CURRENT_NAME))).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: EN.cancel })).toHaveAccessibleDescription(
        EN.explanation,
      );
      expect(link).not.toHaveBeenCalled();
      expect(linkMutation(queryClient)).toBeUndefined();
      expect(test.signInGateway.openedUrls).toEqual([]);
    });

    it.each(SUPPORTED_LANGUAGES)(
      'calls the account a Steam player when it has no name (%s)',
      async (language) => {
        const texts = TEXTS[language];
        const { user } = await renderButton(
          setUp(),
          { mode: 'switch', currentName: null },
          language,
        );

        await openDialog(user, texts.opener);

        expect(screen.getByText(texts.switchWarning(texts.placeholderName))).toBeVisible();
      },
    );

    it('warns in French as well', async () => {
      const fr = TEXTS.fr;
      const { user } = await renderButton(
        setUp(),
        { mode: 'switch', currentName: CURRENT_NAME },
        'fr',
      );

      await openDialog(user, fr.opener);

      expect(screen.getByText(fr.switchWarning(CURRENT_NAME))).toBeVisible();
      expect(screen.getByRole('button', { name: fr.continue })).toBeVisible();
      expect(screen.getByRole('button', { name: fr.cancel })).toBeVisible();
    });

    it.each(SUPPORTED_LANGUAGES)(
      'says when the same account is linked again (%s)',
      async (language) => {
        const texts = TEXTS[language];
        // The fixture sign-in gives the account that is linked already.
        const test = setUp({ accountId: FIXTURE_ACCOUNT_ID });
        const { user } = await renderButton(
          test,
          { mode: 'switch', currentName: CURRENT_NAME },
          language,
        );
        await openDialog(user, texts.opener);
        await pressContinue(user, texts);
        await pressContinue(user, texts);

        expect(
          await screen.findByText(texts.alreadyLinked, {}, { timeout: SIGN_IN_WAIT_MS }),
        ).toBeVisible();
        // Signing in again would give the same answer: there is nothing to try again.
        expect(screen.queryByRole('button', { name: texts.retry })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: texts.close })).toHaveFocus();

        await user.click(screen.getByRole('button', { name: texts.close }));

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        await whenIdle(test.services.sync);
      },
    );
  });

  describe('in French', () => {
    it('explains the sign-in in French', async () => {
      const fr = TEXTS.fr;
      const test = setUp({ autoAnswer: false });
      const { user } = await renderButton(test, {}, 'fr');

      await openDialog(user, fr.opener);

      expect(screen.getByRole('dialog', { name: fr.title })).toBeVisible();
      expect(screen.getByText(fr.explanation)).toBeVisible();
      expect(screen.getByRole('button', { name: fr.cancel })).toBeVisible();

      await pressContinue(user, fr);

      expect(await screen.findByRole('status')).toHaveTextContent(fr.waiting);
    });
  });
});
