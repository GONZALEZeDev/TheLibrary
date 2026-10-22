/**
 * Tests of the analysis on the match detail screen, rendered inside the whole application (router,
 * shell, providers) on the development adapters: synthetic deadlock-api, in-memory database and
 * archive. The rest of the page (header, explanations, retry, tabs) is tested in
 * `MatchDetailPage.test.tsx`, and the helpers both files use are in `src/test/match-detail-page.tsx`.
 *
 * Most tests synchronise a small synthetic history first, like the application does, and work out
 * what the page must show from what the services say of the match, never from numbers written in
 * the tests. The analysis of an archived match is checked against what the analysis service says of
 * the match once the page has asked for the community data, with the synthetic deadlock-api held
 * back where a test must see the page before the data comes, and the states of the analysis that
 * the fixtures do not reach for real (`failed`, `not_analysed`, a refresh that fails) played by a
 * service that answers them. The synchronisation analyses every match it archives; a match that is
 * archived and not projected yet (the tests delete the projections) is analysed when its page
 * opens, behind a dialog: those tests hold the analysis back, or make it fail, to see the page in
 * between, in both languages, and the way back to the list from that page. The small history fits
 * in the window of the habits of its newest match; the test of a match analysed as part of the
 * window of a later one synchronises a longer history ({@link LONG_MATCH_COUNT}) and goes from one
 * page to the other, as a player does.
 *
 * @packageDocumentation
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createFixtureApi,
  type FixtureHandler,
} from '../../../adapters/dev/fixture-http-client.adapter';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
} from '../../../adapters/dev/fixtures/match-history.fixture';
import type { Insight } from '../../../core/analysis/insights/insights';
import { PERSONAL_WINDOW } from '../../../core/analysis/insights/thresholds';
import { PHASE_STATS, type PhaseStat } from '../../../core/analysis/phases';
import type { MatchId } from '../../../core/domain/match';
import { AppError } from '../../../core/errors/app-error';
import type { MatchAnalysis } from '../../../services/analysis-view';
import type { AppServices } from '../../../services/app-services';
import { MetricsRepository } from '../../../services/metrics.repository';
import { createTestQueryClient, type TestServices } from '../../../test/create-test-services';
import {
  ANALYSING_STRINGS,
  ARCHIVE_LINE_START,
  ARCHIVED_ID,
  ARCHIVED_IDS,
  ARCHIVED_ROW,
  archived,
  archivedIdsOf,
  archivedView,
  expectedHeader,
  findArchiveLine,
  headerFactsOfRow,
  holdAnalysisBack,
  lockArchive,
  MATCH_COUNT,
  MISSING_ID,
  normalizeSpaces,
  NOW,
  readHeader,
  renderMatchDetail,
  settle,
  SETTLE_MS,
  STRINGS,
  synchronised,
} from '../../../test/match-detail-page';
import { formatDuration } from '../../format/duration';
import { createI18n } from '../../i18n/i18n';
import { DETAILS_QUERY_KEY } from '../matches/use-matches';
import { formatPhaseTotal, metricLabel } from './analysis-format';

/**
 * Size of the synthetic history of the test that opens a match inside the window of the habits of
 * another one: 80 matches, of which 23 are archived Paige matches. That is more than the newest
 * match and the 20 matches of its window, so the window of the next match holds a match that the
 * analysis of the newest one does not project.
 */
const LONG_MATCH_COUNT = 80;

/** The matches the queue archives from the history of {@link LONG_MATCH_COUNT} matches. */
const LONG_ARCHIVED_IDS = archivedIdsOf(
  createMatchHistoryFixture({ now: NOW, count: LONG_MATCH_COUNT }),
);

/** The start of the path of every community request of the synthetic API. */
const COMMUNITY_PATH_PREFIX = '/v1/analytics/';

/**
 * Tell how many community requests (the sizes of a cohort, its benchmarks, its curve) the synthetic
 * API was asked for.
 *
 * @param testServices - The services of the test.
 * @returns The number of community requests so far.
 */
function communityRequestCount({ http }: TestServices): number {
  return http.requests.filter((request) =>
    new URL(request.url).pathname.startsWith(COMMUNITY_PATH_PREFIX),
  ).length;
}

/**
 * Hold the community requests of the synthetic API back until the test lets them through, so that
 * the page can be seen between the local analysis and the community data. Requests of any other kind
 * (the history, the details, the rank) are answered at once.
 *
 * @returns The handler to give the services, and the means to let the community data through.
 */
