/**
 * The layout the pieces of the review share: the grid of the rows and of the header of their columns,
 * so that the names above the figures can never drift from the figures; the box of a list; and the
 * title of a section.
 *
 * @packageDocumentation
 */
import { PANEL_CLASSES } from '../../components/Panel';

/**
 * The grid of a row of the review (`ReviewRow`) and of the header of its columns (`ReviewRowHeader`),
 * with the horizontal padding of both, so that a name and its figures line up from the first row to
 * the header. It has five columns, in this order:
 *
 * 1. the arrow of a point the summary flags (1.25 rem);
 * 2. the name of the point, which takes what the others leave;
 * 3. the player's figure with the number of matches it counts (7 rem: wide enough for "1,8 pour
 *    10 min" in semibold, the longest figure of a point, on one line);
 * 4. the tier's figure with its gap, and the figure the gap was measured on (up to 8 rem);
 * 5. the weak and strong counts over the progress, one line each (up to 11 rem: wide enough for
 *    "faible 12/20 · fort 1/20" and for "1 299 → 1 167 · moins bien" in small print).
 *
 * **The widths are a budget.** The window is at least 1100 px wide. The sidebar (15 rem) and the
 * padding of the main column (2 × 2.5 rem) leave about 780 px; the border and padding of the list
 * and a scrollbar take about 30 px of it, and the padding of a row 24 px. The fixed columns (20 + 112
 * + 128 + 176 = 436 px) and the four gaps between the columns (48 px) leave the name about 240 px
 * (15 rem) at the narrowest window; a wider window gives it the rest. A column added here, or a wider
 * one, comes out of the name: recount before changing it. The last column wraps its lines rather
 * than push the name out.
 *
 * A list of rows is about 690 px wide at the least with a name of 150 px, so two lists stand side by
 * side when the tab is at least {@link REVIEW_TWO_LISTS} wide.
 *
 * The row adds its own look (rounded corners, vertical padding, a tint); the header, its caption
 * style.
 */
export const REVIEW_ROW_GRID =
  'grid grid-cols-[1.25rem_minmax(0,1fr)_7rem_minmax(0,8rem)_minmax(0,11rem)] items-center gap-x-3 px-3';

/**
 * The grid of the lists of a tab that stand two by two on a wide tab, and one under the other on a
 * narrower one: two lists of rows and the gap between them need about 87 rem (see
 * {@link REVIEW_ROW_GRID}). It reads the width of the nearest `@container`, which the caller sets
 * around it, so that it follows the room the tab has and not the window.
 */
export const REVIEW_TWO_LISTS = 'grid grid-cols-1 items-start gap-4 @min-[87rem]:grid-cols-2';

/**
 * The look of the box of a list of the review: the rounded border of the lists of the match page. A
 * list of rows (`ReviewRowList`) and the list of the damage tab stand in it. Its padding is the only
 * padding around the rows of a list: the budget of the grid above counts the border and the padding of
 * this box, and any other padding comes out of the name column of the rows.
 *
 * It is the look of a panel (its border and surface) with the tight padding of the panels.
 */
export const REVIEW_LIST_BOX = `${PANEL_CLASSES.base} ${PANEL_CLASSES.padding.tight}`;

/**
 * The look of the title (an `h2`) of a section of a tab of the review: the page title is the `h1`,
 * the tab panel is named by its tab, and each section of a tab is named by a title of this look.
 */
export const REVIEW_SECTION_TITLE = 'text-base font-semibold';

/**
 * The look of a link inside the review (a point that links to its tab, a match that links to its
 * page): the colour of the surrounding text, with an underline that says it is a link and darkens
 * under the pointer. The outline of the focus comes from the global rule of the app; `rounded-sm`
 * only rounds its corners.
 */
export const REVIEW_LINK =
  'rounded-sm underline decoration-fg-muted underline-offset-4 hover:decoration-fg';
