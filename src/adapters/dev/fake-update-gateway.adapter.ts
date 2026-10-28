/**
 * {@link UpdateGateway} of the browser dev mode: a synthetic update, to see and try the update
 * dialog without publishing a release.
 *
 * It offers nothing unless the developer asks for it, so the dialog does not open at every reload:
 * run `localStorage.setItem('thelibrary.dev.fakeUpdate', '1')` in the console of the page, then
 * reload. The install pretends to download for about two seconds and ends without restarting
 * anything.
 *
 * @packageDocumentation
 */
import type { Logger } from '../../ports/logger.port';
import type {
  AvailableUpdate,
  InstallProgress,
  UpdateGateway,
} from '../../ports/update-gateway.port';

/** Key of `localStorage` that turns the synthetic update on (value `'1'`). */
export const FAKE_UPDATE_FLAG = 'thelibrary.dev.fakeUpdate';

/** Version the synthetic update offers: always newer than the app. */
const FAKE_VERSION = '9.9.9';

/** Size the synthetic download pretends to have. */
const FAKE_SIZE_BYTES = 8 * 1024 * 1024;

/** Number of progress steps of the synthetic download. */
const FAKE_STEPS = 8;

/** Summaries of the synthetic update, in the format the release workflow writes. */
const FAKE_NOTES = JSON.stringify({
  en: 'A synthetic update of the browser dev mode.\n\n### Added\n\n- A new feature.\n- Another one, with a [link](https://example.test).\n\n### Fixed\n\n- A bug.',
  fr: 'Une mise à jour factice du mode dev du navigateur.\n\n### Ajouts\n\n- Une nouvelle fonction.\n- Une autre, avec un [lien](https://example.test).\n\n### Corrections\n\n- Un bug.',
});

/** Options of {@link FakeUpdateGateway}. */
export interface FakeUpdateGatewayOptions {
  /** Whether the synthetic update is offered; read at every check. */
  readonly enabled: () => boolean;
  /** Version of the app, shown as the installed one. */
  readonly currentVersion: string;
  readonly logger: Logger;
  /** Waits between two progress steps; a timer by default, instant in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Synthetic {@link UpdateGateway} of the browser dev mode. */
export class FakeUpdateGateway implements UpdateGateway {
  readonly #options: FakeUpdateGatewayOptions;
  readonly #sleep: (ms: number) => Promise<void>;

  /**
   * @param options - See {@link FakeUpdateGatewayOptions}.
   */
  constructor(options: FakeUpdateGatewayOptions) {
    this.#options = options;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
  }

  /**
   * Offer the synthetic update when the flag is on.
   *
   * @returns The synthetic update, or `null` when the flag is off.
   */
  check(): Promise<AvailableUpdate | null> {
    if (!this.#options.enabled()) return Promise.resolve(null);
    return Promise.resolve({
      version: FAKE_VERSION,
      currentVersion: this.#options.currentVersion,
      date: Date.UTC(2026, 9, 28),
      rawNotes: FAKE_NOTES,
    });
  }

  /**
   * Pretend to download and install the synthetic update.
   *
   * @param onProgress - Called at each step.
   * @returns A promise resolved once the pretend installation is done.
   */
  async install(onProgress: (progress: InstallProgress) => void): Promise<void> {
    for (let step = 1; step <= FAKE_STEPS; step += 1) {
      await this.#sleep(250);
      onProgress({
        phase: 'downloading',
        downloadedBytes: (FAKE_SIZE_BYTES * step) / FAKE_STEPS,
        totalBytes: FAKE_SIZE_BYTES,
      });
    }
    onProgress({ phase: 'installing' });
    await this.#sleep(250);
    this.#options.logger.log('info', 'dev', 'Synthetic update installed; a real one would restart');
  }

  /**
   * Log the page a real gateway would open: the browser dev mode opens no other window.
   *
   * @param version - The version.
   * @returns A resolved promise.
   */
  openReleasePage(version: string): Promise<void> {
    this.#options.logger.log('info', 'dev', 'Would open the release page', { version });
    return Promise.resolve();
  }
}
