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

// jsdom stub: focus trapping and Escape are the browser's job. jsdom ships `<dialog>` without
// `showModal()` and `close()`, so the stub only keeps the `open` attribute and the `close` event
// in step, as the specification does. It is installed only when `showModal` is missing, so a
// jsdom release that implements the dialog is never shadowed by this simplified copy.
// The `Partial` view is the truth about jsdom: the DOM typings declare both methods as always there.
const jsdomDialog: Partial<HTMLDialogElement> = HTMLDialogElement.prototype;
if (jsdomDialog.showModal === undefined) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    // Like a browser (it is stricter than the latest specification for a dialog that is already
    // modal, on purpose): opening twice fails a test instead of passing unnoticed.
    if (this.open) throw new DOMException('The dialog is already open.', 'InvalidStateError');
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    // Like a browser, ignore a dialog that is not open: no change, and no `close` event.
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
