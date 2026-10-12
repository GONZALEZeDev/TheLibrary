/**
 * Settings screen. Milestone M1 only has the language section; the account, sync,
 * storage, diagnostics and about sections arrive with their features.
 *
 * @packageDocumentation
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppError } from '../../../core/errors/app-error';
import { FALLBACK_LANGUAGE, isLanguage } from '../../../core/settings/language';
import { PageHeader } from '../../components/PageHeader';
import { LanguageSwitcher } from './LanguageSwitcher';
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
  const languageHeadingId = useId();

  // A choice being saved is shown as selected right away (the radios would otherwise jump back
  // until the save completes). Then the saved choice wins; before any choice, the selected
  // option is the language displayed, i.e. the one resolved from the system at startup.
  const displayedLanguage = isLanguage(i18n.language) ? i18n.language : FALLBACK_LANGUAGE;
  const pendingLanguage = changeLanguage.isPending ? changeLanguage.variables : undefined;
  const selectedLanguage = pendingLanguage ?? settings.data?.language ?? displayedLanguage;

  return (
    <>
      <PageHeader title={t('settings.title')} />
      <section
        aria-labelledby={languageHeadingId}
        className="rounded-xl border border-border bg-surface p-6"
      >
        <h2 id={languageHeadingId} className="text-base font-medium">
          {t('settings.language.title')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t('settings.language.description')}</p>
        <div className="mt-4 flex items-center gap-3">
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
          <p role="alert" className="mt-3 text-sm text-loss">
            {t(`errors.kind.${toAppError(changeLanguage.error).kind}`)}
          </p>
        )}
      </section>
    </>
  );
}
