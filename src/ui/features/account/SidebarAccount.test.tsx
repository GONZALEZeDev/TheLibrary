/**
 * Tests of the account block at the bottom of the sidebar, rendered inside the whole application
 * (router, shell, providers) on the development adapters: a synthetic deadlock-api, an in-memory
 * database and archive folder, and the fixture gateway that plays the browser coming back from Steam.
 * Accounts are synthetic: 1000001 is the account of the fixtures, 2000001 the one the placeholder
 * test links.
 *
 * The block is the one place that shows the account on every page, so these tests look at where it
 * sits (under the navigation, with the settings link left in it), what it says of the account, and
 * when it stays silent. The texts each language must say are written out in full below, not read from
 * the catalogues: they are what the player reads, and a test that took them from the catalogue would
 * pass whatever the catalogue says.
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent, type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureApi } from '../../../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from '../../../adapters/dev/fixtures/match-history.fixture';
import {
  FIXTURE_AVATAR_HASH,
  FIXTURE_AVATAR_JPEG,
} from '../../../adapters/dev/fixtures/steam.fixture';
import { bytesToBase64, type LinkedAccount } from '../../../core/account/linked-account';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import { accountIdToSteamId64 } from '../../../core/steam/steam-id';
import { AccountService, type LinkResult } from '../../../services/account.service';
import { LinkedAccountRepository } from '../../../services/linked-account.repository';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { testAccountId, testLinkedAccount } from '../../../test/test-data';
import { waitUntilIdle } from '../../../test/user-actions';
import { AppProviders } from '../../app/AppProviders';
import { createAppRouter } from '../../app/router';
import { createI18n } from '../../i18n/i18n';

/** The clock of the services (Unix ms): fixed, so that the fixtures are the same on every run. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Size of the synthetic history. A synchronisation also downloads and archives the details of the
 * Paige matches: this history has a few of them, enough to leave files in the archive for an unlink
 * to delete.
 */
const MATCH_COUNT = 12;

/** The account the placeholder test links: the fixture API has no profile for it. */
const OTHER_ACCOUNT_ID = testAccountId(2000001);

/**
 * How long a test waits for a chain of services to end (a synchronisation, an unlink), in
 * milliseconds: the default of `waitFor` (one second) is too tight for a busy machine.
 */
const LONG_WAIT_MS = 5_000;

/** A persona name of 61 characters (Steam allows 64): far wider than the sidebar. */
const LONG_NAME = 'Synthetic player with a very long name that fills the sidebar';

/** What the sidebar and the dialog it opens say in a language. */
interface Texts {
  /** The accessible name of the link to the settings, for an account called `name`. */
  readonly account: (name: string) => string;
  /** The button that links an account. */
  readonly linkAccount: string;
  /** The name of an account that has none. */
  readonly placeholderName: string;
  /** The title of the dialog the button opens. */
  readonly dialogTitle: string;
  /** The cancel button of that dialog. */
  readonly cancel: string;
}

/** The texts of each language. */
const TEXTS: Readonly<Record<Language, Texts>> = {
  en: {
    account: (name) => `Steam account: ${name}`,
    linkAccount: 'Link my Steam account',
    placeholderName: 'Steam player',
    dialogTitle: 'Link your Steam account',
    cancel: 'Cancel',
  },
  fr: {
    account: (name) => `Compte Steam : ${name}`,
    linkAccount: 'Lier mon compte Steam',
    placeholderName: 'Joueur Steam',
    dialogTitle: 'Lier ton compte Steam',
    cancel: 'Annuler',
  },
};

/** The English texts, for the tests that do not care about the language. */
const EN = TEXTS.en;

/** The links of the navigation, in order: nothing else is a link of the sidebar without an account. */
const NAV_LINKS = ['Dashboard', 'Matches', 'Review', 'Settings'];

