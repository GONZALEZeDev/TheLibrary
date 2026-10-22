/**
 * Accessible tabs, following the WAI-ARIA tabs pattern with automatic activation: a tab list whose
 * tabs each show one panel, a roving tab stop, and arrow keys that move the focus and select at once.
 *
 * The component is controlled and generic over the tab ids: the parent owns the selection (a page
 * keeps it in the URL) and decides what the panel shows. Only the selected panel is rendered, so the
 * content of the other tabs is neither built nor loaded until it is chosen.
 *
 * @packageDocumentation
 */
import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/** One tab: the id the parent knows it by, and the label the player reads. */
export interface TabDefinition<T extends string> {
  /** Stable identifier of the tab (for a page, the value of its URL search parameter). */
  readonly id: T;
  /** Visible, already translated name of the tab. */
  readonly label: string;
}

/** Props of {@link Tabs}. */
export interface TabsProps<T extends string> {
  /** Accessible name of the tab list, already translated (for example "Match sections"). */
  readonly label: string;
  /** The tabs, in display order. */
  readonly tabs: readonly TabDefinition<T>[];
  /**
   * Id of the selected tab. The parent owns it, and it must be the id of one of `tabs`: otherwise no
   * tab is a tab stop and the panel's `aria-labelledby` names a tab that does not exist.
   */
  readonly selected: T;
  /**
   * Called with the id of the tab to select: on a click, and when an arrow key, Home or End moves.
   * It is never called for the tab that is already selected, so a parent that navigates on it does
   * not push a duplicate history entry.
   */
  readonly onSelect: (id: T) => void;
  /** Content of the selected panel. The component renders no other panel. */
  readonly children: ReactNode;
}

/**
 * Tab list and the panel of the selected tab.
 *
 * Keyboard (automatic activation): ArrowRight and ArrowLeft move to the next and the previous tab
 * and wrap around the ends, Home and End jump to the first and the last tab. The focus moves with
 * the selection, and only the selected tab is a tab stop, so Tab leaves the list in one press.
 *
 * @returns The tab list followed by the selected panel.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  selected,
  onSelect,
  children,
}: TabsProps<T>) {
  // One id per instance: the ids of the tabs and of the panel are derived from it, so two tab
  // lists on a page never share one.
  const baseId = useId();
  const tabId = (id: T) => `${baseId}-tab-${id}`;
  const panelId = (id: T) => `${baseId}-panel-${id}`;

  // The tab elements by tab id: the arrow keys move the focus to one of them.
  const tabElements = useRef(new Map<T, HTMLButtonElement>());

  // The one way to ask for a selection, for the click and for the keys alike: the tab that is
  // already selected is not asked for again (see `TabsProps.onSelect`).
  const select = (id: T) => {
    if (id !== selected) onSelect(id);
  };

  // Moves the focus and the selection together when the key is one of the tab keys of the pattern.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Alt+ArrowLeft is the browser's "back", for instance: a shortcut is not ours to take.
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const last = tabs.length - 1;
    let target: number;
    switch (event.key) {
      case 'ArrowRight':
        target = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
        target = index === 0 ? last : index - 1;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = last;
        break;
      default:
        return;
    }

    // The key is ours: without this, Home and End would scroll the page and the arrows could move it.
    event.preventDefault();
    const next = tabs[target];
    if (next === undefined) return;
    tabElements.current.get(next.id)?.focus();
    select(next.id);
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
        {tabs.map((tab, index) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element === null) return;
                tabElements.current.set(tab.id, element);
                // React 19 runs this when the element goes away: forget it.
                return () => {
                  tabElements.current.delete(tab.id);
                };
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={isSelected}
              // Only one panel exists, so only the selected tab can point at it.
              aria-controls={isSelected ? panelId(tab.id) : undefined}
              // Roving tab stop: the selected tab is the one stop of the list, the arrows reach the rest.
              tabIndex={isSelected ? 0 : -1}
              onClick={() => {
                select(tab.id);
              }}
              onKeyDown={(event) => {
                handleKeyDown(event, index);
              }}
              // The selected tab is told by its underline and its weight as well as its colour. The
              // underline sits over the list's own border (`-mb-px`).
              className={`-mb-px cursor-pointer border-b-2 px-4 py-2 text-sm whitespace-nowrap ${
                isSelected
                  ? 'border-accent-bright font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:border-border hover:text-fg'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {/* `tabIndex={0}`: the panel can hold no focusable element, and a keyboard user must still be
          able to reach its content (and scroll it). */}
      <div
        role="tabpanel"
        id={panelId(selected)}
        aria-labelledby={tabId(selected)}
        tabIndex={0}
        className="mt-6"
      >
        {children}
      </div>
    </div>
  );
}
