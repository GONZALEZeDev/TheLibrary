/**
 * Update gateway port: how the app learns that a newer version exists and installs it.
 *
 * In the desktop app the Tauri updater does the work: it downloads the update file of the latest
 * GitHub release, compares its version with the installed one, downloads the installer, checks its
 * signature against the public key built into the app, runs it and restarts the app. The browser
 * dev mode has a fake that can offer a synthetic update, so the dialog can be seen without a
 * release. A development build of the desktop app has no gateway at all: it must never offer the
 * public releases as updates of itself.
 *
 * Failures reject with an `AppError`.
 *
 * @packageDocumentation
 */

/** A newer version than the installed one. */
export interface AvailableUpdate {
  /** The version offered, e.g. `0.2.0`. */
  readonly version: string;
  /** The version installed. */
  readonly currentVersion: string;
  /** Publication date of the version (Unix ms), `null` when the update file gives none. */
  readonly date: number | null;
  /** The `notes` field of the update file, as written (see `core/update/release-notes.ts`). */
  readonly rawNotes: string | null;
}

/** Where an installation stands. */
export type InstallProgress =
  | {
      readonly phase: 'downloading';
      /** Bytes received so far. */
      readonly downloadedBytes: number;
      /** Size of the download, `null` when the server does not tell it. */
      readonly totalBytes: number | null;
    }
  | { readonly phase: 'installing' };

/** Checks for a newer version and installs it. */
export interface UpdateGateway {
  /**
   * Ask whether a newer version exists.
   *
   * @returns The newer version, or `null` when the installed one is the latest.
   * @throws AppError when the update file cannot be fetched or read.
   */
  check(): Promise<AvailableUpdate | null>;

  /**
   * Download the version the last {@link UpdateGateway.check} returned, verify its signature,
   * install it and restart the app. In the desktop app the promise usually never settles: the
   * installer closes the app.
   *
   * @param onProgress - Called as the installation moves on.
   * @returns A promise settled if the app is still running once the installation is done.
   * @throws AppError when there is nothing to install, or the download, the signature or the
   *   installation fails.
   */
  install(onProgress: (progress: InstallProgress) => void): Promise<void>;

  /**
   * Open the GitHub page of a release in the system browser.
   *
   * @param version - The version, without `v`.
   * @returns A promise resolved once the browser was asked to open the page.
   * @throws AppError when the page cannot be opened.
   */
  openReleasePage(version: string): Promise<void>;
}
