/**
 * The Steam account section of the settings: the linked account (picture, name and link date) with
 * the two ways out of it, switching to another account and unlinking, or the way to link an account
 * when none is.
 *
 * Unlinking deletes every local data of the account, so it asks first, in a dialog that names the
 * account and says what goes. The unlink is owned by the section and not by the dialog: it goes on
 * when the dialog is gone, and the section tells how it ended once it has. A browser can close the
 * dialog under a running unlink (a second Escape in a row cannot be refused by a page), and an
 * outcome that lived in the dialog would be lost with it.
 *
 * A link that cannot be read (its row is damaged) is told as such, and can still be unlinked: the
 * unlink needs only the id of the account, and it is the way out of a link the app cannot use. It is
 * never given the way to link or switch to another account, which could erase the data of the one the
 * app lost.
 *
 * @packageDocumentation
 */
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LinkedAccount } from '../../../core/account/linked-account';
import type { AccountId } from '../../../core/domain/account';
import { toAppError } from '../../../core/errors/app-error';
import { Dialog } from '../../components/Dialog';
import { ACCOUNT_QUERY_KEY, useLinkedAccount, useUnlinkAccount } from '../account/use-account';
import { AccountSummary, type Confirmation } from './AccountSummary';
import { UnlinkConfirmation } from './UnlinkConfirmation';

/** What the section says when an unlink is over. */
interface UnlinkOutcome {
  /** The sentence. */
  readonly message: string;
  /** Whether the unlink failed: the sentence is an alert, and the account is still linked. */
  readonly failed: boolean;
}

/**
 * Whether the account an unlink was asked for is still the one the section stands for.
 *
 * @param account - The linked account, `null` when none is, `undefined` while it is not known (it is
 *   being read, or it cannot be).
 * @param attemptedId - The account the unlink was asked for, or `null` for the account that could not
 *   be read: it stays the one the section stands for as long as it cannot be read.
 * @returns Whether the section still shows that account.
 */
function isStillShown(
  account: LinkedAccount | null | undefined,
  attemptedId: AccountId | null,
): boolean {
  return attemptedId === null ? account === undefined : account?.accountId === attemptedId;
}

/**
 * Tell how the last unlink ended, if there is one to tell.
 *
 * Both outcomes are about one account, and are told only while that is what the section shows. A
 * success is told while no account is linked: a player who has linked another one since is not told
 * that "the account" was unlinked. A failure is told while the account the unlink was for is still
 * the linked one: it is there for the player to retry, and an account they switched to since has
 * nothing to do with it.
 *
 * @param unlink - The unlink mutation.
 * @param account - The linked account, `null` when none is, `undefined` while it is not known.
 * @param attempt - What the last unlink was asked for, or `null` when none was.
 * @param t - Translation function.
 * @returns What to say, or `null` when there is nothing to say.
 */
function describeUnlink(
  unlink: ReturnType<typeof useUnlinkAccount>,
  account: LinkedAccount | null | undefined,
  attempt: Confirmation | null,
  t: TFunction,
): UnlinkOutcome | null {
  if (unlink.isError && attempt !== null && isStillShown(account, attempt.accountId)) {
    // Told by its kind, as everywhere else: the message of an error is for the logs.
    return { message: t(`errors.kind.${toAppError(unlink.error).kind}`), failed: true };
  }
  if (unlink.isSuccess && account === null) {
    const done = t('account.unlink.done');
    // The account is unlinked either way; what could not be deleted is finished at the next start.
    return {
      message: unlink.data.complete ? done : `${done} ${t('account.unlink.incomplete')}`,
      failed: false,
    };
  }
  return null;
}

/**
 * The Steam account section of the settings.
 *
 * @returns The section.
 */
