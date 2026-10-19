/**
 * The dialog the player goes through to sign in with Steam and link the account, or to replace the
 * linked account with another one.
 *
 * It walks four steps. `confirm_switch` (only when an account is linked already) warns that the data
 * of that account will be deleted; `explain` tells what the sign-in does before the browser opens;
 * `waiting` lasts until the sign-in is over; `outcome` says how it ended. A new account closes the
 * dialog by itself: the screens behind already show it.
 *
 * The steps are read from the state of the link mutation, so that they cannot disagree with it. The
 * mutation stays pending until the link is over, including the erasure of the previous account's
 * data on a switch and the reset of the screens that follows. The dialog never shows an outcome or
 * closes before that.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { LinkSteps } from './LinkSteps';
import { useCancelLink } from './use-account';

/** Props of {@link LinkSteamDialog}. */
export interface LinkSteamDialogProps {
  /** Whether the dialog is shown. The parent owns this state and clears it in `onClose`. */
  readonly open: boolean;
  /**
   * `link` when no account is linked, `switch` when the player replaces the linked account with
   * another one: the dialog then starts by warning that the data of that account will be deleted.
   */
  readonly mode: 'link' | 'switch';
  /**
   * The persona name of the account that a switch replaces, or `null` when it has none (the warning
   * then says "Steam player"). Ignored in `link` mode.
   */
  readonly currentName: string | null;
  /**
   * Called when the dialog must close: the player closed it, or the account is linked. The parent
   * closes it by clearing `open`. It may be called more than once for one gesture, so it must be
   * idempotent.
   */
  readonly onClose: () => void;
}

/**
 * Dialog that signs the player in with Steam and links the account.
 *
 * Whatever closes it (Escape, a close the browser makes by itself, a Close or Cancel button, a
 * finished link) gives up the sign-in first, so a sign-in never goes on behind a dialog that is
 * gone. Giving up when none is in progress does nothing, which keeps the handler idempotent: one
 * gesture can ask twice (see `DialogProps.onClose`).
 *
 * @returns The dialog.
 */
export function LinkSteamDialog({ open, mode, currentName, onClose }: LinkSteamDialogProps) {
  const { t } = useTranslation();
  const cancelLink = useCancelLink();

  const handleClose = () => {
    cancelLink();
    onClose();
  };

  return (
    <Dialog open={open} title={t('account.link.title')} onClose={handleClose}>
      <LinkSteps mode={mode} currentName={currentName} onClose={handleClose} />
    </Dialog>
  );
}
