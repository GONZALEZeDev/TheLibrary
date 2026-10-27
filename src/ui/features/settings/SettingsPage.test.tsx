/**
 * Tests of the settings screen, rendered with the real providers and the development adapters.
 *
 * @packageDocumentation
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageSettingsStore } from '../../../adapters/dev/local-storage-settings-store.adapter';
import { AppError } from '../../../core/errors/app-error';
import type { AppServices } from '../../../services/app-services';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { APP_VERSION } from '../../app/app-info';
import { createI18n } from '../../i18n/i18n';
import { SettingsPage } from './SettingsPage';

/** The diagnostics of the services: the detailed log switch and the log folder. */
type Diagnostics = AppServices['diagnostics'];

/**
 * Build diagnostics that record what the page asks of them, with a log folder that can be opened.
 *
 * @param openLogFolder - What opening the folder does; it works at once by default.
 * @returns The diagnostics and the spies on their two actions.
 */
function createDiagnostics(openLogFolder: () => Promise<void> = () => Promise.resolve()) {
  const setDebugLogging = vi.fn<(enabled: boolean) => void>();
  const open = vi.fn(openLogFolder);
  const diagnostics: Diagnostics = {
    canOpenLogFolder: true,
    setDebugLogging,
    openLogFolder: open,
  };
  return { diagnostics, setDebugLogging, open };
}

/**
 * Build a settings store whose writes wait until the test lets them end, and that counts them.
 *
 * @returns The store, the number of writes started so far, and the function that lets the writes end.
 */
function createHeldStore() {
  const store = new LocalStorageSettingsStore(localStorage);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  return {
    store: {
      read: () => store.read(),
      write: async (document: unknown) => {
        writes += 1;
        await gate;
        await store.write(document);
      },
    },
    writes: () => writes,
    release,
  };
}

/**
 * Render the settings screen on a first launch.
 *
 * @param options - `language` of the interface (English by default), `diagnostics` to give the
 *   page instead of the ones of the development mode, which have no log folder, and
 *   `settingsStore` to save the settings in instead of Web Storage.
 * @returns The services, to inspect what was saved.
 */
async function renderSettingsPage(
  options: {
    language?: 'en' | 'fr';
    diagnostics?: Diagnostics;
    settingsStore?: TestServicesOptions['settingsStore'];
  } = {},
) {
  const { language = 'en', diagnostics, settingsStore } = options;
  const test = createTestServices(settingsStore === undefined ? {} : { settingsStore });
  const services = diagnostics === undefined ? test.services : { ...test.services, diagnostics };
  const i18n = await createI18n(language);
  render(
    <AppProviders services={services} queryClient={createTestQueryClient()} i18n={i18n}>
      <SettingsPage />
    </AppProviders>,
  );
  return { services };
}

