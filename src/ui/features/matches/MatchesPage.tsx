/**
 * Match history screen. Milestone M1 only shows its empty state; the virtualized
 * history table arrives with the data milestone (M2) and the screens milestone (M5).
 *
 * @packageDocumentation
 */
import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';

/**
 * Match history screen.
 *
 * @returns The matches page.
 */
export function MatchesPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('matches.title')} />
      <EmptyState
        icon={History}
        title={t('matches.empty.title')}
        description={t('matches.empty.description')}
      />
    </>
  );
}
