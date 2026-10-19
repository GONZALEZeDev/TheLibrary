/**
 * The `ref` callback that moves the focus to an element as it appears.
 *
 * @packageDocumentation
 */

/**
 * Move the focus to an element as it appears (a `ref` callback). It is for an element that takes the
 * place of the one the player just used: that one is gone, or disabled, and a focus on an element that
 * is gone or disabled falls back to the page behind a dialog. In a step of a dialog, the first button
 * takes it: it is also where the browser puts the focus when the dialog opens.
 *
 * @param element - The element that appeared, or `null` when it is removed.
 */
export function focusOnMount(element: HTMLElement | null): void {
  element?.focus();
}
