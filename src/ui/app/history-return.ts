/**
 * What the way back from a match to the history list is made of: the mark the list puts on the
 * entry of a match it opens, and the scroll element of the app, which the router saves and restores.
 *
 * **The mark.** When the player opens a match from the history list, the list writes a flag in the
 * `state` of the new entry of the browser history ({@link OPENED_FROM_HISTORY_STATE}); the match page
 * reads it ({@link wasOpenedFromHistory}) to know that the entry just before it is the list, with its
 * filters in the address, so that going one step back returns to it. The flag belongs to the entry,
 * not to a page in memory, so it is right whatever happens to the page afterwards:
 * - a match opened from anywhere else (the dashboard, the review, a typed address, a link of another
 *   match) has no flag, and its way back is a new visit of the list;
 * - a reload keeps the entry and its flag, which is right: the entry before it is still the list,
 *   so a step back from the reloaded page still returns to it;
 * - the tabs of the match replace its entry and carry the flag over (`state: true`), so one step
 *   back from any tab is the list.
 *
 * **The scroll.** Every page of the app scrolls inside the one `<main>` of the shell, not the window,
 * so the router has to be told which element to save and restore ({@link MAIN_SCROLL_ATTRIBUTES}, and
 * the selector {@link MAIN_SCROLL_SELECTOR} for the scroll to the top of a page that is not returned
 * to).
 *
 * @packageDocumentation
 */
import type { HistoryState } from '@tanstack/react-router';

declare module '@tanstack/react-router' {
  /**
   * What the app writes in the `state` of a browser history entry (the router re-exports this
   * interface for the applications to extend), so that links and navigations accept the flag and the
   * location types it.
   */
  interface HistoryState {
    /** Set by the history list on the entry of a match it opens, see {@link wasOpenedFromHistory}. */
    openedFromHistory?: true;
  }
}

/**
 * The `state` the history list gives to the entry of a match it opens, for the `state` option of a
 * link or of a navigation.
 */
export const OPENED_FROM_HISTORY_STATE = { openedFromHistory: true } as const;

/**
 * Tell whether a history entry was opened from the history list.
 *
 * @param state - The `state` of the entry, as the router reads it from the location.
 * @returns `true` when the list wrote {@link OPENED_FROM_HISTORY_STATE} on the entry.
 */
export function wasOpenedFromHistory(state: HistoryState): boolean {
  return state.openedFromHistory === true;
}

/**
 * The attribute the router looks for to find the element it saves and restores the scroll of. It
 * gives the element a name that does not depend on its place in the page, which the router would
 * otherwise write as a path of `nth-child` selectors that breaks as soon as the shell changes.
 */
export const MAIN_SCROLL_ATTRIBUTES = { 'data-scroll-restoration-id': 'main' } as const;

/**
 * The selector of the element that has {@link MAIN_SCROLL_ATTRIBUTES}: the router scrolls it to the
 * top when a page opens that was not visited before (`scrollToTopSelectors`), which it would not do
 * for an element other than the window.
 */
export const MAIN_SCROLL_SELECTOR = '[data-scroll-restoration-id="main"]';
