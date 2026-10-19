/**
 * The one rule for the name an account is called by on screen.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';

/**
 * The name to call an account by: its persona name, or "Steam player" when it has none (Steam had
 * no profile for it, or the profile has not been fetched yet).
 *
 * @param personaName - The persona name of the account, or `null` when it has none. A name that is
 *   not usable never gets here: the profile is checked before it is stored.
 * @param t - Translation function.
 * @returns The name.
 */
export function accountDisplayName(personaName: string | null, t: TFunction): string {
  return personaName ?? t('account.placeholderName');
}
