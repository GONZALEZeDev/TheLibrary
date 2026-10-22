/**
 * The players tab of the match page: the twelve players of the match with their rank, their hero and
 * their figures, one table per team, so that the player sees whether they were above the average of
 * the match and whether their impact was larger than the others'.
 *
 * What the tab shows depends on the state of the view (`usePlayersTab`):
 * - `ready`: the title, the table of the tracked player's team and the table of the other team, then
 *   the places of the tracked player among the twelve, and the notes that apply;
 * - `unreadable`: a sentence saying the archive of the match cannot be read;
 * - `not_archived`: nothing. The analysis above the tabs says why there is nothing (the detail of
 *   the match is not archived).
 *
 * **A table** is named by its caption: the team ("Your team" for the tracked player's, "Enemy team"
 * for the other) and its result. Its rows are the players of the team, in the order the service gives
 * (by slot). The first cell of a row holds the mark of Valve's top three, when the player is in it
 * (the header of that column is for assistive technologies only); then come the rank (a ranked match
 * only: any other match has none to show), the hero, and the figures. The hero heads the row. The
 * tracked player's row has a faint background and the word "(you)" after the name of their hero: the
 * background never says it alone. A hero or a rank the catalogues do not give a picture for, or whose
 * picture cannot be loaded (offline, say), is shown by its name alone, and a hero they do not know is
 * shown by its id. A figure the archive does not tell is a dash, never a 0.
 *
 * **The layout** has to hold twelve players and up to nine columns at the smallest window of the app
 * (a table is then about 760 px wide). The cells have little room at their sides, the rank, the
 * K / D / A and every figure stay on one line (a rank or a score broken over two lines is easy to
 * misread), and the widths are shares of a fixed layout, the same for both tables so that their
 * columns line up. The hero is the one cell that may wrap: an unexpectedly long name goes to a second
 * line instead of spilling into the column beside it. The last hits and denies are headed "LH / D"
 * for the eye and "Last hits / denies" for assistive technologies.
 *
 * **The places** are one pill per figure the tracked player is placed on ("Hero damage: 3/12 · +18%
 * vs the average"), in the order of the view, in a list that has a name. A figure whose mean is 0 has
 * no gap to write.
 *
 * The tables are the light grid of the phase table of the analysis, in its dense variant
 * ({@link GRID_CELL_DENSE} and the other classes of `table-styles`).
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../core/domain/match';
import { toAppError } from '../../../core/errors/app-error';
import type { PlaceStat, ScoreboardPlayer, StatPlace } from '../../../core/match-detail/scoreboard';
import type { PlayerRowView, TeamView } from '../../../services/match-breakdown-view';
import { GamePicture } from '../../components/GamePicture';
import { formatDifference, formatMetricValue, NO_VALUE } from './analysis-format';
import {
  GRID_CELL_DENSE,
  GRID_COLUMN_HEADER_DENSE,
  GRID_CORNER_CELL,
  GRID_ROW_START_CELL_DENSE,
} from './table-styles';
import { usePlayersTab } from './use-match-breakdown';

/** Props of {@link PlayersTab}. */
export interface PlayersTabProps {
  /** The match whose players the tab shows. */
  readonly matchId: MatchId;
}

/**
 * The columns of the figures, after the hero, in the order they are shown. Each is a key of
 * `players.columns`.
 */
const FIGURE_COLUMNS = [
  'kda',
  'souls',
  'heroDamage',
  'objectiveDamage',
  'support',
  'lastHits',
] as const;

/**
 * A column of a table, each a key of `players.columns`: the marks of Valve's top three, the rank (a
 * ranked match only), the hero, then the figures.
 */
type ColumnName = 'top' | 'rank' | 'hero' | (typeof FIGURE_COLUMNS)[number];

