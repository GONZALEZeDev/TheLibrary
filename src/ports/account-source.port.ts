/**
 * Account port: which Steam account the app synchronises.
 *
 * The user's own account, and only it: the app never looks up other players. Until the Steam
 * sign-in exists, release builds have no account; development builds read one from a local,
 * git-ignored file.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../core/domain/account';

/** Provides the account to synchronise. */
export interface AccountSource {
  /**
   * The account to synchronise.
   *
   * @returns Its account id, or `null` when no account is linked.
   */
  currentAccountId(): Promise<AccountId | null>;

  /**
   * Development builds only: how to provide an account when none is linked, shown to the
   * developer. Always `null` in a release build.
   */
  readonly missingAccountHint: string | null;
}
