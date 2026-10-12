/**
 * Dashboard screen. Milestone M1 only shows its empty state; the KPIs, trends and
 * insights arrive with the data (M2) and analysis (M4–M5) milestones.
 *
 * @packageDocumentation
 */
import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';

/**
 * Dashboard screen.
 *
 * @returns The dashboard page.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('dashboard.title')} />
      <EmptyState
        icon={LayoutDashboard}
        title={t('dashboard.empty.title')}
        description={t('dashboard.empty.description')}
      />
    </>
  );
}
