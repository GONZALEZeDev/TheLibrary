/**
 * The damage and build tab of the match page: how the player dealt their damage to the enemy heroes,
 * source by source, compared with their own habits, and the build they ended the match with. It tells
 * the player which ability, item or weapon to use more.
 *
 * What the tab shows depends on the state of the view (`useDamageTab`):
 * - `ready`: the damage table under the title of the damage and the total of the match, then the
 *   build ({@link FinalBuild}). A match with no damage to show says so where the table would be, and
 *   still shows its build;
 * - `failed`: a sentence saying the match could not be analysed;
 * - `unreadable`, `catalogue_unavailable`: a sentence saying why the sources cannot be shown;
 * - `pending`, `not_analysed`: nothing. The analysis above the tabs says why there is nothing yet
 *   (it is under way, or the detail of the match is not archived).
 *
 * **The table** has a row per source, in the order the service gives (the sources that were unlocked
 * by share, then the abilities that were not). A row gives the picture and the name of the source (and
 * what it is for the weapon, the melee attack and an item), its share of the damage of the match drawn
 * as a bar, the player's usual share, and the gap in points. The shares of the rows add up to 100 %.
 * A source that stands out carries an arrow, a word and a faint colour: the colour never says it
 * alone. An ability that was not unlocked says so instead of a share, and has no bar, no habit, no gap
 * and no evidence.
 *
 * An item is compared on its share of the damage dealt **while it was owned** (an item bought late
 * would always look weak on the whole match), so its usual share and its gap are on that scale. Its
 * row says so under its share of the match, and its evidence says it again. Its bar, which draws the
 * share of the match, carries no mark for the habit, which would be on another scale. For any other
 * source, the share compared with the habit is the one of the whole match, and the bar has the mark.
 *
 * The rows are a list of grids and not an HTML table, because the evidence panel wraps a whole row:
 * the panel opens when the pointer or the keyboard focus is anywhere on it, and hangs from its right
 * edge, as the rows of the analysis do. The header of the columns is for the eye; each figure of a
 * row carries the name of its column for assistive technologies instead.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { DamageBreakdown, DamageSourceRow } from '../../../core/analysis/damage-breakdown';
import type { MatchId } from '../../../core/domain/match';
import { Panel } from '../../components/Panel';
import { ShareBar } from '../../components/ShareBar';
import { StatusLine } from '../../components/StatusLine';
import {
  formatMetricValue,
  formatShare,
  formatShareGap,
  INSIGHT_STYLE,
  NO_VALUE,
} from './analysis-format';
import { DamageSourceCell, SOURCE_CELL } from './DamageSourceCell';
import { EvidencePanel } from './EvidencePanel';
import { FinalBuild } from './FinalBuild';
import { useDamageTab } from './use-match-breakdown';

/** Props of {@link DamageTab}. */
export interface DamageTabProps {
  /** The match whose damage and build the tab shows. */
  readonly matchId: MatchId;
}

/**
 * The marks of a source that stands out: used more than usual is a strength, less than usual a
 * weakness, with the arrow, the colours and the tint of the analysis.
 */
const FLAG_STYLE = { above: INSIGHT_STYLE.strength, below: INSIGHT_STYLE.weakness } as const;

/*
 * The grid. The columns of a row line up from one row to the next: the source takes what the others
 * leave, then the share with its bar, the habit, and the gap with its word. Every cell but the first
 * carries the rule at its left, so that the eye follows a column down and a row along; the rules
 * between the rows are the list's.
 */

/** The columns of the header and of every row. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)_5rem_minmax(0,9.5rem)]';

/** The other cells of a row: the rule at their left, and the room around their figures. */
const FIGURE_CELL = 'border-l border-border px-3 py-2';

/** How strongly a figure of a row stands out. */
type Emphasis = 'strong' | 'normal' | 'muted';

/** The classes of each emphasis. Each is a complete literal for Tailwind. */
const EMPHASIS_CLASSES: Readonly<Record<Emphasis, string>> = {
  strong: 'text-sm font-semibold tabular-nums',
  normal: 'text-sm tabular-nums',
  muted: 'text-sm tabular-nums text-fg-muted',
};