export function AccountSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const account = useLinkedAccount();
  const unlink = useUnlinkAccount();
  // A link or an unlink is in progress, started from here or from anywhere else. An unlink asked
  // for now would queue behind a link that succeeds, and erase the account it has just linked; a
  // sign-in would queue behind an unlink. A link that the player gave up with Escape can still be
  // running (Steam had already confirmed it), so the dialogs are not a guard on their own.
  const accountChanging = useIsMutating({ mutationKey: ACCOUNT_QUERY_KEY }) > 0;
  const headingId = useId();
  // What the confirmation is about, or `null` while it is closed. It is kept as the confirmation
  // opens: the account is read again while the unlink ends (its caches are reset), and the title
  // must not turn into "Steam player" under the player's eyes.
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  // What the last unlink was asked for, which scopes the failure to tell (see `describeUnlink`).
  const [attempt, setAttempt] = useState<Confirmation | null>(null);
  const outcomeRef = useRef<HTMLParagraphElement>(null);

  const openConfirmation = (opened: Confirmation) => {
    // A new attempt starts from a clean section: the failure of the last one is not repeated.
    unlink.reset();
    setConfirmation(opened);
  };

  // Escape is refused while the unlink runs (the dialog stays open until the parent clears `open`),
  // but a close the browser makes by itself is not: the dialog is then closed and `confirmation`
  // still set until the unlink ends. That is harmless, as the unlink goes on either way and the
  // section tells its outcome. This handler is idempotent, as one gesture can call it twice.
  const closeConfirmation = () => {
    if (!unlink.isPending) {
      setConfirmation(null);
    }
  };

  const confirmUnlink = () => {
    // Asked of the query client and not of `unlink`: a second activation (a double click, a key
    // that repeats) can arrive before the buttons are drawn as disabled, while this render still
    // says that nothing is running. A mutation is pending the moment it is started. Two unlinks
    // would also tell the outcome of the second, which finds nothing left to delete and says that
    // everything was.
    if (confirmation === null || queryClient.isMutating({ mutationKey: ACCOUNT_QUERY_KEY }) > 0) {
      return;
    }
    setAttempt(confirmation);
    unlink.mutate(undefined, {
      // Whatever it came to, the dialog has nothing more to say: the section tells the outcome.
      onSettled: () => {
        setConfirmation(null);
      },
    });
  };

  const outcome = describeUnlink(unlink, account.data, attempt, t);
  const hasOutcome = outcome !== null;
  const confirmationClosed = confirmation === null;
  // When the dialog has closed on an outcome, the focus is on the page's `body` if the button that
  // opened the dialog is gone (the account was unlinked): it moves to the outcome, so that a
  // keyboard user does not start again from the top of the page. A focus that is somewhere else (the
  // opener, back after a failure, or what the player moved to while it ran) is left alone.
  useEffect(() => {
    if (hasOutcome && confirmationClosed) {
      const focused = document.activeElement;
      if (focused === null || focused === document.body) {
        outcomeRef.current?.focus();
      }
    }
  }, [hasOutcome, confirmationClosed]);

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-surface p-6">
      <h2 id={headingId} className="text-base font-medium">
        {t('settings.account.title')}
      </h2>
      {/* Right under the heading, where it is read first: the summary under it has just changed. */}
      {outcome !== null && (
        <p
          ref={outcomeRef}
          tabIndex={-1}
          role={outcome.failed ? 'alert' : 'status'}
          className={outcome.failed ? 'mt-2 text-sm text-loss' : 'mt-2 text-sm'}
        >
          {outcome.message}
        </p>
      )}
      <AccountSummary account={account} busy={accountChanging} onUnlink={openConfirmation} />
      <Dialog
        open={confirmation !== null}
        title={confirmation === null ? '' : t('account.unlink.title', { name: confirmation.name })}
        onClose={closeConfirmation}
      >
        <UnlinkConfirmation
          running={unlink.isPending}
          onCancel={closeConfirmation}
          onConfirm={confirmUnlink}
        />
      </Dialog>
    </section>
  );
}
