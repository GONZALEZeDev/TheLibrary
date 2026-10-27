/**
 * Dashboard screen. Without a linked account it invites the player to link their Steam account.
 * Once an account is linked it shows, from top to bottom:
 * - the synchronisation banner;
 * - the results of the latest Paige matches as a row of badges, then two figures over those
 *   matches: the wins, and the average kills, deaths and assists;
 * - the first weaknesses and strengths of the review;
 * - the links to the full review and to all the matches.
 *
 * The results and the figures come from the stored matches and the points from the review. Both are
 * read from the local database, and neither waits for the other: the points say that they are being
 * computed while the results are already there.
 *
 * @packageDocumentation
 */
import { Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import type { PeriodStats } from '../../../core/domain/period-stats';
import { BUTTON_CLASSES } from '../../components/button-styles';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { StatTile } from '../../components/StatTile';
import { StatusLine } from '../../components/StatusLine';
import { LinkAccountButton } from '../account/LinkAccountButton';
import { useLinkedAccount } from '../account/use-account';
import { formatOneDecimal } from '../match-detail/analysis-format';
import { SyncBanner } from '../matches/SyncBanner';
import { useLatestMatches } from '../matches/use-matches';
import { DashboardPoints } from './DashboardPoints';
import { LatestResults } from './LatestResults';

/** How many of the latest matches the dashboard sums up: the results shown and the figures over them. */
const DASHBOARD_MATCHES = 10;

/** Props of {@link LatestFigures}. */
interface LatestFiguresProps {
  /** The figures of the latest matches. */
  readonly stats: PeriodStats;
}

/**
 * The two figures over the latest matches, in tiles.
 *
 * @returns The wins out of the matches, and the average kills, deaths and assists with one decimal
 *   each, written as the language of the interface writes a number.
 */
function LatestFigures({ stats }: LatestFiguresProps) {
  const { t, i18n } = useTranslation();
  const averages = [stats.averageKills, stats.averageDeaths, stats.averageAssists]
    .map((average) => formatOneDecimal(average, i18n.language))
    .join(' / ');

  return (
    <dl className="grid grid-cols-2 gap-4">
      <StatTile
        label={t('dashboard.stats.record')}
        value={`${String(stats.wins)} / ${String(stats.matches)}`}
      />
      <StatTile label={t('dashboard.stats.kda')} value={averages} />
    </dl>
  );
}

/**
 * The dashboard of a linked account.
 *
 * @returns The banner, the results and figures of the latest matches, the points of the review and
 *   the links to the review and to the history.
 */
function LinkedDashboard() {
  const { t } = useTranslation();
  const latest = useLatestMatches(PAIGE_HERO_ID, DASHBOARD_MATCHES);
  const answer = latest.data;

  return (
    <div className="space-y-6">
      <SyncBanner />
      {answer?.kind === 'ready' && (
        <>
          <LatestResults matches={answer.matches} />
          {answer.stats !== null && <LatestFigures stats={answer.stats} />}
        </>
      )}
      {/* A failed read again keeps the results already shown: the error only replaces an empty block. */}
      {latest.isError && answer === undefined && <StatusLine kind="error" error={latest.error} />}
      <DashboardPoints />
      <div className="flex gap-3">
        <Link to="/review" className={BUTTON_CLASSES.subtle}>
          {t('dashboard.links.review')}
        </Link>
        <Link to="/matches" className={BUTTON_CLASSES.subtle}>
          {t('dashboard.links.matches')}
        </Link>
      </div>
    </div>
  );
}

/**
 * The part of the screen under the title, depending on what is known about the account.
 *
 * @param account - State of the query of the linked account.
 * @param t - Translation function.
 * @returns The loading message, the error, the invitation to link an account, or the dashboard.
 */
function renderBody(account: ReturnType<typeof useLinkedAccount>, t: TFunction) {
  if (account.isPending) {
    return <StatusLine kind="loading" text={t('dashboard.loading')} />;
  }
  // A failed refresh keeps the account already shown: the error only replaces an empty screen.
  // An account that cannot be read is not one that is missing, so it never gets the invitation:
  // linking another account over it could erase the data of the one the app lost.
  if (account.data === undefined) {
    return <StatusLine kind="error" error={account.error} />;
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
  return <LinkedDashboard />;
}

/**
 * Dashboard screen.
 *
 * @returns The dashboard page.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const account = useLinkedAccount();
  return (
    <>
      <PageHeader title={t('dashboard.title')} />
      {renderBody(account, t)}
    </>
  );
}
