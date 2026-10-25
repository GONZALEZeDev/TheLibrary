/**
 * The damage tab of the review: how the player dealt their damage to the enemy heroes over their last
 * matches, source by source, and how that moved since the matches before. It shows the player which
 * ability, item or weapon they now lean on more, or less.
 *
 * It is one section with its title, and a row for each source in the order the review gives (the
 * largest share now first): the tab never sorts, filters or cuts them. A row gives:
 *
 * - the picture and the name of the source, and what it is for the weapon, the melee attack and an
 *   item, in the cell the damage table of the match page uses (`DamageSourceCell`);
 * - its share of the damage of the last matches, with the figure and a bar (`ShareBar`) drawn to the
 *   same length;
 * - its share over the matches before, or a dash when those matches dealt no damage (there is nothing
 *   to share, so no share to show: never a 0 %);
 * - in how many of the last matches the source dealt damage.
 *
 * A share is the damage the source dealt over all the matches of the window, over all the damage of
 * the window, so the shares of a window add up to 100 %. There is no figure of the tier above for the
 * damage by source, so the tab judges nothing: no arrow, no word and no tint say that a source is
 * weak or strong, and the bar has no mark for the share before, which the figure beside it says.
 *
 * The names and the pictures come from the item catalogue. When it cannot be read, the sources cannot
 * be named: the section keeps its title and says so in a sentence instead of its list. The same goes
 * for matches where no source dealt any damage, which have nothing to list: a sentence says so, since
 * a header of columns over an empty list says nothing. The page around the tab handles every other
 * state (no account, no match, a review being read): this component only renders rows.
 *
 * The rows are a list of grids and not an HTML table, as on the match page. The header of the columns
 * is for the eye; each figure of a row carries the name of its column for assistive technologies
 * instead. The two windows are named by their size ("Last 20", "20 before"), which the review has
 * already told in its heading; a window of one match is named "Last match" or "Match before", and a
 * window with no match before is named so ("No match before"), over a column of dashes.
 *
 * The headings: the page title is the `h1` of the page, the tab panel is named by its tab, and the
 * section is an `h2` that names it, with the look of the sections of the review.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { DamageShareRow } from '../../../core/analysis/review/damage-review';
import type { Review, ReviewWindow } from '../../../services/review-view';
import { ShareBar } from '../../components/ShareBar';
import { formatShare, NO_VALUE } from '../match-detail/analysis-format';
import { DamageSourceCell, SOURCE_CELL } from '../match-detail/DamageSourceCell';
import { REVIEW_LIST_BOX, REVIEW_SECTION_TITLE } from './review-layout';

/** Props of {@link ReviewDamage}. */
export interface ReviewDamageProps {
  /** The damage by source over the last matches and the ones before, or why it cannot be shown. */
  readonly damage: Review['damage'];
  /** The last matches, whose size names the column of the share now. */
  readonly recent: ReviewWindow;
  /** The matches before them, whose size names the column of the share before. */
  readonly before: ReviewWindow;
}

/*
 * The grid. The columns of a row line up from one row to the next: the source takes what the others
 * leave, then the share now with its bar, the share before, and the number of matches the source
 * was used in. Every cell but the first carries the rule at its left, so that the eye follows a
 * column down and a row along; the rules between the rows are the list's. The last column holds a
 * short sentence ("In 20 matches") and wraps rather than push the name out.
 */

/** The columns of the header and of every row. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)_5rem_minmax(0,8rem)]';

/** The other cells of a row: the rule at their left, and the room around their figures. */
const FIGURE_CELL = 'border-l border-border px-3 py-2';

/** The names of the two windows' columns, written for the size of each window. */
interface WindowColumns {
  /** The name of the column of the share over the last matches. */
  readonly now: string;
  /** The name of the column of the share over the matches before. */
  readonly before: string;
}

/**
 * A figure of a row, with the name of its column for assistive technologies: a bare "44%" would not
 * say whether it is the share now or the share before.
 *
 * @param column - The name of the column.
 * @param figure - The figure, already written.
 * @param className - The classes of the text.
 * @returns The line.
 */
