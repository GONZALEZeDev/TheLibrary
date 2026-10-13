/**
 * Screen shown for an unknown URL. Registered as the router's default not-found component.
 *
 * @packageDocumentation
 */
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';

/**
 * Not-found screen with a way back to the dashboard.
 *
 * @returns The not-found page.
 */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('notFound.title')} description={t('notFound.description')} />
      <Link
        to="/dashboard"
        className="text-sm font-medium text-accent-bright underline-offset-4 hover:underline"
      >
        {t('notFound.back')}
      </Link>
    </>
  );
}