/**
 * The width of each column, as a share of the table, so that the two tables of the page line up. A
 * column with no width shares what the others leave. Every column is spelled out, so that a new one
 * has to be given a decision, and a reorder of the columns moves the widths with them.
 *
 * The shares are worked out for the smallest window of the app (a table of about 760 px) and the
 * widest content of each column on one line, plus the room of its cell: the mark of the top three,
 * the badge and the name of the longest rank ("Ascendant 6"), the K / D / A of a long match
 * ("12 / 10 / 25") and the last hits and denies ("345 / 31"). The hero keeps what a portrait, a name
 * and "(you)" need, and may wrap. The four figures share the rest: 35 % of a ranked table, 53 % of
 * an unranked one, which has no rank column.
 */
const COLUMN_WIDTHS: Readonly<Record<ColumnName, string | undefined>> = {
  top: 'w-[8%]',
  rank: 'w-[18%]',
  hero: 'w-[16%]',
  kda: 'w-[13%]',
  souls: undefined,
  heroDamage: undefined,
  objectiveDamage: undefined,
  support: undefined,
  lastHits: 'w-[10%]',
};

/**
 * The columns of a table, left to right. The header and the widths follow this list; the cells of a
 * row (see `renderPlayer`) are written in the same order.
 *
 * @param ranked - Whether the match is ranked: any other has no rank column.
 * @returns The columns.
 */
function columnsOf(ranked: boolean): readonly ColumnName[] {
  return ['top', ...(ranked ? (['rank'] as const) : []), 'hero', ...FIGURE_COLUMNS];
}

/**
 * The text that names each figure of the places line. It is the name of the column of the figure,
 * except for the last hits: their column holds the denies too ("LH / D"), so their place takes the
 * name of the metric.
 */
const PLACE_LABEL_KEYS = {
  netWorth: 'players.columns.souls',
  heroDamage: 'players.columns.heroDamage',
  objectiveDamage: 'players.columns.objectiveDamage',
  support: 'players.columns.support',
  lastHits: 'analysis.metric.last_hits',
} as const satisfies Record<PlaceStat, string>;

/** The text of the mark of each place of Valve's top three. */
const TOP_THREE_KEYS = {
  1: 'players.top.1',
  2: 'players.top.2',
  3: 'players.top.3',
} as const satisfies Record<NonNullable<ScoreboardPlayer['mvpRank']>, string>;

/** Written between the place of a figure and its gap to the mean of the players. */
const PLACE_GAP_SEPARATOR = ' · ';

/** The background of the row of the tracked player: a faint tint of the accent of the theme. */
const TRACKED_ROW = 'bg-accent/10';

/** The cell of the mark of the top three, at the start of a row. */
const MARK_CELL = `${GRID_ROW_START_CELL_DENSE} whitespace-nowrap`;

/** A cell of a row that never breaks over two lines: the rank, the K / D / A and the figures. */
const FIGURE_CELL = `${GRID_CELL_DENSE} whitespace-nowrap`;

/** The cell of the hero, which heads the row and may wrap. */
const HERO_CELL = `${GRID_CELL_DENSE} text-left font-normal`;

/**
 * The mark of Valve's top three, in the first cell of the row of a player who is in it.
 *
 * @param mvpRank - The place of the player in the top three, or `null` when they are not in it.
 * @param t - Translation function.
 * @returns The pill, or nothing for a player who is not in the top three.
 */
function renderTopMark(mvpRank: PlayerRowView['mvpRank'], t: TFunction) {
  return mvpRank === null ? null : (
    <span className="inline-block rounded-full bg-secondary/15 px-2 text-xs leading-5 font-semibold text-secondary">
      {t(TOP_THREE_KEYS[mvpRank])}
    </span>
  );
}

/**
 * The rank of a player: the badge of their tier beside the name of their rank.
 *
 * @param player - The player.
 * @returns The name of the rank with its badge when the catalogue gives one, or a dash for a player
 *   who has no rank to show (the badge is decorative: the rank is written beside it).
 */
function renderRank(player: PlayerRowView) {
  if (player.rankName === null) {
    return NO_VALUE;
  }
  return (
    <div className="flex items-center gap-2">
      {/* A rank with no badge, or whose badge cannot be loaded, is shown by its name alone. */}
      <GamePicture src={player.rankImageUrl} size="small" fit="contain" fallback="none" />
      <span>{player.rankName}</span>
    </div>
  );
}

