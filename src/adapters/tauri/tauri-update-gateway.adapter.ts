/**
 * {@link UpdateGateway} of the desktop app, on the Tauri updater plugin.
 *
 * The plugin reads the endpoint and the public key from `tauri.conf.json`
 * (`plugins.updater`): it downloads `latest.json` from the latest GitHub release, compares its
 * version with the installed one, and on install downloads the installer, refuses it unless its
 * signature matches the public key built into the app, runs it in passive mode (a progress window,
 * no questions) and, on Windows, lets the installer restart the app. Nothing here can make it
 * accept another file or another key.
 *
 * The plugin's errors are plain strings: they are logged, never shown, and mapped to an `AppError`
 * kind the interface can explain.
 *
 * @packageDocumentation
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { AppError } from '../../core/errors/app-error';
import type {
  AvailableUpdate,
  InstallProgress,
  UpdateGateway,
} from '../../ports/update-gateway.port';

/** Where GitHub shows a release: `<base>/v<version>`. Allowed by the opener scope of the app. */
const RELEASE_PAGE_BASE = 'https://github.com/GONZALEZeDev/TheLibrary/releases/tag';

/** How long the check of `latest.json` may take before it is abandoned. */
const CHECK_TIMEOUT_MS = 15_000;

/** The functions of the plugins this adapter uses; tests pass fakes. */
export interface UpdaterFunctions {
  readonly check: (options: { timeout: number }) => Promise<Update | null>;
  readonly openUrl: (url: string) => Promise<void>;
}

/** {@link UpdateGateway} on the Tauri updater plugin. */
export class TauriUpdateGateway implements UpdateGateway {
  readonly #plugin: UpdaterFunctions;
  /** The update the last check found: the only one {@link TauriUpdateGateway.install} installs. */
  #pending: Update | null = null;

  /**
   * @param plugin - The plugin functions; the real ones by default.
   */
  constructor(plugin: UpdaterFunctions = { check, openUrl }) {
    this.#plugin = plugin;
  }

  /**
   * Ask the plugin whether a newer version exists.
   *
   * @returns The newer version, or `null`.
   * @throws AppError of kind `network` when the update file cannot be fetched or read.
   */
  async check(): Promise<AvailableUpdate | null> {
    let update: Update | null;
    try {
      update = await this.#plugin.check({ timeout: CHECK_TIMEOUT_MS });
    } catch (error) {
      // The plugin does not tell a network failure from a malformed file: both are "could not
      // check", which the player can only retry later.
      throw new AppError('network', 'The update check failed', { cause: error });
    }
    // The plugin keeps each update it found as a resource of the shell until it is closed: the
    // one it replaces is released (a failure to release it costs a little memory, nothing more).
    const previous = this.#pending;
    this.#pending = update;
    if (previous !== null && previous !== update) {
      previous.close().catch(() => undefined);
    }
    if (update === null) return null;
    const date = update.date === undefined ? Number.NaN : Date.parse(update.date);
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: Number.isNaN(date) ? null : date,
      rawNotes: update.body ?? null,
    };
  }

  /**
   * Download, verify and install the update the last check found. On Windows the installer closes
   * the app and starts it again, so the promise usually never settles.
   *
   * @param onProgress - Called as the download moves on, then once the installation starts.
   * @returns A promise settled if the app is still running once the installation is done.
   * @throws AppError of kind `unexpected` when no update was found before, `invalid_payload` when
   *   the download, its signature or the installation fails.
   */
  async install(onProgress: (progress: InstallProgress) => void): Promise<void> {
    const update = this.#pending;
    if (update === null) {
      throw new AppError('unexpected', 'No update to install: check for one first');
    }
    let downloadedBytes = 0;
    let totalBytes: number | null = null;
    const onEvent = (event: DownloadEvent) => {
      if (event.event === 'Started') {
        totalBytes = event.data.contentLength ?? null;
        onProgress({ phase: 'downloading', downloadedBytes, totalBytes });
      } else if (event.event === 'Progress') {
        downloadedBytes += event.data.chunkLength;
        onProgress({ phase: 'downloading', downloadedBytes, totalBytes });
      } else {
        onProgress({ phase: 'installing' });
      }
    };
    try {
      await update.downloadAndInstall(onEvent);
    } catch (error) {
      throw new AppError('invalid_payload', 'The update could not be installed', { cause: error });
    }
  }

  /**
   * Open the GitHub page of a release in the system browser.
   *
   * @param version - The version, without `v`.
   * @returns A promise resolved once the browser was asked to open it.
   * @throws AppError of kind `unexpected` when the page cannot be opened.
   */
  async openReleasePage(version: string): Promise<void> {
    try {
      await this.#plugin.openUrl(`${RELEASE_PAGE_BASE}/v${encodeURIComponent(version)}`);
    } catch (error) {
      throw new AppError('unexpected', 'The release page could not be opened', { cause: error });
    }
  }
}
