/**
 * The button that starts the Steam sign-in, with the dialog it opens. Screens place it wherever the
 * player can link an account (the dashboard, the settings, the sidebar, the empty states).
 *
 * @packageDocumentation
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BUTTON_CLASSES, type ButtonLook } from '../../components/button-styles';
import { LinkSteamDialog, type LinkSteamDialogProps } from './LinkSteamDialog';

/** Props of {@link LinkAccountButton}. */
export interface LinkAccountButtonProps {
  /**
   * `link` (the default) when no account is linked, `switch` to replace the linked account with
   * another one: the dialog then warns that the data of that account will be deleted.
   */
  readonly mode?: LinkSteamDialogProps['mode'];
  /** The persona name of the account a switch replaces; `null` or missing when it has none. */
  readonly currentName?: string | null;
  /** The text of the button; "Link my Steam account" by default. */
  readonly label?: string;
  /**
   * `primary` (the default), a filled button, or `subtle`, a bordered one. The `destructive` look is
   * not offered: the button only opens a dialog, which warns before anything is deleted.
   */
  readonly variant?: Exclude<ButtonLook, 'destructive'>;
  /**
   * Whether the button cannot be pressed (`false` by default), for a screen that must not let the
   * player start a sign-in just now. It only affects the button: a dialog that is open stays open
   * and usable, so that a sign-in already started can be followed to its end.
   */
  readonly disabled?: boolean;
}

/**
 * Button that opens the Steam link dialog. It holds whether the dialog is open.
 *
 * @returns The button and its dialog.
 */
export function LinkAccountButton({
  mode = 'link',
  currentName = null,
  label,
  variant = 'primary',
  disabled = false,
}: LinkAccountButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
        }}
        className={BUTTON_CLASSES[variant]}
      >
        {label ?? t('account.link.button')}
      </button>
      <LinkSteamDialog
        open={open}
        mode={mode}
        currentName={currentName}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}
