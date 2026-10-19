/**
 * The linked account as a link to the settings, for the sidebar: the round picture and the name.
 *
 * It is imported by `SidebarAccount` only.
 *
 * @packageDocumentation
 */
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { LinkedAccount } from '../../../core/account/linked-account';
import { AccountAvatar } from './AccountAvatar';
import { accountDisplayName } from './display-name';

/** Props of {@link AccountLink}. */
export interface AccountLinkProps {
  /** The linked account. */
  readonly account: LinkedAccount;
}

/**
 * The linked account as a link to the settings.
 *
 * The name is the only visible text, and the accessible name says what it is the name of: a screen
 * reader would otherwise read a bare "Fixture Player" as a link to nowhere in particular.
 *
 * @returns The link.
 */
export function AccountLink({ account }: AccountLinkProps) {
  const { t } = useTranslation();
  const name = accountDisplayName(account.personaName, t);
  return (
    <Link
      to="/settings"
      aria-label={t('nav.account', { name })}
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-surface-raised"
    >
      <AccountAvatar account={account} size={32} />
      {/* A name can be long (Steam allows 64 characters) and the sidebar has a fixed width. A flex
          item does not shrink under the width of its content unless it may (`min-w-0`), and
          `truncate` cuts the name with an ellipsis instead of letting it wrap or overflow. */}
      <span className="min-w-0 truncate">{name}</span>
    </Link>
  );
}