/** What can be set up for a test. */
interface SetUpOptions extends TestServicesOptions {
  /** What the stored account has that the plain fixture account has not (a picture, no name…). */
  readonly account?: Partial<LinkedAccount>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Build the services of a test: a clock that does not move, a short synthetic history, and the
 * fixture account linked (unless the test asks for none) with the profile the test asks for.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The services and their adapters.
 */
async function setUp({ account = {}, ...options }: SetUpOptions = {}): Promise<TestServices> {
  const test = createTestServices({
    now: () => NOW,
    handler: createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
    ...options,
  });
  if (options.accountId !== null) {
    // The services read the link from the database, like the app: writing the profile there is what
    // gives the account a picture, a long name or no name. The first statement seeds the plain
    // fixture account first, and this write replaces it.
    await new LinkedAccountRepository(test.database, test.logger).setLinkedAccount(
      testLinkedAccount(options.accountId ?? FIXTURE_ACCOUNT_ID, {
        linkedAt: NOW,
        profileFetchedAt: NOW,
        ...account,
      }),
    );
  }
  return test;
}

/**
 * Render the application on a URL.
 *
 * @param test - The services of the test.
 * @param url - The initial URL; the dashboard by default.
 * @param language - Language of the interface.
 * @returns A simulated user.
 */
async function renderApp(
  test: TestServices,
  url = '/dashboard',
  language: Language = 'en',
): Promise<{ user: UserEvent }> {
  const i18n = await createI18n(language);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
  render(
    <AppProviders
      services={test.services}
      queryClient={createTestQueryClient(test.logger)}
      i18n={i18n}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { user: userEvent.setup() };
}

/**
 * The sidebar, once the shell is there.
 *
 * @returns The sidebar (an `aside` is a `complementary` landmark).
 */
function findSidebar(): Promise<HTMLElement> {
  return screen.findByRole('complementary');
}

/**
 * The account block of the sidebar: the last element of the sidebar, right after the navigation.
 *
 * @param sidebar - The sidebar.
 * @returns The block; fails the test when the sidebar has none.
 */
function accountBlock(sidebar: HTMLElement): HTMLElement {
  const nav = within(sidebar).getByRole('navigation', { name: 'Main navigation' });
  const block = sidebar.lastElementChild;
  expect(block).not.toBe(nav);
  expect(block?.previousElementSibling).toBe(nav);
  return block as HTMLElement;
}

/**
 * Check that the sidebar shows no account block: neither the account nor the way to link one.
 *
 * @param sidebar - The sidebar.
 */
function expectNoAccountBlock(sidebar: HTMLElement): void {
  expect(
    within(sidebar)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(NAV_LINKS);
  expect(within(sidebar).queryByRole('button')).toBeNull();
  // The block is not drawn empty either: no separator without something under it.
  expect(sidebar.lastElementChild).toBe(within(sidebar).getByRole('navigation'));
}

/**
 * A promise the test settles when it decides to.
 *
 * @returns The promise, and the function that settles it.
 */
function gate<T>(): { readonly answered: Promise<T>; readonly release: (answer: T) => void } {
  let release: (answer: T) => void = () => undefined;
  const answered = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { answered, release };
}

/**
 * Hold the removal of the archive folder of an account until the test lets it go. An unlink then
 * has cleared the link and stands at the deletion of the files: the account is gone for the screens
 * and the data is not.
 *
 * @param test - The services of the test.
 * @returns A function that lets the removal go on.
 */
function holdArchiveRemoval(test: TestServices): () => void {
  const { archiveStore } = test;
  const removeEntry = archiveStore.removeEntry.bind(archiveStore);
  const { answered, release } = gate<undefined>();
  vi.spyOn(archiveStore, 'removeEntry').mockImplementation(async (name) => {
    await answered;
    return removeEntry(name);
  });
  return () => {
    release(undefined);
  };
}

describe('SidebarAccount', () => {
  describe('with an account linked', () => {
    it('shows the linked account at the bottom of the sidebar', async () => {
      const test = await setUp({
        account: {
          avatarBase64: bytesToBase64(FIXTURE_AVATAR_JPEG),
          avatarHash: FIXTURE_AVATAR_HASH,
        },
      });
      const { user } = await renderApp(test);

      const sidebar = await findSidebar();
      const account = await within(sidebar).findByRole('link', {
        name: EN.account('Fixture Player'),
      });
      // What is read is the name; the accessible name says what it is the name of.
      expect(account).toHaveTextContent('Fixture Player');
      expect(account).toHaveAttribute('href', '/settings');
      // The picture is decorative (the name is written next to it): an empty `alt`.
      const picture = account.querySelector('img');
      expect(picture).toHaveAttribute('alt', '');
      expect(picture).toHaveAttribute(
        'src',
        `data:image/jpeg;base64,${bytesToBase64(FIXTURE_AVATAR_JPEG)}`,
      );
      expect(picture).toHaveAttribute('width', '32');
      // Under the navigation, set apart from it by a line, and nothing under the block.
      const block = accountBlock(sidebar);
      expect(block).toContainElement(account);
      expect(block).toHaveClass('border-t', 'border-border');
      // Linked: the way to link an account is not offered.
      expect(within(sidebar).queryByRole('button')).toBeNull();
      // The settings stay where they were, at the bottom of the navigation.
      const nav = within(sidebar).getByRole('navigation', { name: 'Main navigation' });
      expect(nav).not.toContainElement(account);
      const navLinks = within(nav).getAllByRole('link');
      expect(navLinks.map((link) => link.textContent)).toEqual(NAV_LINKS);
      expect(navLinks.at(-1)).toHaveClass('mt-auto');

      // The link goes to the settings, where the account is managed.
      await user.click(account);
      expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await waitFor(() => {
        expect(account).toHaveAttribute('aria-current', 'page');
      });
    });

    it('uses the placeholder name without a profile', async () => {
      const test = await setUp({ accountId: null });
      test.signInGateway.setSteamId64(accountIdToSteamId64(OTHER_ACCOUNT_ID));
      // The fixture API has no profile for this account: it is linked with no name and no picture.
      await expect(test.services.account.link()).resolves.toMatchObject({ kind: 'linked' });
      await renderApp(test);

      const sidebar = await findSidebar();
      const account = await within(sidebar).findByRole('link', {
        name: EN.account('Steam player'),
      });
      expect(account).toHaveTextContent('Steam player');
      // The generic avatar: a person in a round box, and no picture.
      expect(account.querySelector('img')).toBeNull();
      expect(account.firstElementChild).toHaveAttribute('aria-hidden', 'true');
      await waitUntilIdle(test.services.sync, LONG_WAIT_MS);
    });

    it('cuts a long name instead of widening the sidebar', async () => {
      expect(LONG_NAME.length).toBeLessThanOrEqual(64);
      await renderApp(await setUp({ account: { personaName: LONG_NAME } }));

      const sidebar = await findSidebar();
      const account = await within(sidebar).findByRole('link', {
        name: EN.account(LONG_NAME),
      });
      // The accessible name keeps the whole name; the line cuts it. A flex item never shrinks under
      // its content unless it may (`min-w-0`), and `truncate` adds the ellipsis. The picture keeps
      // its size, and the sidebar has a width of its own that its content does not change.
      const name = within(account).getByText(LONG_NAME);
      expect(name).toHaveClass('min-w-0', 'truncate');
      expect(account).toHaveClass('flex');
      expect(account.firstElementChild).toHaveClass('shrink-0');
      expect(sidebar).toHaveClass('w-60', 'shrink-0');
    });
  });

  describe('without an account', () => {
    it('offers to link an account when none is linked', async () => {
      const { user } = await renderApp(await setUp({ accountId: null }));

      const sidebar = await findSidebar();
      const button = await within(sidebar).findByRole('button', { name: EN.linkAccount });
      expect(button).toBeEnabled();
      // Under the navigation, like the account it stands for, and nothing of an account above it.
      const block = accountBlock(sidebar);
      expect(block).toContainElement(button);
      expect(block).toHaveClass('border-t', 'border-border');
      expect(
        within(sidebar)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(NAV_LINKS);

      // The button is the real one: it opens the dialog of the sign-in.
      await user.click(button);
      const dialog = await screen.findByRole('dialog', { name: EN.dialogTitle });
      expect(dialog).toBeVisible();
      await user.click(within(dialog).getByRole('button', { name: EN.cancel }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('while the account is not known', () => {
    it('shows nothing while the account is loading, then shows it', async () => {
      const { answered, release } = gate<LinkedAccount>();
      vi.spyOn(AccountService.prototype, 'getLinkedAccount').mockReturnValue(answered);
      await renderApp(await setUp(), '/settings');

      // The settings say that the account is loading; the sidebar neither shows an account nor
      // invites to link one before it knows which of the two is true.
      expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
      const sidebar = await findSidebar();
      expectNoAccountBlock(sidebar);

      release(testLinkedAccount(FIXTURE_ACCOUNT_ID, { linkedAt: NOW }));
      expect(
        await within(sidebar).findByRole('link', { name: EN.account('Fixture Player') }),
      ).toBeVisible();
    });

    it('shows nothing when the account cannot be read', async () => {
      vi.spyOn(AccountService.prototype, 'getLinkedAccount').mockRejectedValue(
        new AppError('storage', 'The linked account cannot be read'),
      );
      await renderApp(await setUp(), '/settings');

      // An account that cannot be read is not one that is missing: the sidebar must not invite to
      // link another one over it, and the settings are where the reason is told.
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Local data could not be read or saved.',
      );
      expectNoAccountBlock(await findSidebar());
    });
  });

  describe('while the account changes', () => {
    it('keeps the link button disabled while an unlink is still deleting', async () => {
      const test = await setUp();
      // Something to delete, so that the unlink has a deletion to wait for.
      await test.services.sync.syncNow('manual');
      await waitUntilIdle(test.services.sync, LONG_WAIT_MS);
      expect(test.archiveStore.files.size).toBeGreaterThan(0);
      const release = holdArchiveRemoval(test);
      const { user } = await renderApp(test, '/settings');
      await user.click(await screen.findByRole('button', { name: 'Unlink' }));
      const dialog = await screen.findByRole('dialog', { name: 'Unlink Fixture Player?' });

      await user.click(within(dialog).getByRole('button', { name: 'Unlink and delete' }));

      // The link is cleared already and the files are not: the sidebar offers a sign-in, but it
      // would queue behind the deletion, so the button waits for it.
      const sidebar = await findSidebar();
      expect(
        await within(sidebar).findByRole(
          'button',
          { name: EN.linkAccount },
          { timeout: LONG_WAIT_MS },
        ),
      ).toBeDisabled();

      release();

      await waitFor(
        () => {
          expect(within(sidebar).getByRole('button', { name: EN.linkAccount })).toBeEnabled();
        },
        { timeout: LONG_WAIT_MS },
      );
      expect(test.archiveStore.files.size).toBe(0);
    });

    it('keeps the link button disabled while a sign-in goes on behind a closed dialog', async () => {
      const test = await setUp({ accountId: null });
      const { answered, release } = gate<LinkResult>();
      vi.spyOn(test.services.account, 'link').mockReturnValue(answered);
      const { user } = await renderApp(test);
      const sidebar = await findSidebar();
      const button = await within(sidebar).findByRole('button', { name: EN.linkAccount });
      await user.click(button);
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      const dialog = screen.getByRole('dialog');
      expect(await within(dialog).findByRole('status')).toHaveTextContent(
        'Waiting for Steam in your browser…',
      );

      // Escape closes the dialog, but a sign-in that Steam already confirmed goes on behind it. A
      // second one started now would queue behind the first.
      fireEvent(dialog, new Event('cancel', { cancelable: true }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(button).toBeDisabled();

      release({ kind: 'cancelled' });

      await waitFor(() => {
        expect(button).toBeEnabled();
      });
    });
  });

  describe('in French', () => {
    const FR = TEXTS.fr;

    it('speaks French, and calls an account without a name a Joueur Steam', async () => {
      await renderApp(await setUp({ account: { personaName: null } }), '/dashboard', 'fr');

      const sidebar = await findSidebar();
      const account = await within(sidebar).findByRole('link', {
        name: FR.account(FR.placeholderName),
      });
      expect(account).toHaveTextContent(FR.placeholderName);
      expect(account).toHaveAttribute('href', '/settings');
    });

    it('offers to link an account in French', async () => {
      const { user } = await renderApp(await setUp({ accountId: null }), '/dashboard', 'fr');

      const sidebar = await findSidebar();
      await user.click(await within(sidebar).findByRole('button', { name: FR.linkAccount }));
      const dialog = await screen.findByRole('dialog', { name: FR.dialogTitle });
      await user.click(within(dialog).getByRole('button', { name: FR.cancel }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
