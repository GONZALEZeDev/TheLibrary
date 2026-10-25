/**
 * The layout the pieces of the review share: the grid of the rows and of the header of their columns,
 * so that the names above the figures can never drift from the figures; the box of a list; and the
 * title of a section.
 *
 * @packageDocumentation
 */

/**
 * The grid of a row of the review (`ReviewRow`) and of the header of its columns (`ReviewRowHeader`),
 * with the horizontal padding of both, so that a name and its figures line up from the first row to
 * the header. It has six columns, in this order:
 *
 * 1. the arrow of a point the summary flags (1.25 rem);
 * 2. the name of the point, which takes what the others leave;
 * 3. the player's figure with the number of matches it counts (7 rem: wide enough for "1,8 pour
 *    10 min" in semibold, the longest figure of a point, on one line);
 * 4. the tier's figure with its gap, and the figure the gap was measured on (up to 8 rem);
 * 5. the weak and strong counts (up to 6.5 rem);
 * 6. the progress (up to 7 rem).
 *
 * **The widths are a budget.** The window is at least 1100 px wide. The sidebar (15 rem) and the
 * padding of the main column (2 × 2.5 rem) leave about 780 px; the border and padding of the list
 * and a scrollbar take about 30 px of it, and the padding of a row 24 px. The fixed columns (20 + 112
 * + 128 + 104 + 112 = 476 px) and the five gaps between the columns (60 px) leave the name about
 * 190 px (12 rem) at the narrowest window, two lines for the longest names; a wider window gives it
 * the rest. A column added here, or a wider one, comes out of the name: recount before changing it.
 * The marks and the progress, which are sentences, wrap in their narrow columns rather than push the
 * name out.
 *
 * The row adds its own look (rounded corners, vertical padding, a tint); the header, its caption
 * style.
 */
export const REVIEW_ROW_GRID =
  'grid grid-cols-[1.25rem_minmax(0,1fr)_7rem_minmax(0,8rem)_minmax(0,6.5rem)_minmax(0,7rem)] items-center gap-x-3 px-3';

/**
 * The look of the box of a list of the review: the rounded border of the lists of the match page. A
 * list of rows (`ReviewRowList`) and the list of the damage tab stand in it. Its padding is the only
 * padding around the rows of a list: the budget of the grid above counts the border and the padding of
 * this box, and any other padding comes out of the name column of the rows.
 */
export const REVIEW_LIST_BOX = 'rounded-xl border border-border bg-surface p-1';

/**
 * The look of the title (an `h2`) of a section of a tab of the review: the page title is the `h1`,
 * the tab panel is named by its tab, and each section of a tab is named by a title of this look.
 */
export const REVIEW_SECTION_TITLE = 'text-base font-semibold';
