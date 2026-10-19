/**
 * Tests of the Steam account section of the settings, rendered inside the whole application (router,
 * shell, providers) on the development adapters: a synthetic deadlock-api, an in-memory database and
 * archive folder, and the fixture gateway that plays the browser coming back from Steam. Accounts are
 * synthetic: 1000001 is the account of the fixtures, 2000001 the one a player switches to.
 *
 * The unlink is the destructive part of the screen, so these tests look at what it deletes (the
 * matches and the files of the archive) and not only at what the screen says. The sentences each
 * language must say are written out in full below, not read from the catalogues: they are what the
 * player reads, and a test that took them from the catalogue would pass whatever the catalogue says.
 *
 * @packageDocumentation
 */
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { archiveFolder } from '../../../core/match-detail/archive-layout';
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
 * When the fixture account was linked (Unix ms). It is at noon UTC, so that the day shown is the
 * same in every time zone from UTC-12 to UTC+11.
 */
const LINKED_AT = Date.UTC(2026, 9, 12, 12, 0, 0);

/**
 * Size of the synthetic history. A synchronisation also downloads and archives the details of the
 * Paige matches, which a long history makes slow: this one has a few of them, enough to leave files
 * in the archive for an unlink to delete.
 */
const MATCH_COUNT = 12;

/** The account a player switches to: the fixture API has no profile for it. */
const OTHER_ACCOUNT_ID = testAccountId(2000001);

/**
 * How long a test waits for a sign-in to end, in milliseconds. A sign-in is a chain of services (the
 * listener, Steam, the profile, the database, the first synchronisation), not a single read: the
 * default of `waitFor` (one second) is too tight for a busy machine.
 */
const SIGN_IN_WAIT_MS = 5_000;

/** What the screen says in a language. */
interface Texts {
  readonly accountTitle: string;
  readonly switchButton: string;
  readonly unlinkButton: string;
  readonly unlinkTitle: (name: string) => string;
  readonly unlinkWarning: string;
  readonly unlinkConfirm: string;
  readonly cancel: string;
  readonly done: string;
  readonly incomplete: string;
  readonly notLinked: string;
  readonly linkButton: string;
  /** The line under the name, for the fixture account (linked on {@link LINKED_AT}). */
  readonly linkedOn: string;
}

/** The texts of the screen in each language. */
const TEXTS: Readonly<Record<Language, Texts>> = {
  en: {
    accountTitle: 'Steam account',
    switchButton: 'Use another Steam account',
    unlinkButton: 'Unlink',
    unlinkTitle: (name) => `Unlink ${name}?`,
    unlinkWarning:
      'All their data on this PC will be deleted: matches, archived details and history. This cannot be undone.',
    unlinkConfirm: 'Unlink and delete',
    cancel: 'Cancel',
    done: 'Account unlinked.',
    incomplete: 'Some files could not be removed yet; TheLibrary will finish at its next start.',
    notLinked: 'No Steam account is linked.',
    linkButton: 'Link my Steam account',
    linkedOn: 'Linked on Oct 12, 2026.',
  },
  fr: {
    accountTitle: 'Compte Steam',
    switchButton: 'Utiliser un autre compte Steam',
    unlinkButton: 'Délier',
    unlinkTitle: (name) => `Délier ${name} ?`,
    unlinkWarning:
      "Toutes ses données sur ce PC seront supprimées : parties, détails archivés et historique. C'est définitif.",
    unlinkConfirm: 'Délier et supprimer',
    cancel: 'Annuler',
    done: 'Compte délié.',
    incomplete:
      "Certains fichiers n'ont pas encore pu être supprimés ; TheLibrary terminera au prochain démarrage.",
    notLinked: "Aucun compte Steam n'est lié.",
    linkButton: 'Lier mon compte Steam',
    linkedOn: 'Lié le 12 oct. 2026.',
  },
};

/** The English texts, for the tests that do not care about the language. */
const EN = TEXTS.en;

/** What can be set up for a test. */
interface SetUpOptions extends TestServicesOptions {
  /**
   * What the stored account has that the plain fixture account has not (a picture, no name…). The
   * time it was linked is {@link LINKED_AT} unless it says otherwise.
   */
  readonly account?: Partial<LinkedAccount>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Build the services of a test: a clock that does not move, a short synthetic history, and the
 * fixture account linked (unless the test asks for none) with a known link date.
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
    // gives the account a picture or no name. The first statement seeds the plain fixture account
    // first, and this write replaces it.
    await new LinkedAccountRepository(test.database, test.logger).setLinkedAccount(
      testLinkedAccount(options.accountId ?? FIXTURE_ACCOUNT_ID, {
        linkedAt: LINKED_AT,
        profileFetchedAt: NOW,
        ...account,
      }),
    );
  }
  return test;
}

