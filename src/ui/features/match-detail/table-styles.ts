/**
 * The light grid shared by the tables of the match page (the phase table of the analysis, the player
 * tables of the players tab): a thin rule between every two cells, the cells of the header row
 * included, and no background but the tint a table puts on a cell or a row that stands out.
 *
 * Every rule is 1 px wide and has the colour of the border of the theme, and every cell carries its
 * own: the rule above it, and, for a cell that follows another in its row, the rule at its left. A
 * table that uses them collapses nothing (`border-separate`), so two cells never double a rule. The
 * rule above the header row sets the grid apart from the title, and the border of the box around the
 * table closes it at the left, at the right and at the bottom.
 *
 * The classes are complete literals, so that Tailwind finds them here. Each is meant to be used
 * alone or joined with the classes a table adds for itself (the text of its cells, say).
 *
 * Each cell class has a dense variant, with less room at its sides (`px-2` instead of `px-3`), for a
 * table that is crowded at the smallest window of the app (the twelve players, nine columns). The
 * variants are literals of their own and not a class appended to the roomy ones: Tailwind orders two
 * `px-*` utilities by the order of its generated CSS, not by the order they are written in, so the
 * appended one would not be sure to win.
 *
 * @packageDocumentation
 */

/**
 * The cell at the start of a row, in the body: the rule above the row, and the room around it. It
 * has no rule at its left, which the border of the box is. Its text is muted, as the name of a figure
 * is in the phase table; a cell that holds something else sets its own colour.
 */
export const GRID_ROW_START_CELL =
  'border-t border-border px-3 py-2.5 align-top text-left font-normal text-fg-muted';

/** Any other cell of the body: the rule above its row, and the rule at its left. */
export const GRID_CELL = 'border-t border-l border-border px-3 py-2.5 align-top';

/**
 * The header of a column that follows the first one: the rule above the header row, the rule at its
 * left, and the room for its lines.
 */
export const GRID_COLUMN_HEADER =
  'border-t border-l border-border px-3 py-2.5 text-left font-normal';

/**
 * The empty cell at the start of the header row, above the first column: it carries the rule above
 * the header row, so that the rule runs along the whole row.
 */
export const GRID_CORNER_CELL = 'border-t border-border';

/** The dense variant of {@link GRID_ROW_START_CELL}. */
export const GRID_ROW_START_CELL_DENSE =
  'border-t border-border px-2 py-2.5 align-top text-left font-normal text-fg-muted';

/** The dense variant of {@link GRID_CELL}. */
export const GRID_CELL_DENSE = 'border-t border-l border-border px-2 py-2.5 align-top';

/** The dense variant of {@link GRID_COLUMN_HEADER}. */
export const GRID_COLUMN_HEADER_DENSE =
  'border-t border-l border-border px-2 py-2.5 text-left font-normal';
