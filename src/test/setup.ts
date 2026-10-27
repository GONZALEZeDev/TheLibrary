/**
 * Global test setup, run by Vitest before every test file (see `test.setupFiles` in vite.config.ts).
 *
 * @packageDocumentation
 */
// Registers the jest-dom matchers (`toBeInTheDocument()`…) on Vitest's `expect`, with their types.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  // With `globals: false`, React Testing Library cannot register its automatic cleanup itself.
  cleanup();
  // Every test starts with an empty localStorage (used by the development settings adapter).
  localStorage.clear();
});

// jsdom does not implement scrolling, and TanStack Router scrolls to the top on every navigation.
window.scrollTo = () => undefined;

// jsdom has no `Element.scrollTo` either, and the router calls it on `<main>` (the element that
// scrolls the pages) to send it to the top of a page opened for the first time. The stub moves the
// element as a browser does, so a test can read the `scrollTop` the router left; a test that must
// see the calls spies on it with `vi.spyOn(Element.prototype, 'scrollTo')`.
Element.prototype.scrollTo = function scrollTo(
  this: Element,
  options?: ScrollToOptions | number,
  y?: number,
): void {
  this.scrollTop = typeof options === 'object' ? (options.top ?? 0) : (y ?? 0);
};

// jsdom stub: focus trapping and Escape are the browser's job. jsdom ships `<dialog>` without
// `showModal()` and `close()`, so the stub keeps the `open` attribute and the `close` event in
// step, as the specification does, and gives the focus back on `close()`, as a browser does. It is
// installed only when `showModal` is missing, so a jsdom release that implements the dialog is never
// shadowed by this simplified copy.
// The `Partial` view is the truth about jsdom: the DOM typings declare both methods as always there.
const jsdomDialog: Partial<HTMLDialogElement> = HTMLDialogElement.prototype;
if (jsdomDialog.showModal === undefined) {
  // The element that had the focus when each dialog was opened, which closing gives it back to.
  const focusBeforeOpening = new WeakMap<HTMLDialogElement, Element | null>();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    // Like a browser (it is stricter than the latest specification for a dialog that is already
    // modal, on purpose): opening twice fails a test instead of passing unnoticed.
    if (this.open) throw new DOMException('The dialog is already open.', 'InvalidStateError');
    focusBeforeOpening.set(this, document.activeElement);
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    // Like a browser, ignore a dialog that is not open: no change, and no `close` event.
    if (!this.open) return;
    this.open = false;
    // Like a browser, give the focus back to the element that had it before the dialog opened,
    // unless that element left the page meanwhile.
    const previous = focusBeforeOpening.get(this);
    focusBeforeOpening.delete(this);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    this.dispatchEvent(new Event('close'));
  };
}
