/**
 * The about section of the settings: the version of the app, its licence, where the match data
 * comes from, the notice that Valve is not involved, and what the app does with the data of the
 * player. All plain text: the section links nowhere.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { APP_VERSION } from '../../app/app-info';
import { SettingsSection } from './SettingsSection';

/**
 * The about section of the settings.
 *
 * @returns The section.
 */
export function AboutSection() {
  const { t } = useTranslation();

  return (
    <SettingsSection title={t('settings.about.title')}>
      <p className="text-sm">{t('settings.about.version', { version: APP_VERSION })}</p>
      <p className="mt-1 text-sm">{t('settings.about.licence')}</p>
      <p className="mt-1 text-sm">{t('settings.about.credit')}</p>
      <p className="mt-1 text-sm text-fg-muted">{t('settings.about.valve')}</p>
      <p className="mt-1 text-sm text-fg-muted">{t('settings.about.privacy')}</p>
    </SettingsSection>
  );
}
