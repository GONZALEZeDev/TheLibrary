/**
 * Updates of the app: the rules around the {@link UpdateGateway}.
 *
 * - **Once per start.** The startup check asks the gateway once per run of the app, however often
 *   the screens ask for its result; the app never checks again on its own during a session.
 * - **Silent at startup.** Offline, or with GitHub unreachable, the startup check gives "no update"
 *   and only writes a `warn` line in the log: the player is never interrupted by an error they did
 *   not ask about. The manual check of the settings does report its failure.
 * - **Never forced.** The service only installs when the player asks for it, one installation at a
 *   time.
 * - **One offer at a time.** The version found by either check is "the offered update", which one
 *   dialog of the interface shows ({@link UpdateService.subscribe}); "Later" withdraws it
 *   ({@link UpdateService.dismiss}). A manual check waits for a startup check still running, so the
 *   two never race.
 * - **No gateway, no update.** A development build of the desktop app has no gateway (it must not
 *   offer the public releases as updates of itself): every check then gives "no update".
 *
 * @packageDocumentation
 */
import { AppError, errorLogContext, toAppError } from '../core/errors/app-error';
import type { Logger } from '../ports/logger.port';
import type { AvailableUpdate, InstallProgress, UpdateGateway } from '../ports/update-gateway.port';

// The interface reads these types through the service, never from the port.
export type { AvailableUpdate, InstallProgress };

/** Scope of the log lines of this service. */
const LOG_SCOPE = 'update';

/** Checks for a newer version of the app and installs it when the player asks. */
export class UpdateService {
  readonly #gateway: UpdateGateway | null;
  readonly #logger: Logger;
  /** The startup check, shared by every caller of {@link UpdateService.checkAtStartup}. */
  #startupCheck: Promise<AvailableUpdate | null> | null = null;
  /** The installation running, if any. */
  #installing: Promise<void> | null = null;
  /** The newer version the interface offers, `null` when there is none or the player put it off. */
  #offered: AvailableUpdate | null = null;
  /** Called whenever {@link UpdateService.getOffered} changes. */
  readonly #listeners = new Set<() => void>();

  /**
   * @param gateway - The update gateway, `null` where updates do not exist.
   * @param logger - The logger of the app.
   */
  constructor(gateway: UpdateGateway | null, logger: Logger) {
    this.#gateway = gateway;
    this.#logger = logger;
  }

  /**
   * The check made when the app starts: asks the gateway the first time, then gives the same
   * result. Never rejects.
   *
   * @returns The newer version, or `null` when there is none or the check failed.
   */
  checkAtStartup(): Promise<AvailableUpdate | null> {
    this.#startupCheck ??= this.#check().then(
      (update) => {
        this.#offer(update);
        return update;
      },
      (error: unknown) => {
        this.#logger.log(
          'warn',
          LOG_SCOPE,
          'Update check at startup failed',
          errorLogContext(toAppError(error)),
        );
        return null;
      },
    );
    return this.#startupCheck;
  }

  /**
   * The check the player asks for in the settings.
   *
   * @returns The newer version, or `null` when the installed one is the latest.
   * @throws AppError when the check fails, so the settings can say so.
   */
  async checkNow(): Promise<AvailableUpdate | null> {
    // A startup check still running finishes first: two checks at once would race over the
    // update the gateway keeps for the installation.
    await this.#startupCheck;
    try {
      const update = await this.#check();
      this.#offer(update);
      return update;
    } catch (error) {
      const appError = toAppError(error);
      this.#logger.log('warn', LOG_SCOPE, 'Update check failed', errorLogContext(appError));
      throw appError;
    }
  }

  /**
   * The newer version to offer the player, for the update dialog.
   *
   * @returns The offered update, or `null`.
   */
  readonly getOffered = (): AvailableUpdate | null => this.#offered;

  /**
   * Be told when the offered update changes (the shape `useSyncExternalStore` expects).
   *
   * @param listener - Called after each change.
   * @returns A function that stops the calls.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Withdraw the offered update: the player chose "Later". A later check offers it again.
   */
  dismiss(): void {
    this.#setOffered(null);
  }

  /**
   * Install the version the last check found. A call made while an installation runs gets the
   * running one instead of starting another.
   *
   * @param onProgress - Called as the installation moves on.
   * @returns A promise settled once the installation is done; in the desktop app the installer
   *   usually closes the app first.
   * @throws AppError when the installation fails.
   */
  install(onProgress: (progress: InstallProgress) => void): Promise<void> {
    this.#installing ??= this.#install(onProgress).finally(() => {
      this.#installing = null;
    });
    return this.#installing;
  }

  /**
   * Open the GitHub page of a release. A failure is logged and otherwise ignored: the page is a
   * convenience, the dialog already shows the summary.
   *
   * @param version - The version, without `v`.
   * @returns A promise resolved once done, never rejected.
   */
  async openReleasePage(version: string): Promise<void> {
    try {
      await this.#gateway?.openReleasePage(version);
    } catch (error) {
      this.#logger.log(
        'warn',
        LOG_SCOPE,
        'Could not open the release page',
        errorLogContext(toAppError(error)),
      );
    }
  }

  /**
   * Offer the update a check found; a check that found none leaves the current offer alone.
   *
   * @param update - The update found, or `null`.
   */
  #offer(update: AvailableUpdate | null): void {
    if (update !== null) this.#setOffered(update);
  }

  /**
   * Change the offered update and tell the listeners.
   *
   * @param update - The new offer, or `null`.
   */
  #setOffered(update: AvailableUpdate | null): void {
    this.#offered = update;
    for (const listener of this.#listeners) listener();
  }

  /**
   * Ask the gateway and log the answer.
   *
   * @returns The newer version, or `null`.
   */
  async #check(): Promise<AvailableUpdate | null> {
    if (this.#gateway === null) {
      this.#logger.log('debug', LOG_SCOPE, 'Updates are not available in this build');
      return null;
    }
    const update = await this.#gateway.check();
    if (update === null) {
      this.#logger.log('info', LOG_SCOPE, 'No update available');
    } else {
      this.#logger.log('info', LOG_SCOPE, 'Update available', {
        version: update.version,
        currentVersion: update.currentVersion,
      });
    }
    return update;
  }

  /**
   * Run one installation and log it.
   *
   * @param onProgress - Called as the installation moves on.
   * @returns A promise settled once the installation is done.
   */
  async #install(onProgress: (progress: InstallProgress) => void): Promise<void> {
    if (this.#gateway === null) {
      throw new AppError('unexpected', 'Updates are not available in this build');
    }
    this.#logger.log('info', LOG_SCOPE, 'Installing the update');
    try {
      await this.#gateway.install(onProgress);
    } catch (error) {
      const appError = toAppError(error);
      this.#logger.log('error', LOG_SCOPE, 'Update installation failed', errorLogContext(appError));
      throw appError;
    }
  }
}