function renderFigure(column: string, figure: string, className: string) {
  return (
    <p className={className}>
      <span className="sr-only">{column} </span>
      {figure}
    </p>
  );
}

/**
 * One row of the list: a damage source.
 *
 * @param row - The source.
 * @param columns - The names of the two share columns.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The item of the list.
 */
function renderRow(row: DamageShareRow, columns: WindowColumns, t: TFunction, language: string) {
  return (
    <li key={row.className}>
      <div className={GRID}>
        <DamageSourceCell name={row.name} kind={row.kind} imageUrl={row.imageUrl} />
        <div className={FIGURE_CELL}>
          {renderFigure(
            columns.now,
            formatShare(row.shareNow, language),
            'text-sm font-semibold tabular-nums',
          )}
          {/* The share before is the figure of the next cell: the bar has no mark for it. */}
          <ShareBar share={row.shareNow} />
        </div>
        <div className={FIGURE_CELL}>
          {row.shareBefore === null
            ? renderFigure(columns.before, NO_VALUE, 'text-sm text-fg-muted tabular-nums')
            : renderFigure(
                columns.before,
                formatShare(row.shareBefore, language),
                'text-sm tabular-nums',
              )}
        </div>
        <div className={FIGURE_CELL}>
          <p className="text-xs text-fg-muted tabular-nums">
            {t('review.damage.appears', { count: row.appearsNow })}
          </p>
        </div>
      </div>
    </li>
  );
}

/**
 * The header of the columns and the list of the sources, in one box.
 *
 * @param rows - The sources, in the order to show them.
 * @param columns - The names of the two share columns.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The box.
 */
function renderTable(
  rows: readonly DamageShareRow[],
  columns: WindowColumns,
  t: TFunction,
  language: string,
) {
  return (
    <div className={REVIEW_LIST_BOX}>
      {/* The names of the columns are for the eye: each figure of a row carries its own for assistive
          technologies, which the header would only say once for the whole list. The last column is a
          sentence that names itself. */}
      <div
        aria-hidden="true"
        className={`${GRID} border-b border-border text-xs font-medium text-fg-muted`}
      >
        <span className={SOURCE_CELL}>{t('damage.columns.source')}</span>
        <span className={FIGURE_CELL}>{columns.now}</span>
        <span className={FIGURE_CELL}>{columns.before}</span>
        <span className={FIGURE_CELL} />
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row) => renderRow(row, columns, t, language))}
      </ul>
    </div>
  );
}

/**
 * The content of the section under its title.
 *
 * @param damage - The damage by source, or the reason it cannot be shown.
 * @param columns - The names of the two share columns.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The list of the sources with the header of the columns; or a sentence, with no header of
 *   columns over nothing: the item names are unavailable, or no source dealt any damage.
 */
function renderContent(
  damage: Review['damage'],
  columns: WindowColumns,
  t: TFunction,
  language: string,
) {
  if (damage.kind === 'catalogue_unavailable') {
    return <p className="text-sm text-fg-muted">{t('review.catalogueUnavailable')}</p>;
  }
  if (damage.value.length === 0) {
    return <p className="text-sm text-fg-muted">{t('review.damage.empty')}</p>;
  }
  return renderTable(damage.value, columns, t, language);
}

/**
 * The damage by source of the review.
 *
 * @returns The section: its title, then the list of the sources with the header of the columns, or
 *   the sentence that says why there is none.
 */
export function ReviewDamage({ damage, recent, before }: ReviewDamageProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const columns: WindowColumns = {
    now: t('review.damage.now', { count: recent.count }),
    before: t('review.damage.before', { count: before.count }),
  };

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 id={titleId} className={REVIEW_SECTION_TITLE}>
        {t('review.damage.title')}
      </h2>
      {renderContent(damage, columns, t, i18n.language)}
    </section>
  );
}