describe('SettingsPage', () => {
  afterEach(() => {
    // Gives Web Storage back its real `setItem` after the test that breaks it.
    vi.restoreAllMocks();
  });

  it('shows the sync status and its button in the settings', async () => {
    await renderSettingsPage();

    const section = await screen.findByRole('region', { name: 'Synchronisation' });
    expect(
      within(section).getByText('Your matches sync at start-up, then every 13 minutes.'),
    ).toBeInTheDocument();
    // The status of the banner and its button, under the title of the section.
    expect(await within(section).findByText('Not synchronised yet.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('lists the sections in order, each one a titled panel', async () => {
    await renderSettingsPage();

    await screen.findByRole('region', { name: 'Storage' });
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Steam account', 'Synchronisation', 'Storage', 'Language', 'Diagnostics', 'About']);
  });

  it('selects the displayed language while the user has not picked one', async () => {
    await renderSettingsPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'English' })).toBeChecked();
  });

  it('saves the picked language and switches the interface to it', async () => {
    const user = userEvent.setup();
    const { services } = await renderSettingsPage();

    await user.click(screen.getByRole('radio', { name: 'Français' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Français' })).toBeChecked();
    await expect(services.settings.get()).resolves.toEqual({
      schemaVersion: 1,
      language: 'fr',
      storageCapMb: 500,
      debugLogging: false,
    });
  });

  it('shows the storage message and keeps the current language when the save fails', async () => {
    const user = userEvent.setup();
    await renderSettingsPage();
    await screen.findByRole('radio', { name: 'English' });
    // The development store writes to Web Storage: make it fail like a full disk would.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    await user.click(screen.getByRole('radio', { name: 'Français' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  describe('diagnostics', () => {
    it('turns the detailed log on and off and saves it', async () => {
      const user = userEvent.setup();
      const { diagnostics, setDebugLogging } = createDiagnostics();
      const { services } = await renderSettingsPage({ diagnostics });
      const section = await screen.findByRole('region', { name: 'Diagnostics' });
      expect(
        within(section).getByText(
          'The log helps understand a problem. It never holds your account id.',
        ),
      ).toBeInTheDocument();
      const checkbox = await within(section).findByRole('checkbox', { name: 'Detailed log' });
      expect(checkbox).not.toBeChecked();
      // The hint is the description of the checkbox.
      expect(checkbox).toHaveAccessibleDescription(
        'Adds the debug lines to the log. Turn it on only to look into a problem.',
      );

      await user.click(checkbox);

      await waitFor(() => {
        expect(setDebugLogging).toHaveBeenCalledExactlyOnceWith(true);
      });
      expect(checkbox).toBeChecked();
      await expect(services.settings.get()).resolves.toMatchObject({ debugLogging: true });

      await user.click(checkbox);

      await waitFor(() => {
        expect(setDebugLogging).toHaveBeenLastCalledWith(false);
      });
      expect(checkbox).not.toBeChecked();
      await expect(services.settings.get()).resolves.toMatchObject({ debugLogging: false });
    });

    it('ignores a toggle made while the switch is being saved', async () => {
      const user = userEvent.setup();
      const { diagnostics, setDebugLogging } = createDiagnostics();
      const held = createHeldStore();
      const { services } = await renderSettingsPage({ diagnostics, settingsStore: held.store });
      const checkbox = await screen.findByRole('checkbox', { name: 'Detailed log' });

      // The first toggle starts a save that is held; the second one comes while it is pending.
      await user.click(checkbox);
      await waitFor(() => {
        expect(held.writes()).toBe(1);
      });
      await user.click(checkbox);
      expect(checkbox).toHaveFocus();
      // The switch is not applied before its save has ended.
      expect(setDebugLogging).not.toHaveBeenCalled();
      held.release();

      await waitFor(() => {
        expect(setDebugLogging).toHaveBeenCalledExactlyOnceWith(true);
      });
      expect(held.writes()).toBe(1);
      expect(checkbox).toHaveFocus();
      expect(checkbox).toBeChecked();
      await expect(services.settings.get()).resolves.toMatchObject({ debugLogging: true });
    });

    it('shows the saved value and does not apply the switch when the save fails', async () => {
      const user = userEvent.setup();
      const { diagnostics, setDebugLogging } = createDiagnostics();
      await renderSettingsPage({ diagnostics });
      const checkbox = await screen.findByRole('checkbox', { name: 'Detailed log' });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });

      await user.click(checkbox);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Local data could not be read or saved.',
      );
      expect(checkbox).not.toBeChecked();
      expect(setDebugLogging).not.toHaveBeenCalled();
    });

    it('opens the log folder', async () => {
      const user = userEvent.setup();
      const { diagnostics, open } = createDiagnostics();
      await renderSettingsPage({ diagnostics });

      await user.click(await screen.findByRole('button', { name: 'Open the log folder' }));

      await waitFor(() => {
        expect(open).toHaveBeenCalledOnce();
      });
      expect(screen.queryByText('The log folder could not be opened.')).not.toBeInTheDocument();
    });

    it('ignores a second press while the folder is opening', async () => {
      const user = userEvent.setup();
      let finish: () => void = () => undefined;
      const { diagnostics, open } = createDiagnostics(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await renderSettingsPage({ diagnostics });
      const button = await screen.findByRole('button', { name: 'Open the log folder' });

      await user.click(button);
      await user.click(button);
      finish();

      await waitFor(() => {
        expect(open).toHaveBeenCalledOnce();
      });
    });

    it('hides the log folder button where it cannot work', async () => {
      // The development diagnostics of the page have no log folder.
      await renderSettingsPage();

      await screen.findByRole('checkbox', { name: 'Detailed log' });
      expect(screen.queryByRole('button', { name: 'Open the log folder' })).not.toBeInTheDocument();
    });

    it('says the folder could not be opened', async () => {
      const user = userEvent.setup();
      const { diagnostics } = createDiagnostics(() =>
        Promise.reject(new AppError('storage', 'secret message of the error')),
      );
      await renderSettingsPage({ diagnostics });

      await user.click(await screen.findByRole('button', { name: 'Open the log folder' }));

      // The fixed text, never the message of the error.
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /^The log folder could not be opened\.$/,
      );
    });

    it('speaks French', async () => {
      const { diagnostics } = createDiagnostics();
      await renderSettingsPage({ language: 'fr', diagnostics });

      const section = await screen.findByRole('region', { name: 'Diagnostic' });
      expect(
        await within(section).findByRole('checkbox', { name: 'Journal détaillé' }),
      ).toHaveAccessibleDescription(
        "Ajoute les lignes de débogage au journal. À n'activer que pour chercher un problème.",
      );
      expect(
        within(section).getByRole('button', { name: 'Ouvrir le dossier du journal' }),
      ).toBeInTheDocument();
    });
  });

  describe('about', () => {
    it('shows the version, the licence, the credit and the privacy note', async () => {
      await renderSettingsPage();

      const section = await screen.findByRole('region', { name: 'About' });
      // The version is written into the bundle at build time: it must be a real one.
      expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
      expect(within(section).getByText(`Version ${APP_VERSION}`)).toBeInTheDocument();
      expect(within(section).getByText('Free software under the MIT licence.')).toBeInTheDocument();
      expect(
        within(section).getByText('Match data comes from deadlock-api.com.'),
      ).toBeInTheDocument();
      expect(
        within(section).getByText('TheLibrary is not affiliated with or endorsed by Valve.'),
      ).toBeInTheDocument();
      expect(
        within(section).getByText(
          'Your data stays on this PC. The app only contacts deadlock-api (match data and images) and Steam, to link your account.',
        ),
      ).toBeInTheDocument();
      // Plain text: nothing to click.
      expect(within(section).queryByRole('link')).not.toBeInTheDocument();
    });

    it('speaks French', async () => {
      await renderSettingsPage({ language: 'fr' });

      const section = await screen.findByRole('region', { name: 'À propos' });
      expect(within(section).getByText(`Version ${APP_VERSION}`)).toBeInTheDocument();
      expect(within(section).getByText('Logiciel libre sous licence MIT.')).toBeInTheDocument();
      expect(
        within(section).getByText("TheLibrary n'est ni affilié à Valve ni approuvé par Valve."),
      ).toBeInTheDocument();
    });
  });
});
