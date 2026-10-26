/**
 * What the Steam account section of the settings shows of the account, depending on what is known:
 * a loading message, the reason the account cannot be read (with the Unlink button when only the
 * stored profile is unreadable), the way to link one, or the linked account with its buttons.
 *
 * It is imported by `AccountSection` only, which owns the unlink the buttons ask for.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import type { AccountId } from '../../../core/domain/account';
import { toAppError } from '../../../core/errors/app-error';
import { Button } from '../../components/Button';
import { StatusLine } from '../../components/StatusLine';
import { formatMediumDate, MS_PER_SECOND } from '../../format/date';
import { AccountAvatar } from '../account/AccountAvatar';
import { accountDisplayName } from '../account/display-name';
import { LinkAccountButton } from '../account/LinkAccountButton';
import type { useLinkedAccount } from '../account/use-account';

/** What the confirmation of an unlink is about, kept from the moment it opens. */
export interface Confirmation {
  /** The name to call the account by ("Steam player" when it has no persona name). */
  readonly name: string;
  /**
   * The account the unlink would delete, or `null` when the link cannot be read: the section does
   * not know the account then, and the unlink reads its id by itself.
   */
  readonly accountId: AccountId | null;
}

/** Props of {@link AccountSummary}. */
export interface AccountSummaryProps {
  /** State of the query of the linked account. */
  readonly account: ReturnType<typeof useLinkedAccount>;
  /** Whether the account is being changed: the buttons that start a change are then disabled. */
  readonly busy: boolean;
  /** Called when the player asks to unlink the account. */
  readonly onUnlink: (confirmation: Confirmation) => void;
}

/**
 * What the section shows of the account, depending on what is known: a loading message, the reason
 * the account cannot be read (with the way to unlink it), the way to link one, or the linked account
 * with its buttons.
 *
 * @returns The part of the section under its title.
 */
export function AccountSummary({ account, busy, onUnlink }: AccountSummaryProps) {
  const { t, i18n } = useTranslation();
  if (account.isPending) {
    return <StatusLine kind="loading" text={t('settings.account.loading')} className="mt-4" />;
  }
  // The button that asks to unlink, for the account that is linked and for the one that cannot be
  // read. It is a function and not a component: the two places differ only in what the player is
  // asked about.
  const renderUnlinkButton = (confirmation: Confirmation) => (
    <Button
      look="subtle"
      aria-haspopup="dialog"
      disabled={busy}
      onClick={() => {
        onUnlink(confirmation);
      }}
    >
      {t('account.unlink.button')}
    </Button>
  );
  // A failed refresh keeps the account already shown: the error only replaces an empty section. An
  // account that cannot be read is not one that is missing, so it never gets the way to link
  // another: linking another account over it could erase the data of the one the app lost.
  if (account.data === undefined) {
    const { kind } = toAppError(account.error);
    return (
      <>
        <StatusLine kind="error" error={account.error} className="mt-4" />
        {/* A stored link that cannot be read (a damaged profile) must still be possible to leave: the
            unlink reads only the id of the account, which the service checks by itself. The account
            is not known here, so it is called by the placeholder name. */}
        {kind === 'storage' && (
          <div className="mt-4">
            {renderUnlinkButton({ name: accountDisplayName(null, t), accountId: null })}
          </div>
        )}
      </>
    );
  }
  if (account.data === null) {
    return (
      <>
        <p className="mt-2 text-sm text-fg-muted">{t('settings.account.notLinked')}</p>
        <div className="mt-4">
          {/* Disabled while an unlink is still deleting after the player's dialog was closed by
              the browser: the sign-in would queue behind the deletion. */}
          <LinkAccountButton disabled={busy} />
        </div>
      </>
    );
  }
  const linked = account.data;
  const name = accountDisplayName(linked.personaName, t);
  // `linkedAt` is in milliseconds, the shared formatter wants seconds.
  const linkedOn = formatMediumDate(Math.floor(linked.linkedAt / MS_PER_SECOND), i18n.language);
  return (
    <>
      <div className="mt-4 flex items-center gap-4">
        <AccountAvatar account={linked} size={64} />
        <div className="min-w-0">
          <p className="break-words text-base font-medium">{name}</p>
          <p className="mt-0.5 text-sm text-fg-muted">
            {t('settings.account.linkedOn', { date: linkedOn })}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <LinkAccountButton
          mode="switch"
          currentName={linked.personaName}
          label={t('account.switch.button')}
          variant="subtle"
          disabled={busy}
        />
        {renderUnlinkButton({ name, accountId: linked.accountId })}
      </div>
    </>
  );
}
