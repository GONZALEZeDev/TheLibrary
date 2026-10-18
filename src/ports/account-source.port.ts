/**
 * Account port: which Steam account the app synchronises.
 *
 * The user's own account, and only it: the app never looks up other players. It is the account the
 * user linked by signing in through Steam, and that link is a row of the app database.
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
}
