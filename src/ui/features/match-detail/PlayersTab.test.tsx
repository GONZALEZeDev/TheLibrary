/**
 * Tests of the players tab of the match page, rendered on their own with views built by hand (the
 * view the breakdown service gives is tested with the service), in English and in French.
 *
 * The page reads the view through the services of the app, so each test gives the service the view it
 * wants to show: the tab, its hook, the query client and the translations are the real ones. The
 * numbers are synthetic and chosen so that each one is told from the others in the page; the heroes
 * carry the names the game gives them, which stay in English in both languages.
 *
 * @packageDocumentation
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { AppError } from '../../../core/errors/app-error';
import type { StatPlace } from '../../../core/match-detail/scoreboard';
import type { Language } from '../../../core/settings/language';
import type { AppServices } from '../../../services/app-services';
import type {
  PlayerRowView,
  PlayersTabView,
  TeamView,
} from '../../../services/match-breakdown-view';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { testMatchId } from '../../../test/test-data';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { PlayersTab } from './PlayersTab';

/** The match of the tests. */
const MATCH_ID = testMatchId(100_000_001);

/** The minus sign the page writes before a negative number. */
const MINUS = '−';

/** Where the images of the catalogues live: the one origin the app lets the page load pictures from. */
const IMAGE_ORIGIN = 'https://assets-bucket.deadlock-api.com/';

/** The team of the tracked player in the tests, and the one they play against: not in numeric order. */
const TRACKED_TEAM = 1;
const ENEMY_TEAM = 0;

/** The view of a scoreboard that can be shown. */
type ReadyPlayersView = Extract<PlayersTabView, { readonly kind: 'ready' }>;

/**
 * Build a player of the scoreboard: an average Oracle, unless overridden.
 *
 * @param slot - The slot of the player; 1 to 6 are on the tracked team, 7 to 12 on the other.
 * @param heroName - The English name of their hero, which also makes the name of its picture.
 * @param overrides - Fields to change.
 * @returns The player.
 */
function testPlayer(
  slot: number,
  heroName: string,
  overrides: Partial<PlayerRowView> = {},
): PlayerRowView {
  return {
    slot,
    team: slot <= 6 ? TRACKED_TEAM : ENEMY_TEAM,
    heroId: 1_000 + slot,
    kills: 5,
    deaths: 5,
    assists: 5,
    netWorth: 30_000,
    lastHits: 150,
    denies: 5,
    heroDamage: 15_000,
    objectiveDamage: 5_000,
    support: 0,
    mvpRank: null,
    badge: 32,
    isTracked: false,
    heroName,
    heroImageUrl: `${IMAGE_ORIGIN}heroes/${heroName.toLowerCase()}.webp`,
    rankName: 'Oracle 2',
    rankImageUrl: `${IMAGE_ORIGIN}ranks/oracle.webp`,
    ...overrides,
  };
}

/**
 * Build the two teams of a match, in the order the service gives them: the tracked player's first,
 * each by slot. The tracked team has the lower team number the other way round, so that a page that
 * sorted by team would be caught.
 *
 * @param overrides - Fields to change, by slot of the player.
 * @returns The teams: the tracked team won.
 */
function testTeams(overrides: Readonly<Record<number, Partial<PlayerRowView>>> = {}): TeamView[] {
  const player = (slot: number, heroName: string, fields: Partial<PlayerRowView> = {}) =>
    testPlayer(slot, heroName, { ...fields, ...overrides[slot] });
  return [
    {
      team: TRACKED_TEAM,
      won: true,
      players: [
        // The tracked player: second in Valve's top three, a Sentinel 4.
        player(1, 'Paige', {
          isTracked: true,
          mvpRank: 2,
          kills: 6,
          deaths: 4,
          assists: 14,
          netWorth: 38_212,
          lastHits: 214,
          denies: 3,
          heroDamage: 23_594,
          objectiveDamage: 13_300,
          support: 6_540,
          rankName: 'Sentinel 4',
          rankImageUrl: `${IMAGE_ORIGIN}ranks/sentinel.webp`,
        }),
        player(2, 'Haze', { mvpRank: 1, rankName: 'Sentinel 6' }),
        // The rank catalogue has no badge for this rank: the name is shown alone.
        player(3, 'Abrams', { rankName: 'Archon 1', rankImageUrl: null }),
        // The catalogue has no portrait for this hero: the name is shown alone.
        player(4, 'Dynamo', { heroImageUrl: null }),
        // A player in their placement matches has no rank yet.
        player(5, 'Bebop', { rankName: null, rankImageUrl: null }),
        player(6, 'Calico'),
      ],
    },
    {
      team: ENEMY_TEAM,
      won: false,
      players: [
        player(7, 'Seven', { mvpRank: 3, rankName: 'Sentinel 5' }),
        player(8, 'Lash'),
        player(9, 'Vindicta'),
        player(10, 'Wraith'),
        player(11, 'Yamato'),
        player(12, 'Viscous'),
      ],
    },
  ];
}

