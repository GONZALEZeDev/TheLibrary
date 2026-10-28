/**
 * The dialog that offers a newer version of the app: the version offered and the one installed,
 * its publication date, its summary in the language of the app, a link to its GitHub page, and the
 * choice of the player — install now, or later.
 *
 * Installing replaces the buttons with the progress of the download. Escape and "Later" are ignored
 * while the installation runs: the installer closes the app itself once it starts. A failure is
 * told with a fixed text (the details are in the log) and gives the choice back to the player.
 * "Later" remembers nothing: the dialog comes back at the next start while the version is not
 * installed. The update is never installed without the player asking for it.
 *
 * @packageDocumentation
 */
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FALLBACK_LANGUAGE, isLanguage } from '../../../core/settings/language';
import { parseReleaseNotes, selectNotesMarkdown } from '../../../core/update/release-notes';
import type { AvailableUpdate, InstallProgress } from '../../../services/update.service';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { DIALOG_ACTIONS_CLASS } from '../../components/button-styles';
import { Dialog } from '../../components/Dialog';
import { StatusLine } from '../../components/StatusLine';
import { formatMediumDate, MS_PER_SECOND } from '../../format/date';

/** Props of {@link UpdateDialog}. */
export interface UpdateDialogProps {
  /** The version offered; the dialog is open while it is not `null`. */
  readonly update: AvailableUpdate | null;
  /** Called when the player chooses "Later" or presses Escape (ignored while installing). */
  readonly onClose: () => void;
}

/** Where the installation started from the dialog stands. */
type InstallState =
  | { readonly step: 'idle' }
  | { readonly step: 'running'; readonly progress: InstallProgress | null }
  | { readonly step: 'failed' };

/**
 * The update dialog.
 *
 * @returns The dialog, hidden while there is no update to offer.
 */
export function UpdateDialog({ update, onClose }: UpdateDialogProps) {
  const { t } = useTranslation();
  const { updates } = useServices();
  const [install, setInstall] = useState<InstallState>({ step: 'idle' });
  const running = install.step === 'running';
  // A second Escape in a row closes a `<dialog>` whatever the page says (see `Dialog`). Asked while
  // installing, the close is refused, but the browser may have closed the element anyway: the
  // dialog is then mounted again (a new key) if the installation fails, so the failure is seen.
  const closeAskedWhileRunning = useRef(false);
  const [dialogKey, setDialogKey] = useState(0);

  const close = () => {
    // The installer is about to close the app: the dialog stays open to show the progress.
    if (running) {
      closeAskedWhileRunning.current = true;
      return;
    }
    setInstall({ step: 'idle' });
    onClose();
  };

  const startInstall = () => {
    // One installation at a time: a press while it runs is ignored (the button is never disabled,
    // which would drop the keyboard focus).
    if (running) return;
    closeAskedWhileRunning.current = false;
    setInstall({ step: 'running', progress: null });
    updates
      .install((progress) => {
        setInstall({ step: 'running', progress });
      })
      .then(
        // The app is still running once the installation is done only where nothing restarts it
        // (the browser dev mode): the dialog then simply closes.
        () => {
          setInstall({ step: 'idle' });
          onClose();
        },
        // The service logged the details; the dialog says it failed and gives the choice back.
        () => {
          setInstall({ step: 'failed' });
          if (closeAskedWhileRunning.current) {
            setDialogKey((key) => key + 1);
          }
        },
      );
  };

  return (
    <Dialog key={dialogKey} open={update !== null} title={t('update.title')} onClose={close}>
      {update !== null && (
        <>
          <UpdateSummary update={update} />
          <Button
            look="subtle"
            className="mt-4"
            onClick={() => void updates.openReleasePage(update.version)}
          >
            {t('update.viewOnGitHub')}
          </Button>
          {install.step === 'failed' && (
            <StatusLine kind="alert" text={t('update.failed')} className="mt-4" />
          )}
          {install.step === 'running' ? (
            <InstallProgressView progress={install.progress} />
          ) : (
            <div className={DIALOG_ACTIONS_CLASS}>
              <Button look="subtle" onClick={close}>
                {t('update.later')}
              </Button>
              <Button look="primary" onClick={startInstall}>
                {t('update.install')}
              </Button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

/**
 * The versions, the date and the summary of an update.
 *
 * @param props - The update.
 * @param props.update - The update offered.
 * @returns The summary.
 */
function UpdateSummary({ update }: { readonly update: AvailableUpdate }) {
  const { t, i18n } = useTranslation();
  const language = isLanguage(i18n.language) ? i18n.language : FALLBACK_LANGUAGE;
  const markdown = selectNotesMarkdown(update.rawNotes, language);
  const notes = markdown === null ? null : parseReleaseNotes(markdown);
  return (
    <>
      <p className="text-sm">
        {t('update.versions', { version: update.version, current: update.currentVersion })}
      </p>
      {update.date !== null && (
        <p className="mt-1 text-sm text-fg-muted">
          {t('update.published', {
            date: formatMediumDate(Math.floor(update.date / MS_PER_SECOND), i18n.language),
          })}
        </p>
      )}
      {notes === null ? (
        <p className="mt-4 text-sm text-fg-muted">{t('update.notesMissing')}</p>
      ) : (
        <div className="mt-4 max-h-72 overflow-y-auto text-sm">
          {notes.paragraphs.map((paragraph, index) => (
            <p key={`p${String(index)}`} className="mb-2">
              {paragraph}
            </p>
          ))}
          {notes.sections.map((section, index) => (
            <section key={`s${String(index)}`} className="mb-3">
              {section.heading !== '' && <h3 className="font-semibold">{section.heading}</h3>}
              <ul className="mt-1 list-disc pl-5">
                {section.items.map((item, itemIndex) => (
                  <li key={String(itemIndex)}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The progress of a running installation: a bar and its text.
 *
 * @param props - The progress.
 * @param props.progress - The last progress reported, `null` before the first one.
 * @returns The progress.
 */
function InstallProgressView({ progress }: { readonly progress: InstallProgress | null }) {
  const { t } = useTranslation();
  const labelId = useId();
  const total = progress?.phase === 'downloading' ? progress.totalBytes : null;
  const percent =
    progress?.phase === 'downloading' && total !== null && total > 0
      ? Math.min(100, Math.floor((progress.downloadedBytes / total) * 100))
      : null;
  const text =
    progress?.phase === 'installing'
      ? t('update.installing')
      : percent === null
        ? t('update.downloadingUnknown')
        : t('update.downloading', { percent });
  return (
    <div className="mt-6">
      {/* Without a known size, a bar without a value: the browser draws it as indeterminate. */}
      <progress
        aria-labelledby={labelId}
        className="w-full accent-accent"
        max={100}
        {...(percent === null ? {} : { value: percent })}
      />
      <p id={labelId} role="status" className="mt-2 text-sm">
        {text}
      </p>
    </div>
  );
}