function holdCommunityBack(): { readonly handler: FixtureHandler; readonly release: () => void } {
  const fixtures = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    handler: async (request) => {
      if (new URL(request.url).pathname.startsWith(COMMUNITY_PATH_PREFIX)) {
        await released;
      }
      return fixtures(request);
    },
    release,
  };
}

/**
 * Hold every analysis back until the test lets it go, each one in its turn: unlike
 * {@link holdAnalysisBack}, whose analyses all go once it lets them, an analysis asked for after a
 * release waits for the next one. Once let go, the analysis is the service's own.
 *
 * @param services - The services of the test.
 * @returns The spy on the analysis, and the means to let go the analyses that wait.
 */
function holdEveryAnalysisBack(services: AppServices): {
  readonly analyse: MockInstance<AppServices['analysis']['analyseMatch']>;
  readonly release: () => void;
} {
  const analyseMatch = services.analysis.analyseMatch.bind(services.analysis);
  const waiting: (() => void)[] = [];
  const analyse = vi
    .spyOn(services.analysis, 'analyseMatch')
    .mockImplementation(async (matchId) => {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
      return analyseMatch(matchId);
    });
  return {
    analyse,
    release: () => {
      for (const letGo of waiting.splice(0)) {
        letGo();
      }
    },
  };
}

/**
 * What the analysis service says of a match that must be analysed.
 *
 * @param services - The services of the test.
 * @param matchId - The match.
 * @returns The analysis, with whatever community data the cache holds by now.
 */
async function readyAnalysis(services: AppServices, matchId: MatchId): Promise<MatchAnalysis> {
  const view = await services.analysis.getMatchAnalysis(matchId);
  if (view.kind !== 'ready') {
    return expect.unreachable(`The match should be analysed, but its view is ${view.kind}`);
  }
  return view.analysis;
}

/** The name of a gauge: a metric compared with the rank says its place in words. */
const GAUGE_NAME = /^Percentile /;

/**
 * Wait until the page compares the match with the community: the data has been asked for, stored,
 * and the analysis read again, so that the gauges are drawn.
 */
async function findComparison(): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByRole('img', { name: GAUGE_NAME }).length).toBeGreaterThan(0);
  });
}

/**
 * Check the pills of one side of the summary.
 *
 * @param listName - The name of the list, as the page says it.
 * @param arrow - The arrow of the side.
 * @param word - The hidden word of the side.
 * @param insights - The insights the service gives for the side, strongest first.
 * @param t - Translation function of the language of the page.
 */
function expectPills(
  listName: string,
  arrow: string,
  word: string,
  insights: readonly Insight[],
  t: TFunction,
): void {
  if (insights.length === 0) {
    // A side with nothing to say has no list.
    expect(screen.queryByRole('list', { name: listName })).not.toBeInTheDocument();
    return;
  }
  const pills = within(screen.getByRole('list', { name: listName })).getAllByRole('listitem');
  expect(pills.map((pill) => normalizeSpaces(pill.textContent))).toEqual(
    insights.map((insight) => `${arrow}${metricLabel(insight.key, t, 'en')}${word}`),
  );
}

/**
 * Get one cell of the phase table.
 *
 * @param figure - The name of the figure, as the row header says it.
 * @param column - The place of the phase among the columns, from 0.
 * @returns The cell.
 */
function phaseCell(figure: string, column: number): HTMLElement {
  const row =
    screen.getByRole('rowheader', { name: figure }).closest('tr') ??
    expect.unreachable('A row header sits in a row');
  return within(row).getAllByRole('cell')[column] ?? expect.unreachable('The row has no such cell');
}

