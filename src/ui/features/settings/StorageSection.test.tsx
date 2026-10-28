/**
 * Tests of the storage section of the settings, rendered with the real providers and the
 * development adapters: an in-memory database holding two archived matches of 2.1 MB each.
 *
 * @packageDocumentation
 */
import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECTION_VERSION } from '../../../core/analysis/registry';
import { AppError } from '../../../core/errors/app-error';
import { ARCHIVE_FORMAT } from '../../../core/match-detail/archive-envelope';
import type { Language } from '../../../core/settings/language';
import { MatchDetailRepository } from '../../../services/match-detail.repository';
import { MatchesRepository } from '../../../services/matches.repository';
import { MetricsRepository } from '../../../services/metrics.repository';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
} from '../../../test/create-test-services';
import { matchSummary, TEST_ACCOUNT_ID, testMatchId } from '../../../test/test-data';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import {
  DETAILS_QUERY_KEY,
  DETAILS_SUMMARY_QUERY_KEY,
  MATCHES_QUERY_KEY,
} from '../matches/use-matches';
import { StorageSection } from './StorageSection';
import { STORAGE_USAGE_QUERY_KEY } from './use-settings';

/** The size every archive of the tests is recorded with: two of them take 4.2 MB. */
const ARCHIVE_BYTES = 2_100_000;

/**
 * Record archived Paige matches in the database of the test, as a synchronisation leaves them.
 *
 * @param test - The services of the test, built for {@link TEST_ACCOUNT_ID}.
 * @param ids - The numbers of the matches to record.
 * @param bytes - The size each archive is recorded with.
 */
async function archiveMatches(
  test: TestServices,
  ids: readonly number[],
  bytes = ARCHIVE_BYTES,
): Promise<void> {
  await new MatchesRepository(test.database).upsertMany(
    ids.map((matchId) => matchSummary({ matchId, startTime: 1_790_000_000 + matchId * 60 })),
  );
  const details = new MatchDetailRepository(test.database);
  for (const matchId of ids) {
    await details.markReady(TEST_ACCOUNT_ID, testMatchId(matchId), bytes, ARCHIVE_FORMAT);
  }
}

/** The size of each archive of {@link archiveOldMatches}: 45 of them take 135 MB. */
const OLD_ARCHIVE_BYTES = 3_000_000;

/** The start time of the oldest match of {@link archiveOldMatches}, in Unix seconds (in 2020). */
const OLD_START_TIME = 1_600_000_000;

/**
 * Record archived Paige matches that an eviction may take: older than 90 days, with their metrics
 * of the current version stored. Of 45 of them, the 40 newest are protected, so five can go.
 *
 * @param test - The services of the test, built for {@link TEST_ACCOUNT_ID}.
 * @param count - How many matches to record, numbered 1 (the oldest) to `count`.
 */
async function archiveOldMatches(test: TestServices, count: number): Promise<void> {
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  await new MatchesRepository(test.database).upsertMany(
    ids.map((matchId) => matchSummary({ matchId, startTime: OLD_START_TIME + matchId * 60 })),
  );
  const details = new MatchDetailRepository(test.database);
  const metrics = new MetricsRepository(test.database);
  for (const matchId of ids) {
    await details.markReady(
      TEST_ACCOUNT_ID,
      testMatchId(matchId),
      OLD_ARCHIVE_BYTES,
      ARCHIVE_FORMAT,
    );
    await metrics.saveProjection(
      TEST_ACCOUNT_ID,
      testMatchId(matchId),
      {
        version: PROJECTION_VERSION,
        playerBadge: null,
        hasLeaver: false,
        failed: false,
        projectedAt: Date.now(),
      },
      new Map(),
    );
  }
}

/**
 * Render the section for a player with two archives, or without an account.
 *
 * @param options - `language` of the interface (English by default), `linked` (`true` by default;
 *   a player that is not linked has no archive to show), `archiveBytes`, the size of each archive
 *   ({@link ARCHIVE_BYTES} by default) and `oldArchives`, how many archives older than 90 days to
 *   record instead of the two (see {@link archiveOldMatches}).
 * @returns The services of the test and the query client of the section.
 */
