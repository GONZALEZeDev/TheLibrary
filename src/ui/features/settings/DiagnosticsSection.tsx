/**
 * The diagnostics section of the settings: the detailed log switch, which lets the debug lines
 * reach the log file, and a button that opens the folder of the log files, to send them along with
 * a report.
 *
 * @packageDocumentation
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { StatusLine } from '../../components/StatusLine';
import { useServices } from '../../app/ServicesContext';
import { SettingsSection } from './SettingsSection';
import { useChangeDebugLogging, useOpenLogFolder, useSettings } from './use-settings';

/**
 * The diagnostics section of the settings.
 *
 * @returns The section.
 */
export function DiagnosticsSection() {
  const { t } = useTranslation();
  const { diagnostics } = useServices();
  const settings = useSettings();
  const changeDebugLogging = useChangeDebugLogging();
  const openLogFolder = useOpenLogFolder();
  const checkboxId = useId();
  const hintId = useId();

  // A switch being saved is shown as picked right away. Then the saved value wins again: on a
  // failure the checkbox goes back to it.
  const debugLogging = changeDebugLogging.isPending
    ? changeDebugLogging.variables
    : settings.data?.debugLogging;

  return (
    <SettingsSection
      title={t('settings.diagnostics.title')}
      description={t('settings.diagnostics.description')}
    >
      {/* Until the settings are read, the checkbox would show a value that may not be the saved one. */}
      {debugLogging !== undefined && (
        <div className="flex items-start gap-3">
          <input
            id={checkboxId}
            type="checkbox"
            checked={debugLogging}
            aria-describedby={hintId}
            // Never disabled: disabling the focused checkbox would drop the keyboard focus.
            onChange={(event) => {
              // One save at a time: a toggle made while a switch is being saved is ignored.
              if (!changeDebugLogging.isPending) {
                changeDebugLogging.mutate(event.target.checked);
              }
            }}
            className="mt-1 size-4 accent-accent"
          />
          <div>
            <label htmlFor={checkboxId} className="text-sm">
              {t('settings.diagnostics.debug')}
            </label>
            <p id={hintId} className="text-sm text-fg-muted">
              {t('settings.diagnostics.debugHint')}
            </p>
          </div>
        </div>
      )}
      {settings.isError && <StatusLine kind="error" error={settings.error} />}
      {changeDebugLogging.isError && (
        <StatusLine kind="error" error={changeDebugLogging.error} className="mt-3" />
      )}
      {/* Where there is no log folder (the browser dev mode), the action is left out. */}
      {diagnostics.canOpenLogFolder && (
        <div className="mt-4">
          <Button
            look="subtle"
            onClick={() => {
              // One opening at a time: a press made while the folder is opening is ignored.
              if (!openLogFolder.isPending) {
                openLogFolder.mutate();
              }
            }}
          >
            {t('settings.diagnostics.openFolder')}
          </Button>
          {/* The fixed text, never the message of the error: it could name a path of the PC. */}
          {openLogFolder.isError && (
            <StatusLine kind="alert" text={t('settings.diagnostics.openFailed')} className="mt-3" />
          )}
        </div>
      )}
    </SettingsSection>
  );
}
