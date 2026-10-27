/**
 * Settings screen: one titled panel per group of settings, in this order: the linked Steam account
 * (see {@link AccountSection}), the synchronisation, the storage limit of the archives (see
 * {@link StorageSection}), the language of the interface, the diagnostics (see
 * {@link DiagnosticsSection}) and the about section (see {@link AboutSection}).
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { FALLBACK_LANGUAGE, isLanguage } from '../../../core/settings/language';
import { PageHeader } from '../../components/PageHeader';
import { StatusLine } from '../../components/StatusLine';
import { SyncBanner } from '../matches/SyncBanner';
import { AboutSection } from './AboutSection';
import { AccountSection } from './AccountSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { LanguageSwitcher } from './LanguageSwitcher';
import { SettingsSection } from './SettingsSection';
import { StorageSection } from './StorageSection';
import { useChangeLanguage, useSettings } from './use-settings';

/**
 * Settings screen.
 *
 * @returns The settings page.
 */
export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const settings = useSettings();
  const changeLanguage = useChangeLanguage();

  // A choice being saved is shown as selected right away (the radios would otherwise jump back
  // until the save completes). Then the saved choice wins; before any choice, the selected
  // option is the language displayed, i.e. the one resolved from the system at startup.
  const displayedLanguage = isLanguage(i18n.language) ? i18n.language : FALLBACK_LANGUAGE;
  const pendingLanguage = changeLanguage.isPending ? changeLanguage.variables : undefined;
  const selectedLanguage = pendingLanguage ?? settings.data?.language ?? displayedLanguage;

  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="space-y-6">
        <AccountSection />
        <SettingsSection
          title={t('settings.sync.title')}
          description={t('settings.sync.description')}
        >
          <SyncBanner embedded />
        </SettingsSection>
        <StorageSection />
        <SettingsSection
          title={t('settings.language.title')}
          description={t('settings.language.description')}
        >
          <div className="flex items-center gap-3">
            <LanguageSwitcher
              value={selectedLanguage}
              onChange={(language) => {
                // One save at a time: a pick made while a choice is being saved is ignored.
                if (!changeLanguage.isPending) {
                  changeLanguage.mutate(language);
                }
              }}
            />
            {changeLanguage.isPending && (
              <span className="text-sm text-fg-muted">{t('settings.language.saving')}</span>
            )}
          </div>
          {changeLanguage.isError && (
            <StatusLine kind="error" error={changeLanguage.error} className="mt-3" />
          )}
        </SettingsSection>
        <DiagnosticsSection />
        <AboutSection />
      </div>
    </>
  );
}