async function renderSection(
  options: {
    language?: Language;
    linked?: boolean;
    archiveBytes?: number;
    oldArchives?: number;
  } = {},
) {
  const { language = 'en', linked = true, archiveBytes = ARCHIVE_BYTES, oldArchives } = options;
  const test = createTestServices({ accountId: linked ? TEST_ACCOUNT_ID : null });
  if (linked && oldArchives !== undefined) {
    await archiveOldMatches(test, oldArchives);
  } else if (linked) {
    await archiveMatches(test, [1, 2], archiveBytes);
  }
  const queryClient: QueryClient = createTestQueryClient();
  const i18n = await createI18n(language);
  render(
    <AppProviders services={test.services} queryClient={queryClient} i18n={i18n}>
      <StorageSection />
    </AppProviders>,
  );
  return { test, queryClient };
}

describe('StorageSection', () => {
  afterEach(() => {
    // Gives Web Storage back its real `setItem` after the test that breaks it.
    vi.restoreAllMocks();
  });

  it('shows the space used and the cap', async () => {
    await renderSection();

    const section = await screen.findByRole('region', { name: 'Storage' });
    // One decimal under 10 MB for the space used, a whole number for the cap.
    expect(within(section).getByText('4.2 MB used of 500 MB')).toBeInTheDocument();
    expect(within(section).getByLabelText('Limit')).toHaveValue('500');
    // The mean archive is 2.1 MB: 500 MB hold 238 of them.
    expect(within(section).getByText('About 238 matches fit in this limit.')).toBeInTheDocument();
  });

  it('writes the sizes in the language of the interface', async () => {
    await renderSection({ language: 'fr' });

    const section = await screen.findByRole('region', { name: 'Stockage' });
    // French writes the decimal comma and "Mo", with a no-break space the matcher folds.
    expect(within(section).getByText('4,2 Mo utilisés sur 500 Mo')).toBeInTheDocument();
    expect(within(section).getByLabelText('Limite')).toHaveValue('500');
    expect(
      within(section).getByText('Environ 238 parties tiennent dans cette limite.'),
    ).toBeInTheDocument();
  });

  it('says "match" in the singular when the limit holds one', async () => {
    // Archives of 300 MB: 500 MB hold one of them.
    await renderSection({ archiveBytes: 300_000_000 });

    expect(await screen.findByText('About 1 match fits in this limit.')).toBeInTheDocument();
  });

  it('says "partie" in the singular when the limit holds one', async () => {
    await renderSection({ language: 'fr', archiveBytes: 300_000_000 });

    expect(
      await screen.findByText('Environ 1 partie tient dans cette limite.'),
    ).toBeInTheDocument();
  });

  it('groups the thousands of the capacity in English', async () => {
    // Archives of 40 kB: 500 MB hold 12,500 of them.
    await renderSection({ archiveBytes: 40_000 });

    expect(await screen.findByText('About 12,500 matches fit in this limit.')).toBeInTheDocument();
  });

  it('groups the thousands of the capacity in French, with the narrow no-break space', async () => {
    await renderSection({ language: 'fr', archiveBytes: 40_000 });

    // The grouping separator comes from `Intl.NumberFormat('fr')` (U+202F in current engines), so the
    // expected text is built with it rather than with a literal character.
    const grouped = new Intl.NumberFormat('fr').format(12_500);
    expect(grouped).not.toBe('12500');
    // The matcher folds every white space of the page into a plain space, so fold the expected one too.
    const folded = grouped.replace(/\s/g, ' ');
    expect(
      await screen.findByText(`Environ ${folded} parties tiennent dans cette limite.`),
    ).toBeInTheDocument();
  });

  it('offers one option per preset, written with the unit', async () => {
    await renderSection();

    const limit = await screen.findByLabelText('Limit');
    expect(
      within(limit)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['100 MB', '250 MB', '500 MB', '1,000 MB', '2,000 MB', '5,000 MB']);
  });

  it('changes the cap and shows the new capacity', async () => {
    const user = userEvent.setup();
    const { test } = await renderSection();
    const limit = await screen.findByLabelText('Limit');

    await user.selectOptions(limit, '100');

    // 100 MB hold 47 archives of 2.1 MB.
    expect(await screen.findByText('About 47 matches fit in this limit.')).toBeInTheDocument();
    expect(screen.getByText('4.2 MB used of 100 MB')).toBeInTheDocument();
    expect(screen.getByLabelText('Limit')).toHaveValue('100');
    await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 100 });
  });

  it('shows the pick while the change saves, ignores another pick and keeps the focus', async () => {
    const user = userEvent.setup();
    const { test } = await renderSection();
    const limit = await screen.findByLabelText('Limit');
    // Hold the save until the test lets it go.
    const save = test.services.storage.setCap.bind(test.services.storage);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setCap = vi.spyOn(test.services.storage, 'setCap').mockImplementation(async (capMb) => {
      await gate;
      return save(capMb);
    });

    await user.selectOptions(limit, '250');

    expect(await screen.findByText('Saving…')).toBeInTheDocument();
    // Not disabled, so the focus stays on the select; it shows the limit being saved.
    expect(limit).toBeEnabled();
    expect(limit).toHaveFocus();
    expect(limit).toHaveValue('250');
    // A pick made meanwhile is ignored: it does not save, and the select keeps showing 250.
    await user.selectOptions(limit, '1000');
    expect(setCap).toHaveBeenCalledTimes(1);
    expect(setCap).toHaveBeenCalledWith(250);
    expect(limit).toHaveValue('250');
    release();
    await waitFor(() => {
      expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
    });
    expect(limit).toHaveFocus();
    expect(limit).toHaveValue('250');
    await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 250 });
  });

  it('says why and goes back to the saved cap when the change fails', async () => {
    const user = userEvent.setup();
    await renderSection();
    const limit = await screen.findByLabelText('Limit');
    // The development store writes to Web Storage: make it fail like a full disk would.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    await user.selectOptions(limit, '100');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.getByLabelText('Limit')).toHaveValue('500');
    expect(screen.getByLabelText('Limit')).toBeEnabled();
  });

  it('keeps the figures and the select, with the error above, when a later read fails', async () => {
    const { test, queryClient } = await renderSection();
    await screen.findByText('4.2 MB used of 500 MB');
    vi.spyOn(test.services.storage, 'getUsage').mockRejectedValue(
      new AppError('storage', 'The database is damaged'),
    );

    // As a synchronisation does when it ends.
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.getByText('4.2 MB used of 500 MB')).toBeInTheDocument();
    expect(screen.getByLabelText('Limit')).toHaveValue('500');
    expect(screen.getByText('About 238 matches fit in this limit.')).toBeInTheDocument();
  });

  it('says the newest archives are protected', async () => {
    await renderSection();

    expect(
      await screen.findByText(
        'The archives of your last 90 days and of your last 40 matches are never removed.',
      ),
    ).toBeInTheDocument();
  });

  it('says the newest archives are protected, in French', async () => {
    await renderSection({ language: 'fr' });

    expect(
      await screen.findByText(
        'Les archives de tes 90 derniers jours et de tes 40 dernières parties ne sont jamais supprimées.',
      ),
    ).toBeInTheDocument();
  });

  it('reads the usage again when the details change, as after a synchronisation', async () => {
    const { test, queryClient } = await renderSection();
    await screen.findByText('4.2 MB used of 500 MB');

    await archiveMatches(test, [3]);
    // What a synchronisation and the detail queue invalidate: the usage sits under it.
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });

    expect(await screen.findByText('6.3 MB used of 500 MB')).toBeInTheDocument();
  });

  it('is not shown without a linked account', async () => {
    const { queryClient } = await renderSection({ linked: false });

    await waitFor(() => {
      expect(queryClient.getQueryState(STORAGE_USAGE_QUERY_KEY)?.status).toBe('success');
    });
    expect(screen.queryByRole('region', { name: 'Storage' })).not.toBeInTheDocument();
  });

  describe('lowering the limit', () => {
    it('saves a raise at once, without a preview or a dialog', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection();
      const limit = await screen.findByLabelText('Limit');
      const preview = vi.spyOn(test.services.storage, 'previewEviction');

      await user.selectOptions(limit, '1000');

      await waitFor(() => {
        expect(screen.getByLabelText('Limit')).toHaveValue('1000');
        expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
      });
      expect(preview).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 1000 });
    });

    it('saves a lowering that removes nothing at once, without a dialog', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection();
      const limit = await screen.findByLabelText('Limit');
      const preview = vi.spyOn(test.services.storage, 'previewEviction');

      await user.selectOptions(limit, '100');

      expect(await screen.findByText('About 47 matches fit in this limit.')).toBeInTheDocument();
      expect(preview).toHaveBeenCalledWith(100);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 100 });
    });

    it('says it is checking while it reads what a lower limit would remove', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection();
      const limit = await screen.findByLabelText('Limit');
      let answer: (preview: null) => void = () => undefined;
      vi.spyOn(test.services.storage, 'previewEviction').mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );

      await user.selectOptions(limit, '100');

      expect(await screen.findByText('Checking…')).toBeInTheDocument();
      expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
      answer(null);
      await waitFor(() => {
        expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
      });
    });

    it('asks first when the lowering removes archives, with their count and size', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection({ oldArchives: 45 });
      const limit = await screen.findByLabelText('Limit');
      const setCap = vi.spyOn(test.services.storage, 'setCap');

      await user.selectOptions(limit, '100');

      // 135 MB of archives under a 100 MB limit: the five oldest that are not protected would go.
      const dialog = await screen.findByRole('dialog', { name: 'Lower the limit?' });
      expect(
        within(dialog).getByText(
          'About 5 archives older than 90 days will be removed (15 MB). Their figures stay, but their timeline, damage and players will not come back.',
        ),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(
        within(dialog).getByRole('button', { name: 'Remove and lower the limit' }),
      ).toBeInTheDocument();
      // Nothing is saved yet, and the select still shows the saved limit.
      expect(setCap).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Limit')).toHaveValue('500');
      await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 500 });
    });

    it('says "archive" in the singular when one would be removed', async () => {
      const user = userEvent.setup();
      await renderSection({ oldArchives: 41 });

      await user.selectOptions(await screen.findByLabelText('Limit'), '100');

      expect(
        await screen.findByText(
          'About 1 archive older than 90 days will be removed (3 MB). Its figures stay, but its timeline, damage and players will not come back.',
        ),
      ).toBeInTheDocument();
    });

    it('asks in French, with the size written in French', async () => {
      const user = userEvent.setup();
      await renderSection({ language: 'fr', oldArchives: 45 });

      await user.selectOptions(await screen.findByLabelText('Limite'), '100');

      const dialog = await screen.findByRole('dialog', { name: 'Baisser la limite ?' });
      // French writes "Mo" after a no-break space, which the matcher folds.
      expect(
        within(dialog).getByText(
          'Environ 5 archives de plus de 90 jours seront supprimées (15 Mo). Leurs chiffres restent, mais leur chronologie, leurs dégâts et leurs joueurs ne reviendront pas.',
        ),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Annuler' })).toBeInTheDocument();
      expect(
        within(dialog).getByRole('button', { name: 'Supprimer et baisser la limite' }),
      ).toBeInTheDocument();
    });

    it('says "archive" in the singular in French', async () => {
      const user = userEvent.setup();
      await renderSection({ language: 'fr', oldArchives: 41 });

      await user.selectOptions(await screen.findByLabelText('Limite'), '100');

      expect(
        await screen.findByText(
          'Environ 1 archive de plus de 90 jours sera supprimée (3 Mo). Ses chiffres restent, mais sa chronologie, ses dégâts et ses joueurs ne reviendront pas.',
        ),
      ).toBeInTheDocument();
    });

    it('keeps the old limit and gives the focus back to the select on Cancel', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection({ oldArchives: 45 });
      const limit = await screen.findByLabelText('Limit');
      const setCap = vi.spyOn(test.services.storage, 'setCap');
      await user.selectOptions(limit, '100');
      const dialog = await screen.findByRole('dialog');

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(limit).toHaveValue('500');
      expect(limit).toHaveFocus();
      expect(setCap).not.toHaveBeenCalled();
      await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 500 });
    });

    it('keeps the old limit and gives the focus back to the select on Escape', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection({ oldArchives: 45 });
      const limit = await screen.findByLabelText('Limit');
      const setCap = vi.spyOn(test.services.storage, 'setCap');
      await user.selectOptions(limit, '100');
      const dialog = await screen.findByRole('dialog');

      // Escape: the browser fires `cancel` on the dialog before it closes it.
      fireEvent(dialog, new Event('cancel', { cancelable: true }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(limit).toHaveValue('500');
      expect(limit).toHaveFocus();
      expect(setCap).not.toHaveBeenCalled();
      await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 500 });
    });

    it('saves the limit and removes the archives on "Remove and lower the limit"', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection({ oldArchives: 45 });
      const limit = await screen.findByLabelText('Limit');
      await user.selectOptions(limit, '100');
      const dialog = await screen.findByRole('dialog');

      await user.click(within(dialog).getByRole('button', { name: 'Remove and lower the limit' }));

      // 135 MB minus the five archives that went.
      expect(await screen.findByText('120 MB used of 100 MB')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Limit')).toHaveValue('100');
      expect(limit).toHaveFocus();
      await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 100 });
      await expect(test.services.storage.previewEviction(100)).resolves.toEqual({
        evicted: 0,
        freedBytes: 0,
      });
    });

    it('ignores a pick made while the dialog is open', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection({ oldArchives: 45 });
      const limit = await screen.findByLabelText('Limit');
      const preview = vi.spyOn(test.services.storage, 'previewEviction');
      const setCap = vi.spyOn(test.services.storage, 'setCap');
      await user.selectOptions(limit, '100');
      await screen.findByRole('dialog');

      await user.selectOptions(limit, '250');

      expect(preview).toHaveBeenCalledTimes(1);
      expect(setCap).not.toHaveBeenCalled();
      // The dialog is still about the first pick.
      expect(screen.getByRole('dialog', { name: 'Lower the limit?' })).toBeInTheDocument();
      expect(limit).toHaveValue('500');
    });

    it('ignores a pick made while the preview is read', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection({ oldArchives: 45 });
      const limit = await screen.findByLabelText('Limit');
      const read = test.services.storage.previewEviction.bind(test.services.storage);
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const preview = vi
        .spyOn(test.services.storage, 'previewEviction')
        .mockImplementation(async (capMb) => {
          await gate;
          return read(capMb);
        });
      const setCap = vi.spyOn(test.services.storage, 'setCap');

      await user.selectOptions(limit, '100');
      await waitFor(() => {
        expect(preview).toHaveBeenCalledTimes(1);
      });
      // Not disabled, so the focus stays on the select; it shows the pick being read.
      expect(limit).toBeEnabled();
      expect(limit).toHaveFocus();
      expect(limit).toHaveValue('100');
      await user.selectOptions(limit, '250');
      expect(preview).toHaveBeenCalledTimes(1);
      release();

      // The first pick is the one that asks.
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/About 5 archives/)).toBeInTheDocument();
      expect(setCap).not.toHaveBeenCalled();
    });

    it('says why and keeps the saved limit when the preview fails', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection({ oldArchives: 45 });
      const limit = await screen.findByLabelText('Limit');
      vi.spyOn(test.services.storage, 'previewEviction').mockRejectedValue(
        new AppError('storage', 'The database is damaged'),
      );
      const setCap = vi.spyOn(test.services.storage, 'setCap');

      await user.selectOptions(limit, '100');

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Local data could not be read or saved.',
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Limit')).toHaveValue('500');
      expect(setCap).not.toHaveBeenCalled();
    });

    it('does not repeat the failure of a preview beside a later pick that saves', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection();
      const limit = await screen.findByLabelText('Limit');
      vi.spyOn(test.services.storage, 'previewEviction').mockRejectedValueOnce(
        new AppError('storage', 'The database is damaged'),
      );
      await user.selectOptions(limit, '100');
      expect(await screen.findByRole('alert')).toBeInTheDocument();

      // A raise saves with no preview, which would have replaced the error: it must go away too.
      await user.selectOptions(limit, '1000');

      await waitFor(() => {
        expect(screen.getByLabelText('Limit')).toHaveValue('1000');
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await expect(test.services.settings.get()).resolves.toMatchObject({ storageCapMb: 1000 });
    });

    it('saves at once when there is no linked account to preview', async () => {
      const user = userEvent.setup();
      const { test } = await renderSection();
      const limit = await screen.findByLabelText('Limit');
      vi.spyOn(test.services.storage, 'previewEviction').mockResolvedValue(null);
      const setCap = vi.spyOn(test.services.storage, 'setCap');

      await user.selectOptions(limit, '100');

      await waitFor(() => {
        expect(setCap).toHaveBeenCalledWith(100);
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('reads the counts of the banner and the matches again after a change', async () => {
      const user = userEvent.setup();
      const { queryClient } = await renderSection();
      const limit = await screen.findByLabelText('Limit');
      // As if the banner and the match list were on screen: queries that hold figures.
      const historyKey = [...MATCHES_QUERY_KEY, 'history', null, null];
      queryClient.setQueryData(DETAILS_SUMMARY_QUERY_KEY, { ready: 2 });
      queryClient.setQueryData(historyKey, []);

      await user.selectOptions(limit, '100');

      await waitFor(() => {
        expect(queryClient.getQueryState(DETAILS_SUMMARY_QUERY_KEY)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true);
      });
    });
  });
});