/**
 * The places of the tracked player: a good one with a gap above the mean, a worse one below it, and
 * one with no gap (the mean of the players is 0, so there is nothing to compare with).
 */
function testPlaces(): StatPlace[] {
  return [
    { stat: 'netWorth', place: 5, of: 12, gapToMean: -0.03 },
    { stat: 'heroDamage', place: 3, of: 12, gapToMean: 0.18 },
    { stat: 'objectiveDamage', place: 2, of: 12, gapToMean: 0.41 },
    { stat: 'support', place: 1, of: 12, gapToMean: null },
    { stat: 'lastHits', place: 6, of: 12, gapToMean: -0.07 },
  ];
}

/**
 * Build a view that is ready: a ranked match with a top three, the teams and places of the tests.
 *
 * @param overrides - Fields to change.
 * @returns The view.
 */
function readyView(overrides: Partial<ReadyPlayersView> = {}): ReadyPlayersView {
  return {
    kind: 'ready',
    teams: testTeams(),
    places: testPlaces(),
    hasTopThree: true,
    ranked: true,
    ...overrides,
  };
}

/**
 * Change every player of some teams.
 *
 * @param teams - The teams.
 * @param change - Gives the player that replaces each player.
 * @returns The teams, with the players changed.
 */
function mapPlayers(
  teams: readonly TeamView[],
  change: (player: PlayerRowView) => PlayerRowView,
): TeamView[] {
  return teams.map((team) => ({ ...team, players: team.players.map(change) }));
}

/**
 * Build the view of a match that is not ranked: no player has a rank.
 *
 * @param overrides - Fields to change.
 * @returns The view.
 */
function unrankedView(overrides: Partial<ReadyPlayersView> = {}): ReadyPlayersView {
  const teams = mapPlayers(testTeams(), (player) => ({
    ...player,
    rankName: null,
    rankImageUrl: null,
  }));
  return readyView({ teams, ranked: false, ...overrides });
}

/** What a render of the tab gives back to a test. */
interface Rendered {
  /** The root of the render: empty when the tab shows nothing. */
  readonly container: HTMLElement;
  /** The spy on the service call that gives the view. */
  readonly read: MockInstance<AppServices['breakdown']['getPlayersTab']>;
}

/**
 * Render the tab for a match whose players view is the one given, and wait until it has been read.
 *
 * @param view - The view the service gives, or the error it fails with.
 * @param language - The language of the interface; English by default.
 * @returns The root of the render and the spy on the service.
 */
async function renderPlayersTab(
  view: PlayersTabView | AppError,
  language: Language = 'en',
): Promise<Rendered> {
  const { services } = createTestServices();
  const read = vi.spyOn(services.breakdown, 'getPlayersTab');
  if (view instanceof AppError) {
    read.mockRejectedValue(view);
  } else {
    read.mockResolvedValue(view);
  }
  const queryClient = createTestQueryClient();
  const i18n = await createI18n(language);
  const { container } = render(
    <AppProviders services={services} queryClient={queryClient} i18n={i18n}>
      <PlayersTab matchId={MATCH_ID} />
    </AppProviders>,
  );
  // The view is read from the service, so it comes a moment after the first render.
  await waitFor(() => {
    expect(read).toHaveBeenCalledWith(MATCH_ID);
    expect(queryClient.isFetching()).toBe(0);
  });
  return { container, read };
}

/**
 * Write every space of a text as a plain one. The catalogue's own spaces (before a colon, say) are
 * plain already; the no-break ones are those `Intl` writes in French, before a percent sign and as
 * the separator of the thousands.
 *
 * @param text - The text.
 * @returns The text, with the plain spaces of the expectations.
 */