/**
 * The hero of a player: the portrait beside the name, then the word that marks the tracked player.
 *
 * @param player - The player.
 * @param t - Translation function.
 * @returns The content of the cell that heads the row. The portrait is decorative: the name is
 *   written beside it. The name is the English one of the catalogue whatever the language of the
 *   interface, or the id of the hero when the catalogue does not know it.
 */
function renderHero(player: PlayerRowView, t: TFunction) {
  return (
    <div className="flex items-center gap-2">
      {/* A hero with no portrait, or whose portrait cannot be loaded, is shown by its name alone. */}
      <GamePicture src={player.heroImageUrl} size="small" fit="cover" fallback="none" />
      <span className="font-medium">
        {player.heroName ?? t('matches.table.unknownHero', { id: player.heroId })}
      </span>
      {/* The word is on screen with the tint of the row: the colour never says it alone. */}
      {player.isTracked && <span className="text-xs text-accent-bright">{t('players.you')}</span>}
    </div>
  );
}

/**
 * One row of a table: a player.
 *
 * @param player - The player.
 * @param ranked - Whether the match is ranked, which decides whether the rank has a cell.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The row, its cells in the order of {@link columnsOf}. The souls and the damage are written
 *   with the separators of the language, the K / D / A and the last hits and denies with slashes
 *   like the match list.
 */
function renderPlayer(player: PlayerRowView, ranked: boolean, t: TFunction, language: string) {
  return (
    <tr key={player.slot} className={player.isTracked ? TRACKED_ROW : undefined}>
      <td className={MARK_CELL}>{renderTopMark(player.mvpRank, t)}</td>
      {ranked && <td className={FIGURE_CELL}>{renderRank(player)}</td>}
      <th scope="row" className={HERO_CELL}>
        {renderHero(player, t)}
      </th>
      <td className={FIGURE_CELL}>
        {player.kills} / {player.deaths} / {player.assists}
      </td>
      <td className={FIGURE_CELL}>{formatMetricValue(player.netWorth, 'amount', language)}</td>
      <td className={FIGURE_CELL}>{formatMetricValue(player.heroDamage, 'amount', language)}</td>
      <td className={FIGURE_CELL}>
        {formatMetricValue(player.objectiveDamage, 'amount', language)}
      </td>
      <td className={FIGURE_CELL}>{formatMetricValue(player.support, 'amount', language)}</td>
      <td className={FIGURE_CELL}>
        {player.lastHits} / {player.denies}
      </td>
    </tr>
  );
}

/**
 * The header of a column.
 *
 * @param column - The column.
 * @param t - Translation function.
 * @returns The header cell. The column of the marks of the top three is named for assistive
 *   technologies only: the marks say what they are, and the cell above them stays empty on screen,
 *   with the rule that runs along the header row. The last hits and denies are headed by their
 *   abbreviation on screen ("LH / D", which a screen reader would spell out letter by letter) and by
 *   their full name for assistive technologies.
 */
function renderColumnHeader(column: ColumnName, t: TFunction) {
  const name = t(`players.columns.${column}`);
  if (column === 'top') {
    return (
      <th key={column} scope="col" className={GRID_CORNER_CELL}>
        <span className="sr-only">{name}</span>
      </th>
    );
  }
  return (
    <th key={column} scope="col" className={GRID_COLUMN_HEADER_DENSE}>
      {column === 'lastHits' ? (
        <>
          <span aria-hidden="true">{name}</span>
          <span className="sr-only">{t('players.columns.lastHitsFull')}</span>
        </>
      ) : (
        name
      )}
    </th>
  );
}

/**
 * The table of one team.
 *
 * @param team - The team.
 * @param ranked - Whether the match is ranked, which decides whether the table has a rank column.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The table in its box. The caption names the team and says whether it won, so that the two
 *   tables are told apart without the colour of the result.
 */