/**
 * Press Tab until the focus reaches an element: the way a keyboard user gets to a row of the page.
 *
 * @param user - The simulated user.
 * @param target - The element to reach.
 */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement): Promise<void> {
  const MAX_STOPS = 60;
  for (let stop = 0; stop < MAX_STOPS && document.activeElement !== target; stop += 1) {
    await user.tab();
  }
  expect(target).toHaveFocus();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MatchDetailPage analysis', () => {
  it('a ready Paige match shows the summary, the phase table and the families', async () => {
    const testServices = await synchronised();
    const view = await archivedView(testServices.services, ARCHIVED_ID);
    const { t } = await createI18n('en');

    await renderMatchDetail(ARCHIVED_ID, testServices);
    await findComparison();

    // What the page shows is what the service says of the match, with the community data in.
    const analysis = await readyAnalysis(testServices.services, ARCHIVED_ID);
    expect(analysis.community.kind).toBe('available');
    // The synthetic match stands out somewhere: the checks of the summary are not empty ones.
    expect(analysis.strengths.length + analysis.weaknesses.length).toBeGreaterThan(0);

    // The header comes first, the analysis under it, and the archive line ends the page. The header
    // and the line are text: the only table of the page is the one of the phases.
    await waitFor(() => {
      expect(readHeader()).toEqual(expectedHeader('en', headerFactsOfRow(ARCHIVED_ROW)));
    });
    expect(await findArchiveLine('en', view)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(Array.from(main.querySelectorAll('dl, table')).map((part) => part.tagName)).toEqual([
      'TABLE',
    ]);
    // The headings go down one level at a time: the page, then the analysis (one hidden title, the
    // layouts show none), then the families. The header and the archive line add none.
    expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual([
      'H1',
      'H2',
      ...analysis.families.map(() => 'H3'),
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'Analysis' })).toHaveClass('sr-only');

    // The summary: strengths then weaknesses, as pills.
    expectPills('Strengths', '▲', 'strength', analysis.strengths, t);
    expectPills('Weaknesses', '▼', 'weakness', analysis.weaknesses, t);
    expect(screen.queryByText('Nothing stands out in this match.')).not.toBeInTheDocument();

    // The phase table: the phases the match reached, the four figures, and their totals.
    const table = screen.getByRole('table', { name: 'By phase' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(
      analysis.phases.map(
        ({ span }) =>
          `${t(`analysis.phase.${span.phase}`)} · ${formatDuration(span.startS)} → ${formatDuration(span.endS)}`,
      ),
    );
    const figureNames = (stat: PhaseStat): string => t(`analysis.phaseStat.${stat}`);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((header) => header.textContent),
    ).toEqual(PHASE_STATS.map(figureNames));
    for (const stat of PHASE_STATS) {
      analysis.phases.forEach((column, index) => {
        expect(phaseCell(figureNames(stat), index)).toHaveTextContent(
          formatPhaseTotal(column.cells[stat].total, stat, 'en'),
        );
      });
    }

    // The families: their titles in order, each over the metrics of its family.
    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual(
      analysis.families.map(({ family }) => t(`analysis.family.${family}`)),
    );
    for (const { family, rows } of analysis.families) {
      const section = screen.getByRole('region', { name: t(`analysis.family.${family}`) });
      expect(
        within(section)
          .getAllByRole('group')
          .map((row) => row.getAttribute('aria-label')),
      ).toEqual(rows.map((row) => metricLabel(row.key, t, 'en')));
    }
    // The title heads the whole analysis: the summary, the table and every family are in its section.
    const analysisSection = screen.getByRole('region', { name: 'Analysis' });
    expect(
      within(analysisSection).getAllByRole('list', { name: /^(Strengths|Weaknesses)$/ }),
    ).toHaveLength(
      [analysis.strengths, analysis.weaknesses].filter((side) => side.length > 0).length,
    );
    expect(analysisSection).toContainElement(table);
    expect(within(analysisSection).getAllByRole('heading', { level: 3 })).toHaveLength(
      analysis.families.length,
    );
    // The line that says whom the match is compared with, and no waiting for the data any more.
    expect(screen.getByText(/^Compared with Paige players/)).toBeInTheDocument();
    expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
  });

  it('evidence shows on focus and hides on Escape', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();
    await renderMatchDetail(ARCHIVED_ID, testServices);
    await findComparison();

    // A row of the families, reached with the keyboard.
    const row = screen.getByRole('group', { name: 'KDA' });
    const panel = within(row).getByRole('tooltip');
    await tabTo(user, row);

    // The focus describes the row by its evidence and opens the panel.
    expect(row).toHaveAttribute('aria-describedby', panel.id);
    expect(row).toHaveAccessibleDescription(/Percentile (\d+|< 1|> 99) of your rank/);
    expect(row).toHaveAccessibleDescription(/reference matches|Not enough data yet/);
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');

    await user.keyboard('{Escape}');

    expect(row).toHaveFocus();
    expect(panel).toHaveClass('hidden');
    expect(panel).not.toHaveClass('group-focus-visible:block');
    expect(panel).not.toHaveClass('group-hover:block');

    // The same goes for a cell of the phase table.
    const cell = within(phaseCell('Souls', 0)).getByRole('group', { name: 'Souls at 10:00' });
    const cellPanel = within(cell).getByRole('tooltip');
    await tabTo(user, cell);

    // Leaving the row opened its panel again, and the cell opens its own.
    expect(panel).toHaveClass('group-hover:block', 'group-focus-visible:block');
    expect(cell).toHaveAttribute('aria-describedby', cellPanel.id);
    expect(cellPanel).toHaveClass('group-hover:block', 'group-focus-visible:block');

    await user.keyboard('{Escape}');

    expect(cellPanel).toHaveClass('hidden');
    expect(cellPanel).not.toHaveClass('group-focus-visible:block');
    // The presses of Tab through the whole page take about three seconds on their own, and more
    // while the other test files run beside this one: the default five seconds are too tight.
  }, 15_000);

  it('a waiting match shows no analysis', async () => {
    const testServices = await synchronised();
    const read = vi.spyOn(testServices.services.analysis, 'getMatchAnalysis');
    const refresh = vi.spyOn(testServices.services.analysis, 'refreshCommunity');

    await renderMatchDetail(MISSING_ID, testServices);

    expect(await screen.findByText(STRINGS.en.waiting)).toBeInTheDocument();
    expect(screen.queryByText('Analysis in progress…')).not.toBeInTheDocument();
    expect(screen.queryByText('This match could not be analysed.')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The analysis is not even asked for.
    expect(read).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the community part loads after the local analysis', async () => {
    const { handler, release } = holdCommunityBack();
    const testServices = await synchronised({ handler });

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices);

      // The local analysis is on the page while the community data is still on its way.
      expect(await screen.findByRole('table', { name: 'By phase' })).toBeInTheDocument();
      expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
      // The line above the families says so, once; the metrics that have a reference in the
      // community wait with a dash.
      const waiting = await screen.findAllByText('Loading the comparison with your rank…');
      expect(waiting).toHaveLength(1);
      expect(within(screen.getByRole('group', { name: 'KDA' })).getByText('—')).toBeInTheDocument();
      expect(screen.queryAllByRole('img', { name: GAUGE_NAME })).toEqual([]);
      expect(screen.queryByText('No comparison with your rank for now')).not.toBeInTheDocument();
    } finally {
      // Whatever the assertions said, the data comes: a failing test leaves no download blocked.
      release();
    }

    await findComparison();
    expect(communityRequestCount(testServices)).toBeGreaterThan(0);
    expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
    expect(screen.getByText(/^Compared with Paige players/)).toBeInTheDocument();
  });

  it('does not say the comparison is loading while it asks again about a cohort that is too small', async () => {
    const testServices = await synchronised();
    const analysis = await readyAnalysis(testServices.services, ARCHIVED_ID);
    // The cache holds no data here: play a service whose data was downloaded and holds too few
    // matches, which leaves every comparison with the community missing.
    const read = vi.spyOn(testServices.services.analysis, 'getMatchAnalysis').mockResolvedValue({
      kind: 'ready',
      analysis: { ...analysis, community: { kind: 'unavailable' } },
    });
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi
      .spyOn(testServices.services.analysis, 'refreshCommunity')
      .mockImplementation(async () => {
        await released;
        return 'fresh';
      });

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices);

      // The page asks again, as it does at every opening, and the answer is on its way...
      expect(await screen.findByRole('table', { name: 'By phase' })).toBeInTheDocument();
      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
      });
      // ... but it is not data that is coming, so nothing says it is loading. The line above the
      // families says there is no comparison, once; the metrics are a dash.
      expect(screen.getByText('No comparison with your rank for now')).toBeInTheDocument();
      expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }

    // The answer is `fresh`, which may mean that another page stored the data meanwhile: the
    // analysis is read again, once. The view is still without data here, and the page does not ask
    // again for it: no loop.
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says there is no comparison for now, and shows no error, when the community data cannot be refreshed', async () => {
    const testServices = await synchronised();
    vi.spyOn(testServices.services.analysis, 'refreshCommunity').mockRejectedValue(
      new AppError('storage', 'The community data cannot be saved'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The analysis stays, compared with the habits of the player only.
    expect(await screen.findByRole('table', { name: 'By phase' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('No comparison with your rank for now')).toBeInTheDocument();
    });
    expect(screen.queryByText('Loading the comparison with your rank…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('img', { name: GAUGE_NAME })).toEqual([]);
    // The failure is logged by the query client, with the name of the query and not its parameters.
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'query')).toMatchObject([
      { level: 'error', context: { kind: 'storage' } },
    ]);
  });

  it('asks again for the community data when the cache only holds a day-old copy', async () => {
    // The clock of the services moves on by hand: the data is downloaded now, the page opens 25
    // hours later.
    let clock = NOW;
    const testServices = await synchronised({ now: () => clock });
    await expect(testServices.services.analysis.refreshCommunity(ARCHIVED_ID)).resolves.toBe(
      'updated',
    );
    const requestsBefore = communityRequestCount(testServices);
    clock = NOW + 25 * 60 * 60_000;

    await renderMatchDetail(ARCHIVED_ID, testServices);

    // The copy of the cache is shown at once, dated since it is stale...
    expect(await screen.findByText(/^Compared with Paige players.*\(from /)).toBeInTheDocument();
    // ... and the page downloads a new one, which is not dated.
    await waitFor(() => {
      expect(screen.getByText(/^Compared with Paige players/)).not.toHaveTextContent('(from ');
    });
    expect(communityRequestCount(testServices)).toBeGreaterThan(requestsBefore);
  });

  it('says when the analysis of a match cannot be made', async () => {
    const testServices = await synchronised();
    vi.spyOn(testServices.services.analysis, 'getMatchAnalysis').mockResolvedValue({
      kind: 'failed',
    });
    const refresh = vi.spyOn(testServices.services.analysis, 'refreshCommunity');

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(await screen.findByText('This match could not be analysed.')).toBeInTheDocument();
    expect(screen.getByText(ARCHIVE_LINE_START.en)).toBeInTheDocument();
    expect(screen.queryByText('Analysis in progress…')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Nothing to compare: nothing is downloaded.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows nothing of the analysis of a match there is nothing to analyse in', async () => {
    const testServices = await synchronised();
    const read = vi
      .spyOn(testServices.services.analysis, 'getMatchAnalysis')
      .mockResolvedValue({ kind: 'not_analysed' });
    const refresh = vi.spyOn(testServices.services.analysis, 'refreshCommunity');

    await renderMatchDetail(ARCHIVED_ID, testServices);

    await screen.findByText(ARCHIVE_LINE_START.en);
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
    // Not even a sentence: the header above and the archive line say all there is to say.
    expect(screen.queryByText('This match could not be analysed.')).not.toBeInTheDocument();
    expect(screen.queryByText('Analysis in progress…')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows the error of the analysis like any other, and keeps the archive line', async () => {
    const testServices = await synchronised();
    vi.spyOn(testServices.services.analysis, 'getMatchAnalysis').mockRejectedValue(
      new AppError('storage', 'The analysis cannot be read'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.getByText(ARCHIVE_LINE_START.en)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('speaks French', async () => {
    const testServices = await synchronised();
    const { t } = await createI18n('fr');

    await renderMatchDetail(ARCHIVED_ID, testServices, { language: 'fr' });
    await findComparison();

    const analysis = await readyAnalysis(testServices.services, ARCHIVED_ID);
    expect(screen.getByRole('heading', { level: 2, name: 'Analyse' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Par phase' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual(
      analysis.families.map(({ family }) => t(`analysis.family.${family}`)),
    );
    expect(screen.getByText(/^Comparé aux joueurs de Paige/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'KDA' })).toHaveAccessibleDescription(
      /Percentile (\d+|< 1|> 99) de ton rang/,
    );
    expect(screen.queryByText('By phase')).not.toBeInTheDocument();
  });
});

describe('MatchDetailPage analysis start', () => {
  it('the analysis is started once', async () => {
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analyse, release } = holdAnalysisBack(testServices.services);

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
      await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });

      // The page reads what it shows again while the analysis runs, as a synchronisation makes it
      // do: the view is still `pending`, and the analysis is not asked for a second time.
      await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
      await settle();
      expect(analyse).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await findComparison();

    // Nor is it once the analysis is shown, whatever reads the page again.
    await testServices.services.sync.syncNow('manual');
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
    await settle();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
  });

  it.each([
    // The view is read after the section mounted: the start is not in the replay of the mount.
    { opening: 'the first opening of the page', cached: false },
    // The view is in the cache already, `pending` still (a page opened again after an attempt that
    // was refused): the section starts the analysis as it mounts, which StrictMode then replays.
    { opening: 'a page opened again with the view in the cache', cached: true },
  ])(
    'is started once inside StrictMode, which replays the effects, and the dialog closes onto the analysis: $opening',
    async ({ cached }) => {
      const testServices = await archived();
      const queryClient = createTestQueryClient(testServices.logger);
      if (cached) {
        queryClient.setQueryData([...DETAILS_QUERY_KEY, 'analysis', ARCHIVED_ID], {
          kind: 'pending',
        });
      }
      const { analyse, release } = holdAnalysisBack(testServices.services);

      try {
        await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient, strict: true });

        // StrictMode mounts the effects, unmounts them and mounts them again: the start survives the
        // replay (the ref does), and the dialog is open once.
        await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });
        await settle();
        expect(analyse).toHaveBeenCalledTimes(1);
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
      } finally {
        release();
      }

      // The dialog closes onto the analysis, still one call.
      expect(
        await screen.findByRole('table', { name: ANALYSING_STRINGS.en.phaseTable }),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(screen.queryByText(ANALYSING_STRINGS.en.pending)).not.toBeInTheDocument();
      expect(analyse).toHaveBeenCalledTimes(1);
      expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
      await findComparison();
    },
  );

  it('does not analyse a match that is projected already', async () => {
    const testServices = await synchronised();
    const analyse = vi.spyOn(testServices.services.analysis, 'analyseMatch');

    await renderMatchDetail(ARCHIVED_ID, testServices);
    await findComparison();

    // The view is `ready` from the first read: there is nothing to start, and no dialog.
    expect(analyse).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not close the dialog while the analysis runs', async () => {
    const testServices = await archived();
    const { release } = holdAnalysisBack(testServices.services);

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices);
      const dialog = await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });

      // Escape asks the dialog to close, and the page refuses: the analysis cannot be given up.
      const notPrevented = fireEvent(dialog, new Event('cancel', { cancelable: true }));
      await settle();

      expect(notPrevented).toBe(false);
      expect(screen.getByRole('dialog', { name: ANALYSING_STRINGS.en.dialog })).toBeVisible();
    } finally {
      release();
    }
    await findComparison();
  });

  it('closes the dialog of a failed analysis on Escape too', async () => {
    const testServices = await archived();
    vi.spyOn(testServices.services.analysis, 'analyseMatch').mockRejectedValue(
      new AppError('storage', 'The match could not be analysed'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);
    const dialog = await screen.findByRole('dialog', { name: ANALYSING_STRINGS.en.dialog });
    await within(dialog).findByText(ANALYSING_STRINGS.en.failed);

    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText(ANALYSING_STRINGS.en.cannotAnalyse)).toHaveAttribute('role', 'status');
  });

  it('says that the analysis failed even when the browser closed the dialog by itself', async () => {
    const testServices = await archived();
    const { release } = holdAnalysisBack(
      testServices.services,
      new AppError('storage', 'The match could not be analysed'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices);
    const dialog = await screen.findByRole<HTMLDialogElement>('dialog', {
      name: ANALYSING_STRINGS.en.dialog,
    });
    // The sentence of the analysis in progress is a live region, and it is the one that will say it.
    const sentence = screen.getByText(ANALYSING_STRINGS.en.pending);
    expect(sentence).toHaveAttribute('role', 'status');

    // A second Escape in a row: the browser closes the dialog without asking the page, which
    // ignores the close while the analysis runs (see `Dialog`).
    act(() => {
      dialog.close();
    });
    release();

    // The failure is not lost with the dialog: the same live region now says it.
    await waitFor(() => {
      expect(sentence).toHaveTextContent(ANALYSING_STRINGS.en.cannotAnalyse);
    });
    expect(sentence).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a refusal because the account is changing leaves the section pending, without an error', async () => {
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { sync } = testServices.services;
    // An account change is under way: the section the analysis runs in refuses new work.
    await sync.suspend();
    const requestsBefore = communityRequestCount(testServices);
    const analyse = vi.spyOn(testServices.services.analysis, 'analyseMatch');

    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
    await waitFor(() => {
      expect(analyse).toHaveBeenCalledTimes(1);
    });
    await expect(analyse.mock.results[0]?.value).rejects.toMatchObject({
      context: { reason: 'suspended' },
    });
    await settle();

    // Not a failure: no error, no dialog, the sentence of an analysis that is not there yet. The
    // archive line is shown, and none of the analysis.
    expect(screen.getByText(ANALYSING_STRINGS.en.pending)).toBeInTheDocument();
    expect(screen.getByText(ARCHIVE_LINE_START.en)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(ANALYSING_STRINGS.en.cannotAnalyse)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Strengths' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'mutation')).toEqual([]);
    // There is nothing to compare yet: nothing is downloaded for it.
    expect(communityRequestCount(testServices)).toBe(requestsBefore);

    // The account change is over and the queries are reset (see `resetAccountData`): the next read
    // of the view starts the analysis again.
    sync.resume();
    await queryClient.resetQueries({ queryKey: [...DETAILS_QUERY_KEY, 'analysis'] });

    expect(
      await screen.findByRole('table', { name: ANALYSING_STRINGS.en.phaseTable }),
    ).toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(2);
    await findComparison();
  });

  it('analyses the newest match, then a match of its window, behind the dialog both times', async () => {
    const user = userEvent.setup();
    const strings = ANALYSING_STRINGS.en;
    const testServices = await archived({
      handler: createFixtureApi({ now: NOW, matchCount: LONG_MATCH_COUNT }),
    });
    const [newest = expect.unreachable(), inside = expect.unreachable()] = LONG_ARCHIVED_IDS;
    expect(
      LONG_ARCHIVED_IDS.length,
      'a match is left out of the window of the newest one',
    ).toBeGreaterThan(1 + PERSONAL_WINDOW);
    const { analyse, release } = holdEveryAnalysisBack(testServices.services);

    await renderMatchDetail(newest, testServices);
    await screen.findByRole('dialog', { name: strings.dialog });
    release();
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await findComparison();

    // Back to the list, and on to the next match. The analysis of the newest one projected it, but
    // not the whole window of its own habits: the page analyses it, behind the dialog again.
    await user.click(screen.getByRole('link', { name: strings.back }));
    await screen.findByRole('heading', { level: 1, name: strings.listTitle });
    await user.click(
      screen
        .getAllByRole('link')
        .find((link) => link.getAttribute('href') === `/matches/${String(inside)}`) ??
        expect.unreachable('the list links to the match'),
    );
    await screen.findByRole('dialog', { name: strings.dialog });
    expect(screen.getByText(strings.pending)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    release();

    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(analyse.mock.calls).toEqual([[newest], [inside]]);
    // Its habits are a full window, for a metric every match knows.
    const { families } = await readyAnalysis(testServices.services, inside);
    const kda = families.flatMap((family) => family.rows).find((row) => row.key === 'kda');
    expect(kda?.personal?.count).toBe(PERSONAL_WINDOW);
    await findComparison();
    // It archives a long history and analyses two full windows: about 2 s alone, more than the
    // default 5 s when the whole suite runs in parallel.
  }, 30_000);

  it('starts the analysis again on a page left open while the account changes', async () => {
    const strings = ANALYSING_STRINGS.en;
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analysis } = testServices.services;
    const { analyse, release } = holdEveryAnalysisBack(testServices.services);
    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
    await screen.findByRole('dialog', { name: strings.dialog });
    release();
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();

    // The link moves to an account that holds the match too (a match the two players played
    // together), archived and not analysed yet: erasing the analysis rows plays it.
    await new MetricsRepository(testServices.database).deleteAccount(FIXTURE_ACCOUNT_ID);
    // The account change resets the queries (see `resetAccountData`), and the read that follows
    // takes a moment, as it does on the database of the desktop app: the section is left without a
    // view in between, the section staying where it is.
    const getMatchAnalysis = analysis.getMatchAnalysis.bind(analysis);
    let letReadGo = (): void => undefined;
    const readHeld = new Promise<void>((resolve) => {
      letReadGo = resolve;
    });
    vi.spyOn(analysis, 'getMatchAnalysis').mockImplementation(async (matchId) => {
      await readHeld;
      return getMatchAnalysis(matchId);
    });
    const reset = queryClient.resetQueries({ queryKey: [...DETAILS_QUERY_KEY, 'analysis'] });
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: strings.phaseTable })).not.toBeInTheDocument();
    });
    letReadGo();
    await act(async () => {
      await reset;
    });

    // The view of the account linked now is `pending`: its analysis starts, behind the dialog.
    await screen.findByRole('dialog', { name: strings.dialog });
    release();
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(2);
    await findComparison();
  });

  it('keeps the analysis of a match whose window holds a match that cannot be projected', async () => {
    const strings = ANALYSING_STRINGS.en;
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analysis } = testServices.services;
    lockArchive(testServices, ARCHIVED_IDS[1] ?? expect.unreachable('a match is in the window'));
    const analyse = vi.spyOn(analysis, 'analyseMatch');
    const refresh = vi.spyOn(analysis, 'refreshCommunity');

    await renderMatchDetail(ARCHIVED_ID, testServices, { queryClient });
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    // The page asks for the community data, then reads the analysis again. The window of the habits
    // is still incomplete, so that read says `pending`, and nothing is downloaded.
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    await expect(refresh.mock.results[0]?.value).resolves.toBe('fresh');
    await settle();
    await expect(analysis.getMatchAnalysis(ARCHIVED_ID)).resolves.toEqual({ kind: 'pending' });

    // The page keeps the analysis, and does not ask for it again: the next opening of the page
    // tries the window again.
    const expectAnalysisKept = (moment: string): void => {
      expect(screen.getByRole('table', { name: strings.phaseTable }), moment).toBeInTheDocument();
      expect(screen.queryByText(strings.pending), moment).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog'), moment).not.toBeInTheDocument();
      expect(analyse, moment).toHaveBeenCalledTimes(1);
    };
    expectAnalysisKept('after the community refresh');
    // Nor when a synchronisation reads the page again.
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
    await settle();
    expectAnalysisKept('after a synchronisation');
  });
});

