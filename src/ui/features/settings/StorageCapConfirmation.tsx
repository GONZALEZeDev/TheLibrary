/**
 * The content of the dialog that asks the player to confirm a lower archive limit: what the limit
 * would remove, and the buttons.
 *
 * It is imported by `StorageSection` only, which owns the dialog and the save of the limit.
 *
 * @packageDocumentation
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { EvictionPreview } from '../../../services/storage.service';
import { Button } from '../../components/Button';
import { DIALOG_ACTIONS_CLASS } from '../../components/button-styles';

/** Props of {@link StorageCapConfirmation}. */
export interface StorageCapConfirmationProps {
  /** What the limit would remove: how many archives, and the room they take. */
  readonly preview: EvictionPreview;
  /** The room the archives take, already written for the language of the interface. */
  readonly size: string;
  /** Called when the player gives up. */
  readonly onCancel: () => void;
  /** Called when the player accepts to remove the archives and lower the limit. */
  readonly onAccept: () => void;
}

/**
 * The content of the confirmation: what the lower limit removes, and the buttons. Cancel comes
 * first, so that it is the button the browser gives the focus to when the dialog opens: the
 * destructive button is never the default.
 *
 * @returns The content of the dialog.
 */
export function StorageCapConfirmation({
  preview,
  size,
  onCancel,
  onAccept,
}: StorageCapConfirmationProps) {
  const { t } = useTranslation();
  // The buttons point at the warning, so that a screen reader reads it with the button that has the
  // focus: `Dialog` names the dialog by its title and has no way to describe it by its content.
  const warningId = useId();
  return (
    <>
      <p id={warningId} className="text-sm">
        {t('settings.storage.confirm.body', { count: preview.evicted, size })}
      </p>
      <div className={DIALOG_ACTIONS_CLASS}>
        <Button look="subtle" aria-describedby={warningId} onClick={onCancel}>
          {t('settings.storage.confirm.cancel')}
        </Button>
        <Button look="destructive" aria-describedby={warningId} onClick={onAccept}>
          {t('settings.storage.confirm.accept')}
        </Button>
      </div>
    </>
  );
}
