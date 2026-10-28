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
 * Where the panel stands is worked out on screen ({@link placePanel}), not in the page: the panel is
 * fixed to the window, under the wrapper, or above it when the window has no room under it, and
 * always inside the window. Placed in the page, it was cut by what holds the rows: the families of
 * the match page flow in two columns, and the end of the panel of a row at the bottom of the first
 * column was sent to the top of the second. It stays a child of the wrapper all the same, so that
 * the pointer over the panel is still over the wrapper and the style sheet keeps it open.
 *
 * @packageDocumentation
 */
import {
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/** Which edge of the wrapper the panel is anchored to. */
export type PanelPlacement = 'start' | 'end';

/** The room, in pixels, the panel keeps from the edges of the window. */
const WINDOW_MARGIN = 8;

/** A box on screen, in pixels from the top left corner of the window. */
export interface ScreenBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** A size on screen, in pixels. */
export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Keep a position inside a range, the start winning when the range is too small.
 *
 * @param value - The position wanted.
 * @param min - The lowest position allowed.
 * @param max - The highest position allowed.
 * @returns The position, moved into the range.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Work out where the panel stands on screen.
 *
 * @param anchor - The box of the wrapper.
 * @param panel - The size of the panel.
 * @param viewport - The size of the window.
 * @param placement - Which edge of the wrapper the panel lines up with.
 * @returns The top left corner of the panel. It is under the wrapper when it fits there, above it
 *   when it fits there instead, and otherwise on the side with the more room. It lines up with the
 *   left edge of the wrapper (`start`) or its right edge (`end`). Either way it is then moved, as
 *   little as needed, to stay {@link WINDOW_MARGIN} pixels inside the window; a panel larger than
 *   the window keeps its top left corner inside.
 */
export function placePanel(
  anchor: ScreenBox,
  panel: ScreenSize,
  viewport: ScreenSize,
  placement: PanelPlacement,
): { readonly top: number; readonly left: number } {
  const below = anchor.top + anchor.height;
  const above = anchor.top - panel.height;
  const fitsBelow = below + panel.height <= viewport.height - WINDOW_MARGIN;
  const fitsAbove = above >= WINDOW_MARGIN;
  const roomBelow = viewport.height - below;
  const wantedTop = fitsBelow || (!fitsAbove && roomBelow >= anchor.top) ? below : above;
  const wantedLeft = placement === 'start' ? anchor.left : anchor.left + anchor.width - panel.width;
  return {
    top: clamp(wantedTop, WINDOW_MARGIN, viewport.height - WINDOW_MARGIN - panel.height),
    left: clamp(wantedLeft, WINDOW_MARGIN, viewport.width - WINDOW_MARGIN - panel.width),
  };
}

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
   * Which edge of the wrapper the panel is anchored to: `start` (the default) lines it up with the
   * left edge of the wrapper, `end` with its right edge. A row of a list uses `end`, so that the
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { hovered, focused, dismissed } = panel;
  // The text of the panel, one value for its lines: the lines are a new array on each render of the
  // row, and the panel is placed again only when what it says changes.
  const text = lines.join('\n');

  // While the pointer or the focus is on the wrapper, the panel is placed before the page is drawn,
  // then again whenever the page scrolls (any scrolling element, hence the capture) or the window
  // changes size, so that it follows its wrapper. The effect runs again on each coming and leaving
  // of the pointer and of the focus, so that the panel is measured as the style sheet shows it then.
  // The position is written on the element itself: it changes nothing React renders.
  //
  // The panel stays invisible until it is placed (`data-placed`): a row that comes under a pointer
  // that does not move is hovered for the style sheet before any event says so, and its panel would
  // otherwise show in the corner of the window. It is not placed while the style sheet hides it (a
  // focus given by a click is not a keyboard focus), since a hidden panel has no size to place by,
  // nor while its wrapper is out of the window, where it would float over other rows.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const element = panelRef.current;
    if (!(hovered || focused) || dismissed || wrapper === null || element === null) {
      return undefined;
    }
    const place = () => {
      const { clientWidth, clientHeight } = document.documentElement;
      const anchor = wrapper.getBoundingClientRect();
      const outOfWindow = anchor.top + anchor.height < 0 || anchor.top > clientHeight;
      if (element.getClientRects().length === 0 || outOfWindow) {
        delete element.dataset.placed;
        return;
      }
      const { top, left } = placePanel(
        anchor,
        element.getBoundingClientRect(),
        { width: clientWidth, height: clientHeight },
        placement,
      );
      element.style.top = `${String(top)}px`;
      element.style.left = `${String(left)}px`;
      element.dataset.placed = '';
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      delete element.dataset.placed;
    };
  }, [hovered, focused, dismissed, placement, text]);

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
      ref={wrapperRef}
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
        ref={panelRef}
        id={panelId}
        role="tooltip"
        // Which edge the panel lines up with, written on it so that the page says how it is placed.
        data-placement={placement}
        className={`invisible fixed top-0 left-0 z-50 w-max data-placed:visible max-w-72 space-y-1 rounded-lg border border-border bg-surface-raised p-3 text-xs leading-normal shadow-lg ${
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
