/**
 * The steps of the Steam link dialog and the link they drive: the warning of a switch, the
 * explanation of the sign-in, the wait for Steam, and how the sign-in ended.
 *
 * It is the content of `LinkSteamDialog` and is imported by it only.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { LoaderCircle } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppError } from '../../../core/errors/app-error';
import type { LinkResult } from '../../../services/account.service';
import { Button } from '../../components/Button';
import { DIALOG_ACTIONS_CLASS } from '../../components/button-styles';
import { focusOnMount } from '../../components/focus-on-mount';
import { accountDisplayName } from './display-name';
import type { LinkSteamDialogProps } from './LinkSteamDialog';
import { useCancelLink, useLinkAccount } from './use-account';

/** What the dialog says when the sign-in is over. */
interface Outcome {
  /** The sentence; `null` when the account was linked, because the dialog is then closing. */
  readonly message: string | null;
  /** Whether the sign-in failed: the sentence is announced at once and the player can try again. */
  readonly failed: boolean;
}

/**
 * Tell that the link failed to run, by the kind of the error. The service throws an `AppError` of
 * kind `storage` when the stored link cannot be read or saved, but whatever is thrown is told.
 *
 * @param error - What the mutation failed with. It is not necessarily an `Error`: anything can be
 *   thrown, and `toAppError` gives it a kind all the same.
 * @param t - Translation function.
 * @returns What to say.
 */
function describeError(error: unknown, t: TFunction): Outcome {
  // Told by its kind, as everywhere else: the message of an error is for the logs.
  return { message: t(`errors.kind.${toAppError(error).kind}`), failed: true };
}

/**
 * Tell how a sign-in ended, in the language of the interface.
 *
 * @param result - How the link ended.
 * @param t - Translation function.
 * @returns What to say.
 */
function describeResult(result: LinkResult, t: TFunction): Outcome {
  if (result.kind === 'linked') {
    return { message: null, failed: false };
  }
  // The same account again is news, not a failure: signing in once more would say the same.
  return {
    message: t(`account.link.outcome.${result.kind}`),
    failed: result.kind !== 'already_linked',
  };
}

/** Props of {@link LinkSteps}. */
export interface LinkStepsProps {
  /** `link` when no account is linked, `switch` when the player replaces the linked account. */
  readonly mode: LinkSteamDialogProps['mode'];
  /** The persona name of the account a switch replaces, or `null` when it has none. */
  readonly currentName: string | null;
  /** Gives up the sign-in in progress, if any, and closes the dialog. */
  readonly onClose: () => void;
}

/**
 * The steps of the dialog and the link they drive.
 *
 * It is separate from `LinkSteamDialog` because the dialog mounts its content only while it is
 * open: the link mutation and the player's answer to the warning live and die with one opening, so a
 * dialog opened again starts from its first step and shows nothing of the last attempt.
 *
 * @returns The content of the step that is current.
 */
export function LinkSteps({ mode, currentName, onClose }: LinkStepsProps) {
  const { t } = useTranslation();
  const link = useLinkAccount();
  const cancelLink = useCancelLink();
  // Whether the player accepted that the account being replaced is deleted (`switch` mode only).
  const [switchConfirmed, setSwitchConfirmed] = useState(false);
  // Whether the player pressed Cancel while waiting. The sign-in is being given up, or, when Steam
  // already confirmed it, goes on to its end: either way a second press would do nothing.
  const [givingUp, setGivingUp] = useState(false);
  // The text of the step before the sign-in (the warning, then the explanation). The buttons below
  // it point at it, so that a screen reader reads it with the button that has the focus: `Dialog`
  // names the dialog by its title and has no way to describe it by its content.
  const textId = useId();

  const startSignIn = () => {
    setGivingUp(false);
    link.mutate(undefined, {
      // Called only while this content is on screen: a sign-in that ends after the dialog was closed
      // (it was cancelled, say) finds nobody to tell, and cannot reopen the dialog or fail.
      onSuccess: (result) => {
        if (result.kind === 'linked') {
          onClose();
        }
      },
    });
  };

  // Each step has its own key: its buttons are new elements, not the buttons of the last step with
  // another label, so the focus (see `focusOnMount`) and the hover state do not carry over.
  if (link.isPending) {
    return (
      <Fragment key="waiting">
        <p role="status" className="flex items-center gap-2 text-sm">
          <LoaderCircle
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-accent-bright"
          />
          {t('account.link.waiting')}
        </p>
        <div className={DIALOG_ACTIONS_CLASS}>
          {/* Gives up the sign-in but keeps the dialog: it goes on to say that it was cancelled. */}
          <Button
            look="subtle"
            ref={focusOnMount}
            disabled={givingUp}
            onClick={() => {
              setGivingUp(true);
              cancelLink();
            }}
          >
            {t('account.link.cancel')}
          </Button>
        </div>
      </Fragment>
    );
  }

  if (link.isIdle) {
    // The two steps before the sign-in look alike: a text, then Cancel and Continue.
    const confirming = mode === 'switch' && !switchConfirmed;
    return (
      <Fragment key={confirming ? 'confirm_switch' : 'explain'}>
        <p id={textId} className={confirming ? 'text-sm' : 'text-sm text-fg-muted'}>
          {confirming
            ? t('account.switch.warning', { name: accountDisplayName(currentName, t) })
            : t('account.link.explanation')}
        </p>
        <div className={DIALOG_ACTIONS_CLASS}>
          <Button look="subtle" ref={focusOnMount} aria-describedby={textId} onClick={onClose}>
            {t('account.link.cancel')}
          </Button>
          <Button
            look="primary"
            aria-describedby={textId}
            onClick={
              confirming
                ? () => {
                    setSwitchConfirmed(true);
                  }
                : startSignIn
            }
          >
            {t('account.link.continue')}
          </Button>
        </div>
      </Fragment>
    );
  }

  const outcome = link.isError ? describeError(link.error, t) : describeResult(link.data, t);
  return (
    <Fragment key="outcome">
      {outcome.message !== null && (
        <p role={outcome.failed ? 'alert' : 'status'} className="text-sm">
          {outcome.message}
        </p>
      )}
      <div className={DIALOG_ACTIONS_CLASS}>
        <Button look={outcome.failed ? 'subtle' : 'primary'} ref={focusOnMount} onClick={onClose}>
          {t('account.link.close')}
        </Button>
        {outcome.failed && (
          <Button
            look="primary"
            onClick={() => {
              // Back to the explanation: the answer to the warning of a switch is kept.
              link.reset();
            }}
          >
            {t('account.link.retry')}
          </Button>
        )}
      </div>
    </Fragment>
  );
}