describe.each(['en', 'fr'] as const)('MatchDetailPage analysing dialog in %s', (language) => {
  const strings = ANALYSING_STRINGS[language];

  it('a match not analysed yet shows the analysing dialog, then its analysis', async () => {
    const testServices = await archived();
    const { analyse, release } = holdAnalysisBack(testServices.services);

    try {
      await renderMatchDetail(ARCHIVED_ID, testServices, { language });

      // The dialog says what is going on. It has no button: the analysis cannot be given up.
      const dialog = await screen.findByRole('dialog', { name: strings.dialog });
      expect(dialog).toBeVisible();
      expect(within(dialog).getByText(strings.body)).toBeInTheDocument();
      expect(within(dialog).queryByRole('button')).not.toBeInTheDocument();
      // The archive line is on the page behind it, and the analysis is not there yet.
      await screen.findByText(ARCHIVE_LINE_START[language]);
      expect(screen.getByText(strings.pending)).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      // The headings go down one level at a time while the dialog is open: the page, then the title
      // of the dialog (the title of the analysis, hidden, is only there once the analysis is).
      expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual([
        'H1',
        'H2',
      ]);
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(strings.dialog);
    } finally {
      release();
    }

    // The analysis is shown, and the dialog goes away with the sentence of the analysis in progress.
    expect(await screen.findByRole('table', { name: strings.phaseTable })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(strings.pending)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.cannotAnalyse)).not.toBeInTheDocument();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse).toHaveBeenCalledWith(ARCHIVED_ID);
    await findComparison();
  });

  it('an analysis error says so and keeps the archive line', async () => {
    const user = userEvent.setup();
    const testServices = await archived();
    const queryClient = createTestQueryClient(testServices.logger);
    const { analyse, release } = holdAnalysisBack(
      testServices.services,
      new AppError('storage', 'The match could not be analysed: its projection was not stored'),
    );

    await renderMatchDetail(ARCHIVED_ID, testServices, { language, queryClient });
    const dialog = await screen.findByRole('dialog', { name: strings.dialog });
    expect(within(dialog).getByText(strings.body)).toBeInTheDocument();
    // The sentence of the analysis is one live region: its text changes, and says it failed.
    const sentence = screen.getByText(strings.pending);
    expect(sentence).toHaveAttribute('role', 'status');
    release();

    // The dialog says it, in place of what it said while it ran, and offers to close.
    expect(await within(dialog).findByText(strings.failed)).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(strings.failed);
    expect(within(dialog).queryByText(strings.body)).not.toBeInTheDocument();
    const close = within(dialog).getByRole('button', { name: strings.close });
    // The focus is on the button, so that the keyboard closes the dialog without a search.
    expect(close).toHaveFocus();

    await user.click(close);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // The page keeps its archive line and says that the match could not be analysed, in the live
    // region that said the analysis was in progress.
    expect(screen.getByText(ARCHIVE_LINE_START[language])).toBeInTheDocument();
    expect(screen.getByText(strings.cannotAnalyse)).toBe(sentence);
    expect(sentence).toHaveAttribute('role', 'status');
    expect(screen.queryByText(strings.pending)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // No second attempt, not even when the page reads its view again (the match is still
    // `pending`): opening the page again is what tries again.
    await queryClient.invalidateQueries({ queryKey: DETAILS_QUERY_KEY });
    await settle();
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(strings.cannotAnalyse)).toBeInTheDocument();
    // The failure is logged once, by the query client, with the kind and the name of the mutation.
    expect(testServices.logger.entries.filter((entry) => entry.scope === 'mutation')).toMatchObject(
      [{ level: 'error', context: { kind: 'storage', mutation: 'details.analyse' } }],
    );
  });

  it('the back link goes to the match list', async () => {
    const user = userEvent.setup();
    const testServices = await synchronised();

    await renderMatchDetail(ARCHIVED_ID, testServices, { language });

    const link = await screen.findByRole('link', { name: strings.back });
    // It comes before the title of the page.
    expect(link.compareDocumentPosition(screen.getByRole('heading', { level: 1 }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(link).toHaveAttribute('href', '/matches');

    await user.click(link);

    expect(
      await screen.findByRole('heading', { level: 1, name: strings.listTitle }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: strings.back })).not.toBeInTheDocument();
  });
});
