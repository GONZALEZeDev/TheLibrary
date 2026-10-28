/**
 * The about section of the settings: the version of the app with the check for a newer one, its
 * licence and the licences of the software it includes, where the match data comes from, the notice
 * that Valve is not involved, and what the app does with the data of the player.
 *
 * "Check for updates" asks the update service at once, whatever the startup check found: a newer
 * version becomes the offered update, which the one update dialog of the app shows (the player
 * still chooses whether to install it); otherwise a line says the version is the latest or that
 * the check failed. Everything else is plain text: the
 * section links nowhere.
 *
 * @packageDocumentation
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { APP_VERSION } from '../../app/app-info';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { StatusLine } from '../../components/StatusLine';
import { SettingsSection } from './SettingsSection';

/** Where the check asked from this section stands. */
type CheckState = 'idle' | 'checking' | 'upToDate' | 'failed';

/**
 * The about section of the settings.
 *
 * @returns The section.
 */
export function AboutSection() {
  const { t } = useTranslation();
  const { updates } = useServices();
  const [check, setCheck] = useState<CheckState>('idle');

  const checkForUpdates = () => {
    // One check at a time: a press while it runs is ignored (the button is never disabled, which
    // would drop the keyboard focus).
    if (check === 'checking') return;
    setCheck('checking');
    // The service logs a failure; the section only says that the check failed.
    updates.checkNow().then(
      // A newer version opens the update dialog of the app, through the service.
      (found) => {
        setCheck(found === null ? 'upToDate' : 'idle');
      },
      () => {
        setCheck('failed');
      },
    );
  };

  return (
    <SettingsSection title={t('settings.about.title')}>
      <p className="text-sm">{t('settings.about.version', { version: APP_VERSION })}</p>
      <Button look="subtle" className="mt-3" onClick={checkForUpdates}>
        {t('settings.about.checkUpdates')}
      </Button>
      {check === 'checking' && (
        <StatusLine kind="loading" text={t('settings.about.checking')} className="mt-2" />
      )}
      {check === 'upToDate' && (
        <p role="status" className="mt-2 text-sm">
          {t('settings.about.upToDate')}
        </p>
      )}
      {check === 'failed' && (
        <StatusLine kind="alert" text={t('settings.about.checkFailed')} className="mt-2" />
      )}
      <p className="mt-4 text-sm">{t('settings.about.licence')}</p>
      <p className="mt-1 text-sm text-fg-muted">{t('settings.about.notices')}</p>
      <p className="mt-1 text-sm">{t('settings.about.credit')}</p>
      <p className="mt-1 text-sm text-fg-muted">{t('settings.about.valve')}</p>
      <p className="mt-1 text-sm text-fg-muted">{t('settings.about.privacy')}</p>
    </SettingsSection>
  );
}