/**
 * A figure of a row, with the name of its column for assistive technologies: a bare "44%" would not
 * say whether it is the share, the habit or the gap.
 *
 * @param column - The name of the column.
 * @param figure - The figure, already written.
 * @param emphasis - How strongly the figure stands out: the share and the gap are the two the eye
 *   looks for, and a figure that is missing is muted.
 * @returns The line.
 */
function renderFigure(column: string, figure: string, emphasis: Emphasis) {
  return (
    <p className={EMPHASIS_CLASSES[emphasis]}>
      <span className="sr-only">{column} </span>
      {figure}
    </p>
  );
}

/**
 * Say the share an item was compared on: its share of the damage the player dealt while they owned
 * it.
 *
 * @param row - The source.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The share and the words that say what it is of ("31% while you owned it"), or `null` for
 *   a source that is not an item, and for an item whose share while owned is not known.
 */
function whileOwnedLine(row: DamageSourceRow, t: TFunction, language: string): string | null {
  return row.kind === 'item' && row.comparedShare !== null
    ? `${formatShare(row.comparedShare, language)} ${t('damage.whileOwned')}`
    : null;
}

/**
 * The lines of the evidence panel of a row, in reading order.
 *
 * @param row - The source.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The damage the source dealt; for an item, the share while it was owned; then the usual
 *   share and the matches it is made of, or that there are too few of them.
 */
function evidenceLines(row: DamageSourceRow, t: TFunction, language: string): string[] {
  const owned = whileOwnedLine(row, t, language);
  return [
    t('damage.amount', { value: formatMetricValue(row.damage, 'amount', language) }),
    ...(owned === null ? [] : [owned]),
    ...(row.habit === null
      ? [t('damage.notEnough')]
      : [
          t('analysis.personal.median', { value: formatShare(row.habit.median, language) }),
          t('analysis.personal.matches', { count: row.habit.count }),
        ]),
  ];
}

/**
 * The cells of a source that was unlocked: its share of the match with the bar, its habit, and its
 * gap with the word of the flag.
 *
 * @param row - The source.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The three cells.
 */
