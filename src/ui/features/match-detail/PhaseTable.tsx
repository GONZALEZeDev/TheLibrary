/**
 * The phase table of a match: what the player did in each phase, next to what their team did, what
 * they usually do and where that puts them among their rank.
 *
 * The four figures (souls, damage to heroes, damage to objectives, kills) are the rows and the phases
 * the match reached are the columns, so that the course of the match reads from left to right. A cell
 * gives the total of the phase, the share of the team's total it makes, the gap with the habits of the
 * player and, when the community has a curve for it, where it stands on it. A cell that stood out in
 * the summary carries its arrow and its word, and a faint colour. A phase too short to be compared
 * says so instead of the gap and the place in the rank.
 *
 * The table is a light grid, so that the eye follows each phase down its column and each figure along
 * its row: a thin rule between every two cells, the cells of the header row included (above every
 * row, at the left of every phase column), and no background but the tint of a cell that stood out.
 * Each phase heads its column with its name over the time it covers.
 *
 * A cell that is compared holds the evidence behind its figures ({@link Evidence}): the panel opens
 * under the cell when the pointer is over it or the keyboard focus is on it.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { PHASE_STATS, type PhaseStat } from '../../../core/analysis/phases';
import type { PhaseCellView, PhaseColumnView } from '../../../services/analysis-view';
import {
  formatDifference,
  formatGameTime,
  formatMedian as formatMedianInUnit,
  formatMetricValue,
  formatPhaseTotal,
  INSIGHT_STYLE,
  NO_VALUE,
  PHASE_STAT_UNIT,
} from './analysis-format';
import { Evidence } from './Evidence';

/** Props of {@link PhaseTable}. */
export interface PhaseTableProps {
  /** The phases the match reached, in the order of the match. */
  readonly phases: readonly PhaseColumnView[];
}

/*
 * The grid. Every rule is 1 px wide and has the colour of the border of the theme, and every cell
 * carries its own: the rule above it, and, for a cell of a phase column, the rule at its left. The
 * table collapses nothing (`border-separate`), so two cells never double a rule. The rule above the
 * header row sets the grid apart from the title, and the border of the box closes it at the left, at
 * the right and at the bottom.
 */

/** The name of a figure, at the start of its row: the rule above the row, and the room around it. */
const ROW_HEADER =
  'border-t border-border px-3 py-2.5 align-top text-left font-normal text-fg-muted';

/** The cell of a phase in the body: the rule above its row, and the rule at its left. */
const PHASE_CELL = 'border-t border-l border-border px-3 py-2.5 align-top';

/**
 * The header of a phase column: the rule above the header row, the rule at its left, and the room for
 * its two lines.
 */
const PHASE_HEADER = 'border-t border-l border-border px-3 py-2.5 text-left font-normal';

/**
 * The empty cell at the start of the header row, above the names of the figures: it carries the rule
 * above the header row, so that the rule runs along the whole row.
 */
const CORNER_CELL = 'border-t border-border';

/**
 * Hidden between the name of a phase and its range. The two are lines of their own on screen; the dot
 * makes them one phrase ("Mid · 10:00 → 25:00") for assistive technologies and wherever the styles
 * do not apply, so that the name never runs into the first digit of the range.
 */
const NAME_RANGE_SEPARATOR = ' · ';

/**
 * The header of the column of a phase: its name over the time it covers in this match.
 *
 * @param column - The phase.
 * @param t - Translation function.
 * @returns The header cell.
 */
function renderColumnHeader(column: PhaseColumnView, t: TFunction) {
  const { span } = column;
  return (
    <th key={span.phase} scope="col" className={PHASE_HEADER}>
      <span className="block text-sm font-medium text-fg">{t(`analysis.phase.${span.phase}`)}</span>
      <span className="sr-only">{NAME_RANGE_SEPARATOR}</span>
      <span className="block text-xs font-normal text-fg-muted tabular-nums">
        {t('analysis.phaseRange', {
          from: formatGameTime(span.startS),
          to: formatGameTime(span.endS),
        })}
      </span>
    </th>
  );
}