/**
 * Synchronise the account of the test, so that it has matches and archived details to delete.
 *
 * @param test - The services of the test.
 */
async function synchronise(test: TestServices): Promise<void> {
  await test.services.sync.syncNow('manual');
  await waitUntilIdle(test.services.sync, SIGN_IN_WAIT_MS);
  // The tests below are about deleting something: make sure there is something to delete.
  await expect(test.services.matches.listRecent(10)).resolves.toMatchObject({
    accountLinked: true,
    total: MATCH_COUNT,
  });
  expect(test.archiveStore.files.size).toBeGreaterThan(0);
}

/**
 * Render the application on a URL.
 *
 * @param test - The services of the test.
 * @param url - The initial URL; the settings by default.
 * @param language - Language of the interface.
 * @returns A simulated user.
 */
async function renderApp(
  test: TestServices,
  url = '/settings',
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
 * The account section of the settings, once the page is there.
 *
 * @param texts - The texts of the language of the interface.
 * @returns The section.
 */
function findSection(texts: Texts = EN): Promise<HTMLElement> {
  return screen.findByRole('region', { name: texts.accountTitle });
}

/**
 * Press Unlink and wait for the confirmation to open.
 *
 * @param user - The simulated user.
 * @param name - The name of the account the confirmation must name.
 * @param texts - The texts of the language of the interface.
 * @returns The confirmation dialog.
 */
async function openConfirmation(
  user: UserEvent,
  name = 'Fixture Player',
  texts: Texts = EN,
): Promise<HTMLDialogElement> {
  await user.click(await screen.findByRole('button', { name: texts.unlinkButton }));
  return screen.findByRole<HTMLDialogElement>('dialog', { name: texts.unlinkTitle(name) });
}

/**
 * A promise the test settles when it decides to.
 *
 * @returns The promise, and the function that settles it.
 */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * Hold the suspension of the synchronisation until the test lets it go. An unlink starts with it,
 * and waits for a synchronisation that is running to end: the account is still linked meanwhile.
 *
 * @param test - The services of the test.
 * @returns A function that lets the unlink go on.
 */
function holdSuspension(test: TestServices): () => void {
  const { sync } = test.services;
  const suspend = sync.suspend.bind(sync);
  const { opened, open } = gate();
  vi.spyOn(sync, 'suspend').mockImplementation(async () => {
    await opened;
    return suspend();
  });
  return open;
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
  const { opened, open } = gate();
  vi.spyOn(archiveStore, 'removeEntry').mockImplementation(async (name) => {
    await opened;
    return removeEntry(name);
  });
  return open;
}

describe('AccountSection', () => {
  describe('with an account linked', () => {
    it('shows the linked account with its avatar, name and link date', async () => {
      const test = await setUp({
        account: {
          avatarBase64: bytesToBase64(FIXTURE_AVATAR_JPEG),
          avatarHash: FIXTURE_AVATAR_HASH,
        },
      });
      await renderApp(test);

      const section = await findSection();
      expect(
        within(section).getByRole('heading', { level: 2, name: EN.accountTitle }),
      ).toBeVisible();
      expect(await within(section).findByText('Fixture Player')).toBeVisible();
      expect(within(section).getByText(EN.linkedOn)).toBeVisible();
      // The picture is decorative (the name is written next to it): an empty `alt`.
      const picture = section.querySelector('img');
      expect(picture).toHaveAttribute('alt', '');
      expect(picture).toHaveAttribute(
        'src',
        `data:image/jpeg;base64,${bytesToBase64(FIXTURE_AVATAR_JPEG)}`,
      );
      expect(within(section).getByRole('button', { name: EN.switchButton })).toBeEnabled();
      expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeEnabled();
      // Linked: the way to link an account is not offered, and nothing has been unlinked.
      expect(screen.queryByRole('button', { name: EN.linkButton })).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows the generic avatar and calls an account without a name a Steam player', async () => {
      const test = await setUp({ account: { personaName: null } });
      const { user } = await renderApp(test);

      const section = await findSection();
      expect(await within(section).findByText('Steam player')).toBeVisible();
      expect(section.querySelector('img')).toBeNull();
      // The warning names the account the same way.
      expect(await openConfirmation(user, 'Steam player')).toBeVisible();
    });

    it('says the account is loading, then shows it', async () => {
      let release: (account: LinkedAccount) => void = () => undefined;
      const answered = new Promise<LinkedAccount>((resolve) => {
        release = resolve;
      });
      vi.spyOn(AccountService.prototype, 'getLinkedAccount').mockReturnValue(answered);
      await renderApp(await setUp());

      const section = await findSection();
      expect(await within(section).findByRole('status')).toHaveTextContent('Loading…');
      // Neither a way out of the account nor an invitation to link one before it is known.
      expect(within(section).queryByRole('button')).not.toBeInTheDocument();

      release(testLinkedAccount(FIXTURE_ACCOUNT_ID, { linkedAt: LINKED_AT }));
      expect(await within(section).findByText('Fixture Player')).toBeVisible();
      expect(within(section).queryByText('Loading…')).not.toBeInTheDocument();
    });

    it('says why the account cannot be read, without offering to link another', async () => {
      vi.spyOn(AccountService.prototype, 'getLinkedAccount').mockRejectedValue(
        new AppError('storage', 'The linked account cannot be read'),
      );
      await renderApp(await setUp());

      const section = await findSection();
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'Local data could not be read or saved.',
      );
      // An account that cannot be read is not one that is missing: linking another one over it could
      // erase the data of the one the app lost.
      expect(within(section).queryByRole('button', { name: EN.linkButton })).toBeNull();
      expect(within(section).queryByRole('button', { name: EN.switchButton })).toBeNull();
    });

    it('offers nothing but the reason when the account cannot be read for another reason', async () => {
      vi.spyOn(AccountService.prototype, 'getLinkedAccount').mockRejectedValue(
        new AppError('unexpected', 'The linked account cannot be read'),
      );
      await renderApp(await setUp());

      const section = await findSection();
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'An unexpected error occurred.',
      );
      // The unlink is the way out of a stored link that is damaged, which is a storage failure only.
      expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('with a link that cannot be read', () => {
    /**
     * Damage the profile of the linked account the way another version of the app could have left
     * it: the table accepts any 40 characters as an avatar hash, only the repository knows it must be
     * hexadecimal. The id of the account stays valid, so the link can be unlinked.
     *
     * @param test - The services of the test.
     */
    async function damageProfile(test: TestServices): Promise<void> {
      await test.database.execute(
        `UPDATE linked_account SET avatar_base64 = 'AAAA', avatar_hash = $1 WHERE id = 1`,
        ['z'.repeat(40)],
      );
      // The profile cannot be read, and the id still can: this is the state the tests are about.
      await expect(test.services.account.getLinkedAccount()).rejects.toMatchObject({
        kind: 'storage',
      });
      await expect(
        new LinkedAccountRepository(test.database, test.logger).currentAccountId(),
      ).resolves.toBe(FIXTURE_ACCOUNT_ID);
    }

    it('says so and still unlinks the account, deleting its data', async () => {
      const test = await setUp();
      await synchronise(test);
      await damageProfile(test);
      const { user } = await renderApp(test);

      const section = await findSection();
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'Local data could not be read or saved.',
      );
      // Linking or switching to another account could erase the data of the one the app lost: only
      // the way out of it is offered.
      expect(within(section).queryByRole('button', { name: EN.linkButton })).toBeNull();
      expect(within(section).queryByRole('button', { name: EN.switchButton })).toBeNull();
      expect(
        within(section)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual([EN.unlinkButton]);

      // The account is not known, so the confirmation calls it "Steam player".
      const dialog = await openConfirmation(user, 'Steam player');
      expect(within(dialog).getByText(EN.unlinkWarning)).toBeVisible();
      // Nothing was deleted by asking.
      expect(test.archiveStore.files.size).toBeGreaterThan(0);

      await user.click(within(dialog).getByRole('button', { name: EN.unlinkConfirm }));

      const outcome = await within(section).findByText(EN.done, {}, { timeout: SIGN_IN_WAIT_MS });
      expect(outcome).toHaveAttribute('role', 'status');
      expect(outcome).not.toHaveTextContent('Some files');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      // The link is gone, so the reason it could not be read is gone with it: the section offers to
      // link an account like after any unlink.
      expect(await within(section).findByText(EN.notLinked)).toBeVisible();
      expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
      expect(within(section).getByRole('button', { name: EN.linkButton })).toBeVisible();
      // And the data really is gone: the link, the matches and the files of the archive.
      await expect(test.services.account.getLinkedAccount()).resolves.toBeNull();
      await expect(test.services.matches.listRecent(10)).resolves.toEqual({
        accountLinked: false,
        total: 0,
        matches: [],
      });
      expect([...test.archiveStore.files.keys()]).toEqual([]);
    });

    it('says why the unlink failed and keeps offering it', async () => {
      const test = await setUp();
      await damageProfile(test);
      vi.spyOn(test.services.account, 'unlink').mockRejectedValue(
        new AppError('unexpected', 'The link cannot be cleared'),
      );
      const { user } = await renderApp(test);

      await user.click(
        within(await openConfirmation(user, 'Steam player')).getByRole('button', {
          name: EN.unlinkConfirm,
        }),
      );

      // The reason the link cannot be read stays, and the failure of the unlink is told beside it.
      const section = await findSection();
      expect(await within(section).findByText('An unexpected error occurred.')).toHaveAttribute(
        'role',
        'alert',
      );
      expect(within(section).getByText('Local data could not be read or saved.')).toBeVisible();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(within(section).queryByText(EN.done)).not.toBeInTheDocument();
      expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeEnabled();
    });
  });

  describe('unlinking', () => {
    it('unlinks after confirmation and deletes the data', async () => {
      const test = await setUp();
      await synchronise(test);
      const { user } = await renderApp(test);

      const dialog = await openConfirmation(user);

      // The confirmation names the account and says what goes. Cancel comes first, so that it is
      // the button that has the focus when the dialog opens.
      expect(within(dialog).getByText(EN.unlinkWarning)).toBeVisible();
      const buttons = within(dialog).getAllByRole('button');
      expect(buttons.map((button) => button.textContent)).toEqual([EN.cancel, EN.unlinkConfirm]);
      // Screen readers read the warning with the button that has the focus, whichever it is.
      for (const button of buttons) {
        expect(button).toHaveAccessibleDescription(EN.unlinkWarning);
      }
      // The confirmation looks like what it does, and its border has one colour only: the loss one.
      expect(buttons[1]).toHaveClass('border-loss', 'text-loss');
      expect(buttons[1]).not.toHaveClass('border-border');
      // Nothing was deleted by asking.
      expect(test.archiveStore.files.size).toBeGreaterThan(0);

      await user.click(within(dialog).getByRole('button', { name: EN.unlinkConfirm }));

      const section = await findSection();
      const outcome = await within(section).findByText(EN.done, {}, { timeout: SIGN_IN_WAIT_MS });
      expect(outcome).toHaveAttribute('role', 'status');
      // Complete: nothing is said about files left behind.
      expect(outcome).not.toHaveTextContent('Some files');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      // The section now offers to link an account, and shows nothing of the one that went.
      expect(within(section).getByText(EN.notLinked)).toBeVisible();
      expect(within(section).getByRole('button', { name: EN.linkButton })).toBeVisible();
      expect(within(section).queryByText('Fixture Player')).not.toBeInTheDocument();
      expect(within(section).queryByRole('button', { name: EN.unlinkButton })).toBeNull();
      // And the data really is gone: the link, the matches and the files of the archive.
      await expect(test.services.account.getLinkedAccount()).resolves.toBeNull();
      await expect(test.services.matches.listRecent(10)).resolves.toEqual({
        accountLinked: false,
        total: 0,
        matches: [],
      });
      expect([...test.archiveStore.files.keys()]).toEqual([]);
    });

    it('says when some files could not be removed yet', async () => {
      const test = await setUp();
      await synchronise(test);
      test.archiveStore.failNextRemove(new Error('The disk is busy'));
      const { user } = await renderApp(test);

      await user.click(
        within(await openConfirmation(user)).getByRole('button', { name: EN.unlinkConfirm }),
      );

      const section = await findSection();
      // The account is unlinked all the same, and the player is told what remains to be done.
      expect(
        await within(section).findByRole('status', {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toHaveTextContent(`${EN.done} ${EN.incomplete}`);
      expect(within(section).getByText(EN.notLinked)).toBeVisible();
      await expect(test.services.account.getLinkedAccount()).resolves.toBeNull();
      // The files the removal failed on are still there: the next start finishes the deletion.
      expect(test.archiveStore.files.size).toBeGreaterThan(0);
    });

    it('keeps everything when the unlink is cancelled', async () => {
      const test = await setUp();
      await synchronise(test);
      const filesBefore = [...test.archiveStore.files.keys()];
      const { user } = await renderApp(test);

      const dialog = await openConfirmation(user);
      await user.click(within(dialog).getByRole('button', { name: EN.cancel }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const section = await findSection();
      expect(within(section).getByText('Fixture Player')).toBeVisible();
      expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeEnabled();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await expect(test.services.account.getLinkedAccount()).resolves.toMatchObject({
        accountId: FIXTURE_ACCOUNT_ID,
      });
      await expect(test.services.matches.listRecent(10)).resolves.toMatchObject({
        accountLinked: true,
        total: MATCH_COUNT,
      });
      expect([...test.archiveStore.files.keys()]).toEqual(filesBefore);
    });

    it('keeps everything when the confirmation is closed with Escape', async () => {
      const test = await setUp();
      const { user } = await renderApp(test);
      const dialog = await openConfirmation(user);

      // Escape: the browser fires `cancel` on the dialog before it closes it.
      fireEvent(dialog, new Event('cancel', { cancelable: true }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await expect(test.services.account.getLinkedAccount()).resolves.not.toBeNull();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      // Opened again, it asks again.
      expect(await openConfirmation(user)).toBeVisible();
    });

    it('closes the confirmation once when one gesture asks to close it twice', async () => {
      const test = await setUp();
      const { user } = await renderApp(test);
      const dialog = await openConfirmation(user);

      // A second Escape in a row: the `cancel` event, then the close the browser makes by itself.
      act(() => {
        fireEvent(dialog, new Event('cancel', { cancelable: true }));
        dialog.close();
      });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const section = await findSection();
      expect(within(section).getByText('Fixture Player')).toBeVisible();
      await expect(test.services.account.getLinkedAccount()).resolves.not.toBeNull();
      expect(await openConfirmation(user)).toBeVisible();
    });

    it('shows no old match after an unlink', async () => {
      const test = await setUp();
      await synchronise(test);
      const { user } = await renderApp(test, '/matches');
      // The matches are on screen, and so in the cache of the page.
      expect(await screen.findByRole('table', { name: 'Most recent matches' })).toBeVisible();

      await user.click(screen.getByRole('link', { name: 'Settings' }));
      await user.click(
        within(await openConfirmation(user)).getByRole('button', { name: EN.unlinkConfirm }),
      );
      await within(await findSection()).findByText(EN.done, {}, { timeout: SIGN_IN_WAIT_MS });
      // The matches are read again when the page comes back, and that read is held: an old row
      // would be there to see for as long as it takes, if the cache had kept it for later.
      const { opened, open } = gate();
      const listRecent = test.services.matches.listRecent.bind(test.services.matches);
      vi.spyOn(test.services.matches, 'listRecent').mockImplementation(async (limit) => {
        await opened;
        return listRecent(limit);
      });
      await user.click(screen.getByRole('link', { name: 'Matches' }));

      expect(await screen.findByRole('heading', { level: 1, name: 'Matches' })).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent('Loading the matches…');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryAllByRole('row')).toHaveLength(0);

      open();

      expect(
        await screen.findByRole('heading', { level: 2, name: 'No account linked' }),
      ).toBeVisible();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('tells the player that the unlink is running, and refuses Escape meanwhile', async () => {
      const test = await setUp();
      await synchronise(test);
      // The unlink starts by waiting for the synchronisation: the account is still linked meanwhile.
      const release = holdSuspension(test);
      const { user } = await renderApp(test);
      const dialog = await openConfirmation(user);

      await user.click(within(dialog).getByRole('button', { name: EN.unlinkConfirm }));

      const progress = await within(dialog).findByRole('status');
      expect(progress).toHaveTextContent('Deleting…');
      // The button that was pressed is disabled now, and a disabled button loses the focus: it goes
      // to the progress, which a screen reader reads, and not to the page behind the dialog.
      expect(progress).toHaveFocus();
      // Nothing can be pressed once the deletion started: the dialog is the only way to stop it
      // before, and there is no stopping it now.
      expect(within(dialog).getByRole('button', { name: EN.cancel })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: EN.unlinkConfirm })).toBeDisabled();
      // Escape is refused: the event is cancelled, so the browser keeps the dialog open.
      const escapeAllowed = fireEvent(dialog, new Event('cancel', { cancelable: true }));
      expect(escapeAllowed).toBe(false);
      expect(screen.getByRole('dialog', { name: EN.unlinkTitle('Fixture Player') })).toBeVisible();
      // The section behind cannot start another operation either, in case the dialog goes away.
      const section = await findSection();
      expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeDisabled();
      expect(within(section).getByRole('button', { name: EN.switchButton })).toBeDisabled();

      release();

      // Done: the dialog closes by itself, and the section tells how it ended.
      const outcome = await within(section).findByText(EN.done, {}, { timeout: SIGN_IN_WAIT_MS });
      expect(outcome).toBeVisible();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(screen.queryByText('Deleting…')).not.toBeInTheDocument();
      // The progress that had the focus is gone, and so is the Unlink button the dialog would give
      // the focus back to: the outcome takes it, right under the heading, instead of the page's
      // `body`.
      await waitFor(() => {
        expect(outcome).toHaveFocus();
      });
      expect(outcome.previousElementSibling).toBe(
        within(section).getByRole('heading', { level: 2, name: EN.accountTitle }),
      );
    });

    it('leaves the focus where the player moved it while the unlink ran', async () => {
      const test = await setUp();
      const release = holdSuspension(test);
      const { user } = await renderApp(test);
      const dialog = await openConfirmation(user);
      await user.click(within(dialog).getByRole('button', { name: EN.unlinkConfirm }));
      await within(dialog).findByText('Deleting…');
      // Anywhere but the `body`: here the language setting, as the player could have gone to it.
      const english = screen.getByRole('radio', { name: 'English' });
      act(() => {
        english.focus();
      });

      release();

      const outcome = await within(await findSection()).findByText(
        EN.done,
        {},
        {
          timeout: SIGN_IN_WAIT_MS,
        },
      );
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(english).toHaveFocus();
      expect(outcome).not.toHaveFocus();
    });

    it('still tells the outcome when the browser closes the dialog while it runs', async () => {
      const test = await setUp();
      await synchronise(test);
      const release = holdArchiveRemoval(test);
      const { user } = await renderApp(test);
      const dialog = await openConfirmation(user);
      await user.click(within(dialog).getByRole('button', { name: EN.unlinkConfirm }));
      await within(dialog).findByText('Deleting…');

      // A second Escape in a row, or a form closing the dialog: a page cannot refuse it.
      act(() => {
        dialog.close();
      });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // The link is cleared already and the files are not: the section behind offers a sign-in, but
      // it would queue behind the deletion, so the button waits for it.
      const section = await findSection();
      expect(await within(section).findByRole('button', { name: EN.linkButton })).toBeDisabled();
      release();

      // The unlink did not stop with the dialog: its outcome is in the section, and the data is gone.
      expect(
        await within(section).findByText(EN.done, {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toHaveAttribute('role', 'status');
      // Read again: the section showed a loading message while the account was read once more.
      await waitFor(() => {
        expect(within(section).getByRole('button', { name: EN.linkButton })).toBeEnabled();
      });
      await expect(test.services.account.getLinkedAccount()).resolves.toBeNull();
      expect([...test.archiveStore.files.keys()]).toEqual([]);
    });

    it('unlinks once when the confirmation is pressed twice in a row', async () => {
      const test = await setUp();
      await synchronise(test);
      test.archiveStore.failNextRemove(new Error('The disk is busy'));
      const unlink = vi.spyOn(test.services.account, 'unlink');
      const { user } = await renderApp(test);
      const confirm = within(await openConfirmation(user)).getByRole('button', {
        name: EN.unlinkConfirm,
      });

      // Two activations before the buttons are drawn as disabled (a double click, a key that
      // repeats): the second one reaches a handler that still believes nothing is running.
      act(() => {
        fireEvent.click(confirm);
        fireEvent.click(confirm);
      });

      // The outcome is the first unlink's. A second one would find nothing left to delete, and say
      // that everything was deleted, over the files the first one failed on.
      expect(
        await within(await findSection()).findByRole('status', {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toHaveTextContent(`${EN.done} ${EN.incomplete}`);
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(test.archiveStore.files.size).toBeGreaterThan(0);
    });

    it('stops saying the account was unlinked once an account is linked again', async () => {
      const test = await setUp();
      const { user } = await renderApp(test);
      await user.click(
        within(await openConfirmation(user)).getByRole('button', { name: EN.unlinkConfirm }),
      );
      const section = await findSection();
      await within(section).findByText(EN.done, {}, { timeout: SIGN_IN_WAIT_MS });

      // The fixture sign-in gives the account of the fixtures again.
      await user.click(within(section).getByRole('button', { name: EN.linkButton }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      // It is about the account that went, not the one that is linked now.
      expect(
        await within(section).findByText('Fixture Player', {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toBeVisible();
      expect(within(section).queryByText(EN.done)).not.toBeInTheDocument();
      expect(within(section).queryByRole('status')).not.toBeInTheDocument();
      expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeEnabled();
      await waitUntilIdle(test.services.sync, SIGN_IN_WAIT_MS);
    });

    it('says why the unlink failed and keeps the account', async () => {
      const test = await setUp();
      vi.spyOn(test.services.account, 'unlink').mockRejectedValue(
        new AppError('storage', 'The link cannot be cleared'),
      );
      const { user } = await renderApp(test);

      await user.click(
        within(await openConfirmation(user)).getByRole('button', { name: EN.unlinkConfirm }),
      );

      const section = await findSection();
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'Local data could not be read or saved.',
      );
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      // Nothing was said of an unlink that did not happen, and the player can try again.
      expect(within(section).queryByText(EN.done)).not.toBeInTheDocument();
      expect(within(section).getByText('Fixture Player')).toBeVisible();
      expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeEnabled();
      await expect(test.services.account.getLinkedAccount()).resolves.not.toBeNull();

      // A new attempt starts from a clean screen: the failure of the last one is not repeated.
      await openConfirmation(user);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('stops telling that the unlink failed once another account is linked', async () => {
      const test = await setUp();
      test.signInGateway.setSteamId64(accountIdToSteamId64(OTHER_ACCOUNT_ID));
      vi.spyOn(test.services.account, 'unlink').mockRejectedValue(
        new AppError('storage', 'The link cannot be cleared'),
      );
      const { user } = await renderApp(test);
      await user.click(
        within(await openConfirmation(user)).getByRole('button', { name: EN.unlinkConfirm }),
      );
      const section = await findSection();
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'Local data could not be read or saved.',
      );

      // The player gives up on unlinking, and switches to another account instead.
      await user.click(within(section).getByRole('button', { name: EN.switchButton }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      // The failure was about the account that went: it is not told under the one that came.
      expect(
        await within(section).findByText('Steam player', {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await waitUntilIdle(test.services.sync, SIGN_IN_WAIT_MS);
    });
  });

  describe('switching to another account', () => {
    it('replaces the account after confirmation', async () => {
      const test = await setUp();
      test.signInGateway.setSteamId64(accountIdToSteamId64(OTHER_ACCOUNT_ID));
      await synchronise(test);
      const { user } = await renderApp(test);
      const section = await findSection();

      await user.click(await within(section).findByRole('button', { name: EN.switchButton }));

      // The warning names the account that goes.
      expect(
        screen.getByText(
          'Linking another account deletes all the data of Fixture Player on this PC: its matches, archived details and history.',
        ),
      ).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      // The new account took the place of the old one; the fixture API knows nothing of its profile.
      expect(
        await within(section).findByText('Steam player', {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toBeVisible();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(within(section).queryByText('Fixture Player')).not.toBeInTheDocument();
      await expect(test.services.account.getLinkedAccount()).resolves.toMatchObject({
        accountId: OTHER_ACCOUNT_ID,
        personaName: null,
      });
      // The data of the account that went is deleted, once the new link was saved.
      await waitUntilIdle(test.services.sync, SIGN_IN_WAIT_MS);
      const oldFolder = `${archiveFolder(FIXTURE_ACCOUNT_ID)}/`;
      expect(
        [...test.archiveStore.files.keys()].filter((path) => path.startsWith(oldFolder)),
      ).toEqual([]);
      await expect(test.services.matches.listRecent(10)).resolves.toMatchObject({
        accountLinked: true,
        total: 0,
      });
    });

    it('keeps the account when the player gives up before signing in', async () => {
      const test = await setUp();
      const { user } = await renderApp(test);
      const section = await findSection();

      await user.click(await within(section).findByRole('button', { name: EN.switchButton }));
      await user.click(screen.getByRole('button', { name: EN.cancel }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(within(section).getByText('Fixture Player')).toBeVisible();
      expect(test.signInGateway.openedUrls).toEqual([]);
      await expect(test.services.account.getLinkedAccount()).resolves.toMatchObject({
        accountId: FIXTURE_ACCOUNT_ID,
      });
    });
  });

  describe('while a link is pending', () => {
    it('keeps Unlink and the switch disabled until the link is over', async () => {
      const test = await setUp();
      let finish: (result: LinkResult) => void = () => undefined;
      const finished = new Promise<LinkResult>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(test.services.account, 'link').mockReturnValue(finished);
      const { user } = await renderApp(test);
      const section = await findSection();
      await user.click(await within(section).findByRole('button', { name: EN.switchButton }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      const waiting = await screen.findByRole('status');
      expect(waiting).toHaveTextContent('Waiting for Steam in your browser…');

      // Escape closes the dialog, but a sign-in that Steam already confirmed goes on behind it. The
      // dialog is not the only guard: an unlink now would queue behind that link, and erase the
      // account it is about to link.
      fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeDisabled();
      expect(within(section).getByRole('button', { name: EN.switchButton })).toBeDisabled();

      finish({ kind: 'cancelled' });

      await waitFor(() => {
        expect(within(section).getByRole('button', { name: EN.unlinkButton })).toBeEnabled();
      });
      expect(within(section).getByRole('button', { name: EN.switchButton })).toBeEnabled();
    });
  });

  describe('without an account', () => {
    it('offers to link an account when none is linked', async () => {
      const test = await setUp({ accountId: null });
      const { user } = await renderApp(test);

      const section = await findSection();
      expect(await within(section).findByText(EN.notLinked)).toBeVisible();
      // Nothing to unlink or to switch from; nothing was unlinked either.
      expect(within(section).queryByRole('button', { name: EN.unlinkButton })).toBeNull();
      expect(within(section).queryByRole('button', { name: EN.switchButton })).toBeNull();
      expect(within(section).queryByRole('status')).not.toBeInTheDocument();

      // The button is the real one: it opens the dialog of the sign-in.
      await user.click(within(section).getByRole('button', { name: EN.linkButton }));
      expect(await screen.findByRole('dialog', { name: 'Link your Steam account' })).toBeVisible();
    });
  });

  describe('in French', () => {
    const FR = TEXTS.fr;

    it('speaks French from the account to the outcome of an incomplete unlink', async () => {
      const test = await setUp();
      test.archiveStore.failNextRemove(new Error('The disk is busy'));
      const { user } = await renderApp(test, '/settings', 'fr');

      const section = await findSection(FR);
      expect(
        within(section).getByRole('heading', { level: 2, name: FR.accountTitle }),
      ).toBeVisible();
      expect(await within(section).findByText('Fixture Player')).toBeVisible();
      expect(within(section).getByText(FR.linkedOn)).toBeVisible();
      expect(within(section).getByRole('button', { name: FR.switchButton })).toBeVisible();

      const dialog = await openConfirmation(user, 'Fixture Player', FR);
      expect(within(dialog).getByText(FR.unlinkWarning)).toBeVisible();
      expect(within(dialog).getByRole('button', { name: FR.cancel })).toBeVisible();

      await user.click(within(dialog).getByRole('button', { name: FR.unlinkConfirm }));

      expect(
        await within(section).findByRole('status', {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toHaveTextContent(`${FR.done} ${FR.incomplete}`);
      expect(within(section).getByText(FR.notLinked)).toBeVisible();
      expect(within(section).getByRole('button', { name: FR.linkButton })).toBeVisible();
    });

    it('shows the progress of the unlink in French', async () => {
      const test = await setUp();
      const release = holdArchiveRemoval(test);
      const { user } = await renderApp(test, '/settings', 'fr');
      const dialog = await openConfirmation(user, 'Fixture Player', FR);

      await user.click(within(dialog).getByRole('button', { name: FR.unlinkConfirm }));

      expect(await within(dialog).findByRole('status')).toHaveTextContent('Suppression…');
      release();
      expect(
        await within(await findSection(FR)).findByText(FR.done, {}, { timeout: SIGN_IN_WAIT_MS }),
      ).toBeVisible();
    });
  });
});
