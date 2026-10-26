/**
 * Modal dialog built on the native `<dialog>` element, for short messages and confirmations (the
 * Steam link dialog, the unlink confirmation).
 *
 * The browser provides what a hand-made overlay would have to rebuild: the focus trap, the inert
 * page behind, the backdrop, focus restoration on close, and the Escape key.
 *
 * @packageDocumentation
 */
import { useEffectEvent, useId, useLayoutEffect, useRef } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import { PANEL_CLASSES } from './Panel';

/** Props of {@link Dialog}. */
export interface DialogProps {
  /** Whether the dialog is shown. The parent owns this state and clears it in `onClose`. */
  readonly open: boolean;
  /** Title of the dialog, rendered as an `<h2>` that also gives the dialog its accessible name. */
  readonly title: string;
  /**
   * Called when the dialog asks to be closed. The parent closes it by clearing `open`.
   *
   * Two things trigger it, and only the first can be refused:
   * - Escape. The dialog stays open until the parent clears `open`, so the parent may ignore the
   *   call (for example while a request is running).
   * - A close the browser performs by itself, which a page cannot cancel: a
   *   `<form method="dialog">` submit, or a second Escape in a row. The element is already closed
   *   when the call arrives, so ignoring it leaves `open` true over a closed dialog.
   *
   * One gesture can trigger both (the second Escape fires `cancel`, then the browser closes the
   * dialog), so the call can arrive more than once: the handler must be idempotent.
   */
  readonly onClose: () => void;
  /** Content shown under the title. It is mounted only while the dialog is open. */
  readonly children: ReactNode;
}

/**
 * Modal dialog with a title and free content.
 *
 * @returns The `<dialog>` element, which is hidden by the browser while `open` is false.
 */
export function Dialog({ open, title, onClose, children }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Reads the latest `onClose` without being a dependency of the effect below: a new handler on
  // every render must not close and reopen the dialog.
  const notifyParent = useEffectEvent(onClose);

  // `open` is a React prop but the element is opened through methods, so the two are synchronised
  // here, before the browser paints, so closing never shows a frame with an emptied panel.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null) return;

    // The browser can close the element by itself (see `DialogProps.onClose`): the parent must be
    // told, or its `open` state would stay true over a closed dialog. `dialog.open` is checked
    // because a `close` event can be delivered after the dialog was opened again.
    const handleClose = () => {
      if (!dialog.open) notifyParent();
    };
    dialog.addEventListener('close', handleClose);
    // `showModal()` throws when the dialog is already open: this is a safety net, as the cleanup
    // below always closes the element before the effect runs again (including in StrictMode).
    if (!dialog.open) dialog.showModal();

    return () => {
      // Detached first: closing the element on our side (the parent cleared `open`, or the dialog
      // is unmounted) is not the browser closing it, and must not be reported back to the parent.
      dialog.removeEventListener('close', handleClose);
      // Closing through `close()` also takes an unmounted dialog out of the top layer and gives
      // the focus back to the element that had it before the dialog opened.
      if (dialog.open) dialog.close();
    };
  }, [open]);

  // Escape fires `cancel` before the browser closes the dialog. Preventing it keeps the parent in
  // charge: the dialog closes only when the parent clears `open`.
  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={handleCancel}
      // The look of a panel with room around the content. `m-auto` centres the modal: Tailwind's
      // preflight resets the margin that the browser's default stylesheet uses for that.
      className={`${PANEL_CLASSES.base} ${PANEL_CLASSES.padding.roomy} m-auto w-[calc(100%-2rem)] max-w-md text-fg backdrop:bg-bg/70`}
    >
      {open && (
        <>
          {/* `break-words`: a title that names a long persona name with no space must wrap, not
              overflow the dialog. */}
          <h2 id={titleId} className="text-lg font-medium break-words">
            {title}
          </h2>
          <div className="mt-4">{children}</div>
        </>
      )}
    </dialog>
  );
}
