/**
 * The account block at the bottom of the sidebar: the linked account (round picture and name) as a
 * link to the settings, where it is managed, or the button that links an account when none is.
 *
 * It is on every page, so it stays quiet until it knows what to say: nothing is drawn while the
 * account is being read, and nothing when it cannot be read.
 *
 * @packageDocumentation
 */
import { useIsMutating } from '@tanstack/react-query';
import { AccountLink } from './AccountLink';
import { LinkAccountButton } from './LinkAccountButton';
import { ACCOUNT_QUERY_KEY, useLinkedAccount } from './use-account';

/**
 * The account block of the sidebar.
 *
 * @returns The block, or nothing while the account is loading or cannot be read.
 */
export function SidebarAccount() {
  const account = useLinkedAccount();
  // A link or an unlink is in progress, started from anywhere. A sign-in started now would queue
  // behind an unlink that is still deleting (or behind a link that the player gave up on with Escape
  // but that Steam had already confirmed), so the button waits, as the one of the settings does.
  const accountChanging = useIsMutating({ mutationKey: ACCOUNT_QUERY_KEY }) > 0;

  // A failed refresh keeps the account already shown: the error only replaces an empty block. An
  // account that cannot be read is not one that is missing, so it never gets the way to link
  // another: linking another account over it could erase the data of the one the app lost. The
  // settings are where the reason is told.
  if (account.data === undefined) {
    return null;
  }
  return (
    <div className="mt-4 border-t border-border pt-4">
      {account.data === null ? (
        <LinkAccountButton variant="subtle" disabled={accountChanging} />
      ) : (
        <AccountLink account={account.data} />
      )}
    </div>
  );
}
