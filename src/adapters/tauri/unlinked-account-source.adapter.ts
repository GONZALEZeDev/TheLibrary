/**
 * {@link AccountSource} of the desktop app until the Steam sign-in exists: no account is linked, so
 * nothing is synchronised.
 *
 * The Steam sign-in (milestone M3) replaces it with the account the user signed in with. Nothing
 * here can be configured: the app never synchronises an account it did not verify.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../../core/domain/account';
import type { AccountSource } from '../../ports/account-source.port';

/** {@link AccountSource} with no account. */
export class UnlinkedAccountSource implements AccountSource {
  /**
   * No account is linked.
   *
   * @returns `null`.
   */
  currentAccountId(): Promise<AccountId | null> {
    return Promise.resolve(null);
  }
}
