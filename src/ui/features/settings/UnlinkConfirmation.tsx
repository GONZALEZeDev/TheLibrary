/**
 * The content of the dialog that asks the player to confirm an unlink: what the unlink deletes, the
 * progress once it runs, and the buttons.
 *
 * It is imported by `AccountSection` only, which owns the dialog and the unlink.
 *
 * @packageDocumentation
 */
import { LoaderCircle } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { DIALOG_ACTIONS_CLASS } from '../../components/button-styles';
import { focusOnMount } from '../../components/focus-on-mount';

/** Props of {@link UnlinkConfirmation}. */
export interface UnlinkConfirmationProps {
  /** Whether the unlink is running: it can then be neither confirmed again nor given up. */
  readonly running: boolean;
  /** Called when the player gives up. */
  readonly onCancel: () => void;
  /** Called when the player confirms the unlink. */
  readonly onConfirm: () => void;
}

/**
 * The content of the confirmation: what the unlink deletes, the progress once it runs, and the
 * buttons. Cancel comes first, so that it is the button the browser gives the focus to when the
 * dialog opens: the destructive button is never the default.
 *
 * @returns The content of the dialog.
 */
export function UnlinkConfirmation({ running, onCancel, onConfirm }: UnlinkConfirmationProps) {
  const { t } = useTranslation();
  // The buttons point at the warning, so that a screen reader reads it with the button that has the
  // focus: `Dialog` names the dialog by its title and has no way to describe it by its content.
  const warningId = useId();
  return (
    <>
      <p id={warningId} className="text-sm">
        {t('account.unlink.warning')}
      </p>
      {running && (
        // The focus moves here when the unlink starts: the button that was pressed is disabled by
        // then, and the focus would fall to the page behind the dialog.
        <p
          role="status"
          tabIndex={-1}
          ref={focusOnMount}
          className="mt-4 flex items-center gap-2 text-sm text-fg-muted"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-accent-bright"
          />
          {t('account.unlink.running')}
        </p>
      )}
      <div className={DIALOG_ACTIONS_CLASS}>
        <Button look="subtle" aria-describedby={warningId} disabled={running} onClick={onCancel}>
          {t('account.link.cancel')}
        </Button>
        <Button
          look="destructive"
          aria-describedby={warningId}
          disabled={running}
          onClick={onConfirm}
        >
          {t('account.unlink.confirm')}
        </Button>
      </div>
    </>
  );
}