/**
 * The lines under the total of a cell, which tell how it compares.
 *
 * @param cell - The cell.
 * @param stat - The figure of the row, which decides how the gap is written.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The lines: the share of the team, then either the sentence of a phase that is too short
 *   to compare, or the gap with the habits and the place on the curve of the rank, each only when
 *   it is known.
 */
function renderComparison(cell: PhaseCellView, stat: PhaseStat, t: TFunction, language: string) {
  const { row, teamShare } = cell;
  return (
    <div className="mt-0.5 space-y-0.5 text-xs leading-normal text-fg-muted">
      <p>
        {teamShare === null
          ? NO_VALUE
          : t('analysis.teamShare', { share: formatMetricValue(teamShare, 'percent', language) })}
      </p>
      {row === null ? (
        <p>{t('analysis.tooShort')}</p>
      ) : (
        <>
          {row.personal !== null && (
            <p>
              {t('analysis.personal.difference', {
                difference: formatDifference(
                  row.personal.difference,
                  PHASE_STAT_UNIT[stat],
                  language,
                  t,
                ),
              })}
            </p>
          )}
          {row.community.kind === 'curve' && <p>{t(`analysis.curve.${row.community.label}`)}</p>}
        </>
      )}
    </div>
  );
}

/**
 * One cell of the table.
 *
 * @param stat - The figure of the row.
 * @param column - The phase of the column.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The cell: the total, with its arrow and its word when it stood out, and how it compares.
 *   A cell that is compared holds the evidence behind its figures; the tint stays on the cell itself,
 *   so that it fills it whatever the size of what the cell holds. A cell that did not stand out has
 *   no background.
 */
function renderCell(stat: PhaseStat, column: PhaseColumnView, t: TFunction, language: string) {
  const cell = column.cells[stat];
  const { row } = cell;
  const insight = row?.insight ?? null;
  // What marks a cell that stood out in the summary: the arrow and the colours, and the word.
  const mark =
    insight === null
      ? null
      : { ...INSIGHT_STYLE[insight.side], word: t(`analysis.flag.${insight.side}`) };
  const figures = (
    <>
      <div className="text-base font-semibold">
        {mark !== null && (
          <span aria-hidden="true" className={`${mark.text} mr-1.5`}>
            {mark.arrow}
          </span>
        )}
        {formatPhaseTotal(cell.total, stat, language)}
        {mark !== null && <span className="sr-only">{mark.word}</span>}
      </div>
      {renderComparison(cell, stat, t, language)}
    </>
  );
  return (
    <td
      key={column.span.phase}
      className={mark === null ? PHASE_CELL : `${PHASE_CELL} ${mark.tint}`}
    >
      {row === null ? (
        figures
      ) : (
        <Evidence
          row={row}
          // The usual value of a phase metric is a total of the phase, like the figure of the cell.
          formatMedian={(median) => formatMedianInUnit(median, PHASE_STAT_UNIT[stat], language)}
        >
          {figures}
        </Evidence>
      )}
    </td>
  );
}

/**
 * The phase table of a match.
 *
 * @returns The table, or nothing for a match that reached no phase.
 */
export function PhaseTable({ phases }: PhaseTableProps) {
  const { t, i18n } = useTranslation();

  if (phases.length === 0) {
    return null;
  }
  return (
    // The box does not clip what it holds (no `overflow-hidden`): what a cell shows next to itself,
    // like a tooltip, may leave the box. The corner cell follows the corner of the box instead.
    <div className="rounded-xl border border-border bg-surface">
      <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm tabular-nums">
        <caption className="px-3 py-2 text-left text-base font-semibold">
          {t('analysis.phaseTable.title')}
        </caption>
        <colgroup>
          <col className="w-40" />
          {phases.map(({ span }) => (
            <col key={span.phase} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <td className={CORNER_CELL} />
            {phases.map((column) => renderColumnHeader(column, t))}
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td:last-child]:rounded-br-xl">
          {PHASE_STATS.map((stat) => (
            <tr key={stat}>
              <th scope="row" className={ROW_HEADER}>
                {t(`analysis.phaseStat.${stat}`)}
              </th>
              {phases.map((column) => renderCell(stat, column, t, i18n.language))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
