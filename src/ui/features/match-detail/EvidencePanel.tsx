/**
 * The panel of evidence of the match page: a row or a cell with the lines of text it is built from
 * behind it.
 *
 * The page shows a gauge, a bar and a gap; the panel gives the figures they come from. It does not
 * know what it is about: whoever uses it (the metrics of the analysis through `Evidence`, the damage
 * sources of the damage tab) gives the name of what it describes and the lines to say. The panel opens
 * when the pointer is over the wrapper and when the keyboard focus is on it, so that it is not for the
 * mouse alone. The Escape key closes it until the pointer and the focus have both left.
 *
 * Showing and hiding is left to the style sheet (the `group-hover` and `group-focus-visible`
 * variants): the panel is always in the page, so that it is the description of the wrapper for
 * assistive technologies whether it is on screen or not. The wrapper is named after what it describes.
 * The wrapper itself takes the focus, so `focus-visible` is what a keyboard gives it and a click does
 * not: a click on a row no longer pins its panel over the rows below. A row may hold a link (the
 * summary of the review links each point to its tab); the link is reached after the wrapper, and
 * focusing it neither opens nor pins the panel, which follows the wrapper's own `focus-visible`.
 *
 * @packageDocumentation
 */
import { useId, useReducer, type KeyboardEvent, type ReactNode } from 'react';

/** Which edge of the wrapper the panel is anchored to. */
export type PanelPlacement = 'start' | 'end';

/** The classes that anchor the panel, by placement. Each is a complete literal for Tailwind. */
const PLACEMENT_CLASSES: Readonly<Record<PanelPlacement, string>> = {
  start: 'left-0',
  end: 'right-0 left-auto',
};

/** Props of {@link EvidencePanel}. */
export interface EvidencePanelProps {
  /** The name of what the panel is about, which names the wrapper for assistive technologies. */
  readonly label: string;
  /**
   * What the panel says, one line each, in reading order. A line is also the key of its paragraph, so
   * two lines of one panel are never the same text.
   */
  readonly lines: readonly string[];
  /** What the panel is about: the row or the cell that shows the figures. */
  readonly children: ReactNode;
  /**
   * Which edge of the wrapper the panel is anchored to: `start` (the default) opens it under the
   * wrapper from its left edge, `end` from its right edge. A row of a list uses `end`, so that the
   * panel, which hangs over the rows below, leaves their names free: a pointer going down the names
   * then reaches the next row instead of staying on the panel of the one above.
   */
  readonly placement?: PanelPlacement;
}

/**
 * What decides whether the panel is on screen: where the pointer and the focus are, and whether the
 * Escape key closed the panel since either came.
 */
interface PanelState {
  /** Whether the pointer is over the wrapper (or its panel). */
  readonly hovered: boolean;
  /** Whether the focus is on the wrapper. */
  readonly focused: boolean;
  /** Whether Escape closed the panel, which stays closed until neither the pointer nor the focus is there. */
  readonly dismissed: boolean;
}

/** What happens to the panel: the pointer and the focus coming and leaving, and the Escape key. */
type PanelEvent = 'pointer_enter' | 'pointer_leave' | 'focus' | 'blur' | 'escape';

/** The state of a panel nobody has reached. */
const PANEL_CLOSED: PanelState = { hovered: false, focused: false, dismissed: false };

/**
 * Work out the state of the panel after something happened to it.
 *
 * The state is one value changed by a reducer, and not three flags, because the pointer and the
 * focus can leave one just after the other: each change must be read against the latest state, not
 * against the one a handler saw when it was made.
 *
 * @param state - The state before.
 * @param event - What happened.
 * @returns The state after. An Escape that closed the panel holds while the pointer or the focus is
 *   still there, and is forgotten when both have left, so that the panel opens again when either
 *   comes back.
 */
function nextPanelState(state: PanelState, event: PanelEvent): PanelState {
  switch (event) {
    case 'pointer_enter':
      return { ...state, hovered: true };
    case 'pointer_leave':
      return { ...state, hovered: false, dismissed: state.dismissed && state.focused };
    case 'focus':
      return { ...state, focused: true };
    case 'blur':
      return { ...state, focused: false, dismissed: state.dismissed && state.hovered };
    case 'escape':
      return { ...state, dismissed: true };
  }
}

/**
 * A row or a cell of the match page, with the panel of the evidence behind it.
 *
 * @returns A wrapper that takes the keyboard focus, named after what it describes, holding what it is
 *   given and the panel, which describes the wrapper.
 */
export function EvidencePanel({ label, lines, children, placement = 'start' }: EvidencePanelProps) {
  const panelId = useId();
  const [panel, send] = useReducer(nextPanelState, PANEL_CLOSED);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      send('escape');
    }
  };

  return (
    // A row of figures is no control, but the keyboard has to reach it for the panel to open without
    // a pointer, and Escape has to close the panel from there. The two rules disabled here are for
    // the cases where focus means "something to press", which this is not.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="group"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-describedby={panelId}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        send('focus');
      }}
      onBlur={() => {
        send('blur');
      }}
      onMouseEnter={() => {
        send('pointer_enter');
      }}
      onMouseLeave={() => {
        send('pointer_leave');
      }}
      className="group relative rounded-lg"
    >
      {children}
      <div
        id={panelId}
        role="tooltip"
        className={`absolute top-full ${PLACEMENT_CLASSES[placement]} z-20 w-max max-w-[min(18rem,100%)] space-y-1 rounded-lg border border-border bg-surface-raised p-3 text-xs leading-normal shadow-lg ${
          panel.dismissed ? 'hidden' : 'hidden group-focus-visible:block group-hover:block'
        }`}
      >
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
}