function renderFigures(row: DamageSourceRow, t: TFunction, language: string) {
  const flag =
    row.flag === null ? null : { ...FLAG_STYLE[row.flag], word: t(`damage.flag.${row.flag}`) };
  const owned = whileOwnedLine(row, t, language);
  return (
    <>
      <div className={FIGURE_CELL}>
        {/* The share of the match, for every source, so that the shares of the rows add up to 100 %. */}
        {renderFigure(t('damage.columns.share'), formatShare(row.share, language), 'strong')}
        {owned !== null && <p className="text-xs text-fg-muted">{owned}</p>}
        {/* An item's habit is on its share while owned, not on the share of the match the bar draws:
            the mark would stand in the wrong place. */}
        <ShareBar
          share={row.share}
          mark={row.kind === 'item' ? null : (row.habit?.median ?? null)}
        />
      </div>
      <div className={FIGURE_CELL}>
        {renderFigure(
          t('damage.columns.habit'),
          row.habit === null ? NO_VALUE : formatShare(row.habit.median, language),
          'normal',
        )}
      </div>
      <div className={FIGURE_CELL}>
        {renderFigure(
          t('damage.columns.gap'),
          row.gap === null ? NO_VALUE : formatShareGap(row.gap, language, t),
          'strong',
        )}
        {flag !== null && (
          // The word is on screen with the arrow: the colour never says it alone.
          <p className={`mt-0.5 text-xs ${flag.text}`}>
            <span aria-hidden="true">{flag.arrow}</span> {flag.word}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The cells of an ability that was not unlocked: the sentence in place of the share, and dashes where
 * a habit and a gap would be, named by their columns like the figures of the other rows.
 *
 * @param t - Translation function.
 * @returns The three cells.
 */
function renderNotUnlocked(t: TFunction) {
  return (
    <>
      <div className={FIGURE_CELL}>
        <p className="text-xs text-fg-muted">{t('damage.notUnlocked')}</p>
      </div>
      <div className={FIGURE_CELL}>
        {renderFigure(t('damage.columns.habit'), NO_VALUE, 'muted')}
      </div>
      <div className={FIGURE_CELL}>{renderFigure(t('damage.columns.gap'), NO_VALUE, 'muted')}</div>
    </>
  );
}

/**
 * One row of the table: a damage source.
 *
 * @param row - The source.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The item of the list. A source that was unlocked holds the evidence behind its figures,
 *   anchored at the right edge of the row so that it leaves the names of the rows below free to the
 *   pointer; an ability that was not unlocked has nothing to give, and is a plain row.
 */
function renderRow(row: DamageSourceRow, t: TFunction, language: string) {
  // A source that stands out has the faint colour of its flag on the whole row.
  const tint = row.flag === null ? '' : ` ${FLAG_STYLE[row.flag].tint}`;
  const cells = (
    <div className={`${GRID} rounded-lg${tint}`}>
      <DamageSourceCell name={row.name} kind={row.kind} imageUrl={row.imageUrl} />
      {row.unlocked ? renderFigures(row, t, language) : renderNotUnlocked(t)}
    </div>
  );
  return (
    <li key={row.className}>
      {row.unlocked ? (
        <EvidencePanel label={row.name} lines={evidenceLines(row, t, language)} placement="end">
          {cells}
        </EvidencePanel>
      ) : (
        cells
      )}
    </li>
  );
}

/**
 * The table of the damage by source.
 *
 * @param breakdown - The damage by source.
 * @param titleId - The id of the title of the damage, which names the list.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The header of the columns and the list of the sources.
 */
function renderTable(breakdown: DamageBreakdown, titleId: string, t: TFunction, language: string) {
  return (
    <Panel as="div" padding="tight">
      {/* The names of the columns are for the eye: each figure of a row carries its own for assistive
          technologies, which the header would only say once for the whole list. */}
      <div
        aria-hidden="true"
        className={`${GRID} border-b border-border text-xs font-medium text-fg-muted`}
      >
        <span className={SOURCE_CELL}>{t('damage.columns.source')}</span>
        <span className={FIGURE_CELL}>{t('damage.columns.share')}</span>
        <span className={FIGURE_CELL}>{t('damage.columns.habit')}</span>
        <span className={FIGURE_CELL}>{t('damage.columns.gap')}</span>
      </div>
      <ul aria-labelledby={titleId} className="divide-y divide-border">
        {breakdown.rows.map((row) => renderRow(row, t, language))}
      </ul>
    </Panel>
  );
}

/**
 * The damage and build tab of one match.
 *
 * @returns The damage by source and the build, or the sentence of a tab that cannot show them, or
 *   nothing while the match waits for its analysis (or has none).
 */
export function DamageTab({ matchId }: DamageTabProps) {
  const { t, i18n } = useTranslation();
  const damageTitleId = useId();
  const damage = useDamageTab(matchId);
  const view = damage.data;

  if (view === undefined) {
    // While the view is read (from the local database, so in a blink) nothing is shown. A failed
    // refresh keeps the view already shown: the error only replaces an empty tab.
    return damage.isError ? <StatusLine kind="error" error={damage.error} /> : null;
  }
  switch (view.kind) {
    case 'pending':
    case 'not_analysed':
      // The analysis above the tabs says why there is nothing yet.
      return null;
    case 'failed':
      return <p className="text-sm text-fg-muted">{t('analysis.failed')}</p>;
    case 'unreadable':
      return <p className="text-sm text-fg-muted">{t('damage.unreadable')}</p>;
    case 'catalogue_unavailable':
      return <p className="text-sm text-fg-muted">{t('damage.catalogueUnavailable')}</p>;
    case 'ready':
      return (
        <div className="space-y-6">
          {/* The region of the damage holds the damage only: the build is a region of its own. */}
          <section aria-labelledby={damageTitleId} className="space-y-3">
            <div className="space-y-1">
              <h2 id={damageTitleId} className="text-base font-semibold">
                {t('damage.title')}
              </h2>
              {view.breakdown !== null && (
                <p className="text-sm text-fg-muted tabular-nums">
                  {t('damage.total', {
                    value: formatMetricValue(view.breakdown.totalDamage, 'amount', i18n.language),
                  })}
                </p>
              )}
            </div>
            {view.breakdown === null ? (
              <p className="text-sm text-fg-muted">{t('damage.noDetail')}</p>
            ) : (
              renderTable(view.breakdown, damageTitleId, t, i18n.language)
            )}
          </section>
          <FinalBuild build={view.build} />
        </div>
      );
  }
}