function plainSpaces(text: string | null): string | undefined {
  return text?.replaceAll(/\s/g, ' ');
}

/**
 * Find the two tables of the page.
 *
 * @returns The table of the tracked player's team, then the other.
 */
function bothTables(): [HTMLElement, HTMLElement] {
  const [yours, enemy, ...others] = screen.getAllByRole('table');
  if (yours === undefined || enemy === undefined || others.length > 0) {
    return expect.unreachable('The page has two tables');
  }
  return [yours, enemy];
}

/**
 * Find the row of a player.
 *
 * @param heroName - The name of their hero, as the page says it.
 * @returns The row of the table.
 */
function rowOf(heroName: string): HTMLElement {
  return screen.getByText(heroName).closest('tr') ?? expect.unreachable(`No row has ${heroName}`);
}

/**
 * Find the text of the cells of a row, the cell of the hero (which heads the row) left out.
 *
 * @param row - The row.
 * @returns The text of each cell, in the order of the columns.
 */
function cellTexts(row: HTMLElement): (string | null)[] {
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

/**
 * Find the names of the columns of a table.
 *
 * @param table - The table.
 * @returns The text of each column header, in the order of the columns.
 */
function columnNames(table: HTMLElement): (string | null)[] {
  return within(table)
    .getAllByRole('columnheader')
    .map((header) => header.textContent);
}

/**
 * Find the width class of each column of a table.
 *
 * @param table - The table.
 * @returns The `class` of each `col` element, in the order of the columns; `null` for a column that
 *   has none (it shares what the others leave).
 */
function columnWidths(table: HTMLElement): (string | null)[] {
  return Array.from(table.querySelectorAll('col')).map((column) => column.getAttribute('class'));
}

/**
 * Find the names of the heroes of a table, in the order of its rows.
 *
 * @param table - The table.
 * @returns The first line of the row header of each row: the name of the hero.
 */
function heroNames(table: HTMLElement): (string | null | undefined)[] {
  return within(table)
    .getAllByRole('rowheader')
    .map((header) => header.querySelector('span')?.textContent);
}

describe('PlayersTab', () => {
  it("shows two tables, the player's team first", async () => {
    await renderPlayersTab(readyView());

    expect(screen.getByRole('heading', { level: 2, name: 'The 12 players' })).toBeInTheDocument();
    const [yours, enemy] = bothTables();
    // Each table is named after its team and the result of the team, in the order of the service.
    expect([yours, enemy].map((table) => table.querySelector('caption')?.textContent)).toEqual([
      'Your team · Win',
      'Enemy team · Loss',
    ]);
    expect(screen.getByRole('table', { name: 'Your team · Win' })).toBe(yours);
    expect(screen.getByRole('table', { name: 'Enemy team · Loss' })).toBe(enemy);
    // The players keep the order of the service: by slot, whatever their team number.
    expect(heroNames(yours)).toEqual(['Paige', 'Haze', 'Abrams', 'Dynamo', 'Bebop', 'Calico']);
    expect(heroNames(enemy)).toEqual(['Seven', 'Lash', 'Vindicta', 'Wraith', 'Yamato', 'Viscous']);
    // The result is a word and a colour: the colour never says it alone.
    expect(within(yours).getByText('Win')).toHaveClass('text-win');
    expect(within(enemy).getByText('Loss')).toHaveClass('text-loss');
  });

  it('names the teams after the tracked player, not after the position of the team in the view', async () => {
    // The enemy team comes first this time: "Your team" follows the player and not the order.
    const teams = testTeams().toReversed();
    await renderPlayersTab(readyView({ teams }));

    const [first, second] = bothTables();
    expect([first, second].map((table) => table.querySelector('caption')?.textContent)).toEqual([
      'Enemy team · Loss',
      'Your team · Win',
    ]);
    expect(heroNames(first)).toContain('Seven');
    expect(heroNames(second)).toContain('Paige');
    expect(screen.getByRole('table', { name: 'Your team · Win' })).toBe(second);
  });

  it('highlights the tracked row and says (you)', async () => {
    await renderPlayersTab(readyView());

    const tracked = rowOf('Paige');
    expect(tracked).toHaveClass('bg-accent/10');
    // The word is on screen: the highlight never says it alone.
    const you = within(tracked).getByText('(you)');
    expect(you).not.toHaveClass('sr-only');
    // Nobody else has the highlight or the word.
    expect(screen.getAllByText('(you)')).toHaveLength(1);
    expect(
      screen.getAllByRole('row').filter((row) => row.classList.contains('bg-accent/10')),
    ).toEqual([tracked]);
  });

  it('shows the top three marks', async () => {
    await renderPlayersTab(readyView());

    // The mark is in the first cell of the row of each player of the top three, and nowhere else.
    const [first] = within(rowOf('Haze')).getAllByRole('cell');
    expect(first).toHaveTextContent('MVP');
    const [second] = within(rowOf('Paige')).getAllByRole('cell');
    expect(second).toHaveTextContent('2nd');
    const [third] = within(rowOf('Seven')).getAllByRole('cell');
    expect(third).toHaveTextContent('3rd');
    expect(screen.getAllByText(/^(MVP|2nd|3rd)$/)).toHaveLength(3);
    for (const hero of ['Abrams', 'Lash', 'Viscous']) {
      expect(within(rowOf(hero)).getAllByRole('cell')[0]).toBeEmptyDOMElement();
    }
    expect(screen.queryByText('No Valve top three for this match.')).not.toBeInTheDocument();
  });

  it('says so when the match has no top three', async () => {
    const teams = mapPlayers(testTeams(), (player) => ({ ...player, mvpRank: null }));
    await renderPlayersTab(readyView({ teams, hasTopThree: false }));

    expect(screen.getByText('No Valve top three for this match.')).toBeInTheDocument();
    expect(screen.queryByText(/^(MVP|2nd|3rd)$/)).not.toBeInTheDocument();
  });

  it('shows the rank column of a ranked match, with the badge and the name of each rank', async () => {
    await renderPlayersTab(readyView());

    const [table] = bothTables();
    expect(columnNames(table)).toEqual([
      "Valve's top three",
      'Rank',
      'Hero',
      'K / D / A',
      'Souls',
      'Hero damage',
      'Objective damage',
      'Healing and barriers',
      // The abbreviation on screen, then its full name for assistive technologies only.
      'LH / DLast hits / denies',
    ]);
    // The column of the marks has a name for assistive technologies only: the pills say it already.
    const top = within(table).getByRole('columnheader', { name: "Valve's top three" });
    expect(top.querySelector('span')).toHaveClass('sr-only');
    // One width for each column, the one of the marks included.
    expect(table.querySelectorAll('col')).toHaveLength(9);
    // The badge of the tier, which is decorative: the rank is written beside it.
    // The rank comes before the hero in a row, so its badge is the first picture.
    const [badge] = rowOf('Paige').querySelectorAll('img');
    expect(within(rowOf('Paige')).getByText('Sentinel 4')).toBeInTheDocument();
    expect(badge).toHaveAttribute('src', `${IMAGE_ORIGIN}ranks/sentinel.webp`);
    // A rank with no badge in the catalogue is shown by its name; a player with no rank, by a dash.
    expect(within(rowOf('Abrams')).getByText('Archon 1')).toBeInTheDocument();
    expect(rowOf('Abrams').querySelectorAll('img')).toHaveLength(1);
    expect(cellTexts(rowOf('Bebop'))[1]).toBe('—');
    expect(screen.queryByText('Unranked match: no rank.')).not.toBeInTheDocument();
  });

  it('hides the rank column in an unranked match', async () => {
    await renderPlayersTab(unrankedView());

    for (const table of screen.getAllByRole('table')) {
      expect(columnNames(table)).toEqual([
        "Valve's top three",
        'Hero',
        'K / D / A',
        'Souls',
        'Hero damage',
        'Objective damage',
        'Healing and barriers',
        'LH / DLast hits / denies',
      ]);
      expect(table.querySelectorAll('col')).toHaveLength(8);
    }
    // One cell less per row: the mark, then the six figures.
    expect(cellTexts(rowOf('Paige'))).toHaveLength(7);
    expect(screen.queryByText('Rank')).not.toBeInTheDocument();
    expect(screen.queryByText('Sentinel 4')).not.toBeInTheDocument();
    expect(screen.getByText('Unranked match: no rank.')).toBeInTheDocument();
  });

  it('names the last hits and denies column in full for assistive technologies', async () => {
    await renderPlayersTab(readyView());

    for (const table of bothTables()) {
      // A screen reader would read "L H slash D" above every cell, and a newer player may not know
      // the abbreviation: the abbreviation is for the eye, the full name for the ear.
      const header = within(table).getByRole('columnheader', { name: 'Last hits / denies' });
      const [abbreviation, full] = Array.from(header.querySelectorAll('span'));
      expect(abbreviation).toHaveTextContent('LH / D');
      expect(abbreviation).toHaveAttribute('aria-hidden', 'true');
      expect(full).toHaveTextContent('Last hits / denies');
      expect(full).toHaveClass('sr-only');
    }
  });

  it('names the last hits and denies column in full in French too, in the words of the game', async () => {
    await renderPlayersTab(readyView(), 'fr');

    for (const table of bothTables()) {
      expect(
        within(table).getByRole('columnheader', { name: 'Last hits / denies' }),
      ).toBeInTheDocument();
    }
  });

  it('keeps the rank, the K / D / A, the figures and the last hits of a player on one line', async () => {
    await renderPlayersTab(readyView());

    // At the smallest window of the app the tables are about 760 px wide and a row is crowded: a
    // rank or a K / D / A broken over two lines is easy to misread.
    const rows = bothTables().flatMap((table) => within(table).getAllByRole('row').slice(1));
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      const cells = within(row).getAllByRole('cell');
      // The mark, the rank, the K / D / A, the four figures and the last hits.
      expect(cells).toHaveLength(8);
      for (const cell of cells) {
        expect(cell).toHaveClass('whitespace-nowrap');
      }
      // The hero heads the row and may wrap: an unexpected long name would otherwise spill into the
      // column beside it.
      expect(within(row).getByRole('rowheader')).not.toHaveClass('whitespace-nowrap');
    }
  });

  it('gives the cells of the tables a denser padding than the phase table of the analysis', async () => {
    await renderPlayersTab(readyView());

    const [table] = bothTables();
    const padded = [
      ...within(table).getAllByRole('cell'),
      ...within(table).getAllByRole('rowheader'),
      // The header of the column of the marks only carries the rule above the row: it has no padding,
      // and no rule at its left.
      ...within(table)
        .getAllByRole('columnheader')
        .filter((header) => header.classList.contains('border-l')),
    ];
    // The mark, the rank, the hero and the six figures of each of the six rows, then the headers.
    expect(padded).toHaveLength(6 * 9 + 8);
    for (const cell of padded) {
      expect(cell).toHaveClass('px-2');
      expect(cell).not.toHaveClass('px-3');
    }
  });

  it('gives both tables the same column widths, so that their columns line up', async () => {
    await renderPlayersTab(readyView());

    const [yours, enemy] = bothTables();
    // A fixed layout makes each column the same share of tables of the same width, whatever the
    // content of their cells: an automatic layout would not line them up.
    for (const table of [yours, enemy]) {
      expect(table).toHaveClass('table-fixed', 'w-full');
    }
    expect(columnWidths(yours)).toEqual(columnWidths(enemy));
    // The mark, the rank, the hero and the K / D / A, then the four figures that share what is left,
    // then the last hits and denies.
    expect(columnWidths(yours)).toEqual([
      'w-[8%]',
      'w-[18%]',
      'w-[16%]',
      'w-[13%]',
      null,
      null,
      null,
      null,
      'w-[10%]',
    ]);
  });

  it('gives the figures of an unranked match what the missing rank column leaves', async () => {
    await renderPlayersTab(unrankedView());

    const [yours, enemy] = bothTables();
    expect(columnWidths(yours)).toEqual(columnWidths(enemy));
    expect(columnWidths(yours)).toEqual([
      'w-[8%]',
      'w-[16%]',
      'w-[13%]',
      null,
      null,
      null,
      null,
      'w-[10%]',
    ]);
  });

  it('writes the figures of a row with the separators of the language', async () => {
    await renderPlayersTab(readyView());

    // The mark, the rank, the K / D / A, the souls, the damage to heroes and to objectives, the
    // support, then the last hits and the denies.
    expect(cellTexts(rowOf('Paige'))).toEqual([
      '2nd',
      'Sentinel 4',
      '6 / 4 / 14',
      '38,212',
      '23,594',
      '13,300',
      '6,540',
      '214 / 3',
    ]);
  });

  it('shows a dash for a figure the archive does not tell', async () => {
    const teams = testTeams({
      4: { heroDamage: null, objectiveDamage: null, support: null },
    });
    await renderPlayersTab(readyView({ teams }));

    // The damage to heroes, the damage to objectives and the support: a dash, never a 0 (which is a
    // figure the archive does tell: the next player gave no support).
    expect(cellTexts(rowOf('Dynamo')).slice(4, 7)).toEqual(['—', '—', '—']);
    expect(cellTexts(rowOf('Calico')).slice(4, 7)).toEqual(['15,000', '5,000', '0']);
  });

  it('shows the places and gaps', async () => {
    await renderPlayersTab(readyView());

    // One pill per figure, in the order of the view, with a real minus sign. The list has a name.
    const list = screen.getByRole('list', { name: 'Your places among the players' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((pill) => pill.textContent),
    ).toEqual([
      `Souls: 5/12 · ${MINUS}3% vs the average`,
      'Hero damage: 3/12 · +18% vs the average',
      'Objective damage: 2/12 · +41% vs the average',
      // The mean is 0: there is nothing to compare with, so the pill has no gap.
      'Healing and barriers: 1/12',
      // The last hits have no column of their own (it holds the denies too): the metric names them.
      `Last hits: 6/12 · ${MINUS}7% vs the average`,
    ]);
  });

  it('shows no places line when the tracked player has no place', async () => {
    await renderPlayersTab(readyView({ places: [] }));

    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('shows the picture of a hero and of a rank only when it has one', async () => {
    await renderPlayersTab(readyView());

    const [badge, portrait] = Array.from(rowOf('Paige').querySelectorAll('img'));
    // The pictures are decorative: the names are written beside them. Their size is given so that the
    // row does not move when they arrive.
    expect(portrait).toHaveAttribute('src', `${IMAGE_ORIGIN}heroes/paige.webp`);
    expect(badge).toHaveAttribute('src', `${IMAGE_ORIGIN}ranks/sentinel.webp`);
    for (const picture of [portrait, badge]) {
      expect(picture).toHaveAttribute('alt', '');
      expect(picture).toHaveAttribute('width');
      expect(picture).toHaveAttribute('height');
    }
    // No portrait: the name alone. No rank at all: no badge either.
    expect(within(rowOf('Dynamo')).getByText('Dynamo')).toBeInTheDocument();
    expect(rowOf('Dynamo').querySelectorAll('img')).toHaveLength(1);
    expect(rowOf('Bebop').querySelectorAll('img')).toHaveLength(1);
  });

  it('shows the name alone when the picture of a hero or of a rank fails to load', async () => {
    await renderPlayersTab(readyView());

    const row = rowOf('Paige');
    const [badge, portrait] = Array.from(row.querySelectorAll('img'));
    if (badge === undefined || portrait === undefined) {
      expect.unreachable('The row shows a badge and a portrait');
    }
    // The pictures live on a remote bucket: offline, the browser would show its broken-image icon.
    fireEvent.error(portrait);
    expect(row.querySelectorAll('img')).toHaveLength(1);
    fireEvent.error(badge);

    // Only the names are left, and no square stands in the place of a picture: twelve squares would
    // read as a broken table. The other rows keep their pictures.
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(within(row).getByText('Paige')).toBeInTheDocument();
    expect(within(row).getByText('Sentinel 4')).toBeInTheDocument();
    expect(rowOf('Haze').querySelectorAll('img')).toHaveLength(2);
  });

  it('falls back to the hero id without the catalogue', async () => {
    const teams = testTeams({
      6: { heroId: 17, heroName: null, heroImageUrl: null },
    });
    await renderPlayersTab(readyView({ teams }));

    // The hero is shown by its id, with no portrait; the rest of the row is untouched.
    const row = screen.getByText('Hero #17').closest('tr');
    expect(row).not.toBeNull();
    expect(row?.querySelectorAll('img')).toHaveLength(1);
    expect(within(row ?? document.body).getByText('Oracle 2')).toBeInTheDocument();
  });

  it('says so when the archive of the match cannot be read', async () => {
    await renderPlayersTab({ kind: 'unreadable' });

    expect(screen.getByText('The archive of this match could not be read.')).toBeInTheDocument();
    // There is nothing else to show: no title, no table.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows nothing for a match that is not archived: the analysis above says why', async () => {
    const { container, read } = await renderPlayersTab({ kind: 'not_archived' });

    // The view was read, and it is the view that says there is nothing to show.
    expect(read).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();

    // The control: after the same wait, a view that is ready has rendered, so the empty page above
    // is the page of the view and not the page before the view came.
    cleanup();
    const ready = await renderPlayersTab(readyView());
    expect(ready.container).not.toBeEmptyDOMElement();
  });

  it('says why the tab could not be read when the service fails', async () => {
    await renderPlayersTab(new AppError('storage', 'The database failed'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows the French labels', async () => {
    await renderPlayersTab(readyView(), 'fr');

    expect(screen.getByRole('heading', { level: 2, name: 'Les 12 joueurs' })).toBeInTheDocument();
    const tables = bothTables();
    expect(tables.map((table) => table.querySelector('caption')?.textContent)).toEqual([
      'Ton équipe · Victoire',
      'Équipe adverse · Défaite',
    ]);
    expect(columnNames(tables[0])).toEqual([
      'Top 3 de Valve',
      'Rang',
      'Héros',
      'K / D / A',
      'Âmes',
      'Dégâts héros',
      'Dégâts obj.',
      'Soins et barrières',
      // The name of the game's figure stays in English in both languages.
      'LH / DLast hits / denies',
    ]);
    // The word of the tracked row, the marks of the top three, and the numbers with the conventions
    // of French.
    const tracked = rowOf('Paige');
    expect(within(tracked).getByText('(toi)')).toBeInTheDocument();
    expect(within(tracked).getByText('2e')).toBeInTheDocument();
    expect(within(rowOf('Haze')).getByText('MVP')).toBeInTheDocument();
    expect(within(rowOf('Seven')).getByText('3e')).toBeInTheDocument();
    expect(within(tracked).getByText('38 212')).toBeInTheDocument();
    // The places and gaps. The list is named, and the page keeps the no-break space `Intl` writes
    // before a percent sign (U+00A0 or U+202F, whichever the ICU data of the engine has): the sign
    // never wraps onto a line of its own. The colon of the catalogue is a plain space.
    expect(screen.getByRole('list', { name: 'Tes places parmi les joueurs' })).toBeInTheDocument();
    const [, damage] = screen.getAllByRole('listitem');
    expect(damage?.textContent).toMatch(
      /^Dégâts héros : 3\/12 · \+18[\u00a0\u202f]% vs la moyenne$/,
    );
    // The rest, with the no-break spaces read as plain ones.
    const pills = screen.getAllByRole('listitem').map((pill) => plainSpaces(pill.textContent));
    expect(pills).toEqual([
      `Âmes : 5/12 · ${MINUS}3 % vs la moyenne`,
      'Dégâts héros : 3/12 · +18 % vs la moyenne',
      'Dégâts obj. : 2/12 · +41 % vs la moyenne',
      'Soins et barrières : 1/12',
      `Last hits : 6/12 · ${MINUS}7 % vs la moyenne`,
    ]);
    // The names of the game stay in English.
    expect(within(tracked).getByText('Sentinel 4')).toBeInTheDocument();
  });

  it('shows the French notes and the French fallback of a hero', async () => {
    // An unranked match with no top three, and a hero the catalogue does not know.
    const teams = mapPlayers(
      testTeams({ 6: { heroId: 17, heroName: null, heroImageUrl: null } }),
      (player) => ({ ...player, mvpRank: null, rankName: null, rankImageUrl: null }),
    );
    await renderPlayersTab(readyView({ teams, ranked: false, hasTopThree: false }), 'fr');

    expect(screen.getByText('Partie non classée : pas de rang.')).toBeInTheDocument();
    expect(screen.getByText('Pas de top 3 de Valve pour cette partie.')).toBeInTheDocument();
    expect(screen.getByText('Héros n°17')).toBeInTheDocument();
  });

  it('shows the French sentence of the state unreadable', async () => {
    await renderPlayersTab({ kind: 'unreadable' }, 'fr');

    expect(screen.getByText("L'archive de cette partie n'a pas pu être lue.")).toBeInTheDocument();
  });
});
