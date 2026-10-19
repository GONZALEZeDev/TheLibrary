/**
 * Tests of the modal dialog.
 *
 * The jsdom stub of `showModal()` and `close()` (see src/test/setup.ts) only toggles the `open`
 * attribute: whether the dialog is modal, and what Escape does, is checked through the calls the
 * component makes and the events it handles.
 *
 * @packageDocumentation
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dialog', () => {
  it('shows its content as a modal dialog named by its title', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');

    render(
      <Dialog open title="Unlink this account?" onClose={vi.fn()}>
        <p>Your matches will be deleted.</p>
      </Dialog>,
    );

    // The accessible name comes from the title, through `aria-labelledby`.
    const dialog = screen.getByRole('dialog', { name: 'Unlink this account?' });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading', { level: 2, name: 'Unlink this account?' })).toBeVisible();
    expect(screen.getByText('Your matches will be deleted.')).toBeVisible();
    // Only `showModal()` gives the focus trap, the backdrop and Escape handling (`show()` would not).
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Title" onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );
    const cancel = new Event('cancel', { cancelable: true });

    // `fireEvent` returns false when a listener called `preventDefault()`.
    const notPrevented = fireEvent(screen.getByRole('dialog'), cancel);

    expect(onClose).toHaveBeenCalledTimes(1);
    // The browser must not close the dialog itself: the parent closes it by clearing `open`.
    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog')).toHaveAttribute('open');
  });

  it('hides its content when closed', () => {
    render(
      <Dialog open={false} title="Title" onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );

    expect(screen.queryByText('Content')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens and closes along with its open prop', () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const { rerender } = render(
      <Dialog open={false} title="Title" onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );

    rerender(
      <Dialog open title="Title" onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Title' })).toBeVisible();
    expect(screen.getByText('Content')).toBeVisible();

    rerender(
      <Dialog open={false} title="Title" onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('does not ask its parent to close when the parent closed it', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open title="Title" onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );

    // Closing the element makes the browser emit a `close` event: that echo is not a user action.
    rerender(
      <Dialog open={false} title="Title" onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );

    expect(onClose).not.toHaveBeenCalled();
  });

  it('tells its parent when the browser closes it by itself', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Title" onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );

    // A `<form method="dialog">` submit, or a second Escape that the browser no longer lets a page
    // cancel, closes the element without going through the `open` prop.
    act(() => {
      screen.getByRole<HTMLDialogElement>('dialog').close();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('may report one gesture twice: the cancel, then the close that follows', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Title" onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );
    const dialog = screen.getByRole<HTMLDialogElement>('dialog');

    // A second Escape in a row: the browser fires `cancel` (which a page can no longer prevent),
    // then closes the dialog. This is why the `onClose` handler of a parent must be idempotent.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    act(() => {
      dialog.close();
    });

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores a close event that arrives after the dialog was opened again', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Title" onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );

    // The element is open, so this event belongs to an earlier close and is not news for the parent.
    fireEvent(screen.getByRole('dialog'), new Event('close'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens and stays silent when effects run twice (StrictMode)', () => {
    const onClose = vi.fn();

    render(
      <StrictMode>
        <Dialog open title="Title" onClose={onClose}>
          <p>Content</p>
        </Dialog>
      </StrictMode>,
    );

    // StrictMode mounts, unmounts and mounts again: the dialog must end up open, and the `close`
    // event of the simulated unmount must not reach the parent.
    expect(screen.getByRole('dialog', { name: 'Title' })).toHaveAttribute('open');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not open an element that is already open', () => {
    const { rerender } = render(
      <Dialog open={false} title="Title" onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    // Something else opened the element (the stub throws when `showModal()` is called twice, as a
    // browser does): the component must adopt that state instead of failing.
    screen.getByRole<HTMLDialogElement>('dialog', { hidden: true }).showModal();

    rerender(
      <Dialog open title="Title" onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Title' })).toHaveAttribute('open');
  });

  it('closes the element when it is unmounted while open', () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const onClose = vi.fn();
    const { unmount } = render(
      <Dialog open title="Title" onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );
    const dialog = screen.getByRole<HTMLDialogElement>('dialog');

    unmount();

    // `close()` takes the element out of the top layer and restores the focus; the parent, which
    // removed the dialog itself, is not told about it.
    expect(close).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveAttribute('open');
    expect(onClose).not.toHaveBeenCalled();
  });
});
