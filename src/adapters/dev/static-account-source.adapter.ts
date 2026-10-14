/**
 * {@link AccountSource} returning a fixed account, for tests and the development builds.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../../core/domain/account';
import type { AccountSource } from '../../ports/account-source.port';

/** {@link AccountSource} with a fixed account, or none. */
export class StaticAccountSource implements AccountSource {
  readonly #accountId: AccountId | null;
  readonly missingAccountHint: string | null;

  /**
   * @param accountId - The account, or `null` for none.
   * @param missingAccountHint - Shown to the developer when there is no account.
   */
  constructor(accountId: AccountId | null, missingAccountHint: string | null = null) {
    this.#accountId = accountId;
    this.missingAccountHint = accountId === null ? missingAccountHint : null;
  }

  /**
   * The fixed account.
   *
   * @returns The account id, or `null`.
   */
  currentAccountId(): Promise<AccountId | null> {
    return Promise.resolve(this.#accountId);
  }
}