function renderTeam(team: TeamView, ranked: boolean, t: TFunction, language: string) {
  // The service puts the tracked player's team first; the table does not rely on it to name it.
  const isYours = team.players.some((player) => player.isTracked);
  const columns = columnsOf(ranked);
  return (
    // The box clips what it holds: the tint of the row of the tracked player follows its corners.
    // The table scrolls inside it rather than crush its columns when the window is narrow.
    <div key={team.team} className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[44rem] table-fixed border-separate border-spacing-0 text-left text-sm leading-6 tabular-nums">
        <caption className="px-3 py-2 text-left text-base font-semibold">
          {t(isYours ? 'players.team.yours' : 'players.team.enemy')}
          {' · '}
          <span className={team.won ? 'text-win' : 'text-loss'}>
            {team.won ? t('matches.table.win') : t('matches.table.loss')}
          </span>
        </caption>
        <colgroup>
          {columns.map((column) => (
            <col key={column} className={COLUMN_WIDTHS[column]} />
          ))}
        </colgroup>
        <thead>
          <tr className="text-xs text-fg-muted">
            {columns.map((column) => renderColumnHeader(column, t))}
          </tr>
        </thead>
        <tbody>{team.players.map((player) => renderPlayer(player, ranked, t, language))}</tbody>
      </table>
    </div>
  );
}

/**
 * The place of the tracked player on one figure.
 *
 * @param place - The place.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The pill: the name of the figure and the place, then the gap to the average of the
 *   players when there is one ("Hero damage: 3/12 · +18% vs the average"). The gap is written with a
 *   sign, and a real minus sign when it is below the average.
 */
function renderPlace(place: StatPlace, t: TFunction, language: string) {
  const sentence = t('players.place', {
    stat: t(PLACE_LABEL_KEYS[place.stat]),
    place: place.place,
    of: place.of,
  });
  const gap =
    place.gapToMean === null
      ? ''
      : PLACE_GAP_SEPARATOR +
        t('players.gap', {
          // A gap to the mean is a share of that mean, so it is a relative difference.
          value: formatDifference(
            { kind: 'relative', ratio: place.gapToMean },
            'amount',
            language,
            t,
          ),
        });
  return (
    <li
      key={place.stat}
      className="rounded-full border border-border bg-surface-raised px-3 py-1 text-sm tabular-nums"
    >
      {sentence + gap}
    </li>
  );
}

/**
 * The players tab of one match.
 *
 * @returns The two tables and the places of the tracked player, or the sentence of a tab that cannot
 *   show them, or nothing for a match whose detail is not archived.
 */
export function PlayersTab({ matchId }: PlayersTabProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const players = usePlayersTab(matchId);
  const view = players.data;

  if (view === undefined) {
    // While the view is read (from the local database, so in a blink) nothing is shown. A failed
    // refresh keeps the view already shown: the error only replaces an empty tab.
    return players.isError ? (
      <p role="alert" className="text-sm text-loss">
        {t(`errors.kind.${toAppError(players.error).kind}`)}
      </p>
    ) : null;
  }
  switch (view.kind) {
    case 'not_archived':
      // The analysis above the tabs says why there is nothing.
      return null;
    case 'unreadable':
      return <p className="text-sm text-fg-muted">{t('players.unreadable')}</p>;
    case 'ready':
      return (
        <section aria-labelledby={titleId} className="space-y-4">
          <h2 id={titleId} className="text-base font-semibold">
            {t('players.title')}
          </h2>
          {view.teams.map((team) => renderTeam(team, view.ranked, t, i18n.language))}
          {view.places.length > 0 && (
            <ul aria-label={t('players.placesLabel')} className="flex flex-wrap gap-2">
              {view.places.map((place) => renderPlace(place, t, i18n.language))}
            </ul>
          )}
          {!view.hasTopThree && <p className="text-sm text-fg-muted">{t('players.noTopThree')}</p>}
          {!view.ranked && <p className="text-sm text-fg-muted">{t('players.unrankedNote')}</p>}
        </section>
      );
  }
}
