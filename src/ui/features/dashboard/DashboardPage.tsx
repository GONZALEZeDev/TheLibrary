/**
 * Dashboard screen. Without a linked account it invites the player to link their Steam account.
 * Once an account is linked it shows the synchronisation banner and the numbers of the hero and the
 * period chosen in the address (`/dashboard?period=7d&hero=67`): matches played, wins, win rate and
 * average kills, deaths and assists.
 *
 * @packageDocumentation
 */
import { getRouteApi } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import type { Period } from '../../../core/domain/period';
import { toAppError } from '../../../core/errors/app-error';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { LinkAccountButton } from '../account/LinkAccountButton';
import { useLinkedAccount } from '../account/use-account';
import { SyncBanner } from '../matches/SyncBanner';
import { PeriodNumbers } from './PeriodNumbers';

/** Typed access to the search parameters of the `/dashboard` route (see `ui/app/router.ts`). */
const dashboardRoute = getRouteApi('/dashboard');

/**
 * The part of the screen under the title, depending on what is known about the account.
 *
 * @param account - State of the query of the linked account.
 * @param period - The period of the numbers.
 * @param heroId - The hero of the numbers.
 * @param t - Translation function.
 * @returns The loading message, the error, the invitation to link an account, or the dashboard.
 */
function renderBody(
  account: ReturnType<typeof useLinkedAccount>,
  period: Period,
  heroId: HeroId,
  t: TFunction,
) {
  if (account.isPending) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        {t('dashboard.loading')}
      </p>
    );
  }
  // A failed refresh keeps the account already shown: the error only replaces an empty screen.
  // An account that cannot be read is not one that is missing, so it never gets the invitation:
  // linking another account over it could erase the data of the one the app lost.
  if (account.data === undefined) {
    return (
      <p role="alert" className="text-sm text-loss">
        {t(`errors.kind.${toAppError(account.error).kind}`)}
      </p>
    );
  }
  if (account.data === null) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        title={t('dashboard.invitation.title')}
        description={t('dashboard.invitation.description')}
      >
        <LinkAccountButton />
      </EmptyState>
    );
  }
  return (
    <>
      <SyncBanner />
      <PeriodNumbers period={period} heroId={heroId} />
    </>
  );
}

/**
 * Dashboard screen.
 *
 * @returns The dashboard page.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { period, hero } = dashboardRoute.useSearch();
  const account = useLinkedAccount();
  return (
    <>
      <PageHeader title={t('dashboard.title')} />
      {renderBody(account, period, hero, t)}
    </>
  );
}
