/**
 * Tests of the update dialog and of the check made at startup, rendered with the real providers,
 * the development adapters and a stub update gateway.
 *
 * @packageDocumentation
 */
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../core/errors/app-error';
import type { AvailableUpdate, InstallProgress } from '../../../services/update.service';
import {
  createTestQueryClient,
  createTestServices,
  type TestServicesOptions,
} from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { UpdateHost } from './UpdateHost';

/** The update gateway of the services (the interface never imports the port itself). */
type UpdateGateway = NonNullable<TestServicesOptions['updateGateway']>;

const UPDATE: AvailableUpdate = {
  version: '0.2.0',
  currentVersion: '0.1.0',
  date: Date.UTC(2026, 10, 2, 12),
  rawNotes: JSON.stringify({
    en: 'A summer release.\n\n### Added\n\n- In-app updates.\n\n### Fixed\n\n- A [crash](https://example.test).',
    fr: 'Une version d’été.\n\n### Ajouts\n\n- Les mises à jour dans l’app.',
  }),
};

/** A gateway whose install waits until the test lets it end, reporting its progress first. */
function createGateway(overrides: Partial<UpdateGateway> = {}) {
  let finishInstall: (error?: Error) => void = () => undefined;
  let reportProgress: (progress: InstallProgress) => void = () => undefined;
  const gateway = {
    check: vi.fn<UpdateGateway['check']>(() => Promise.resolve(UPDATE)),
    install: vi.fn<UpdateGateway['install']>(
      (onProgress) =>
        new Promise<void>((resolve, reject) => {
          reportProgress = onProgress;
          finishInstall = (error) => {
            if (error === undefined) resolve();
            else reject(error);
          };
        }),
    ),
    openReleasePage: vi.fn<UpdateGateway['openReleasePage']>(() => Promise.resolve()),
    ...overrides,
  };
  return {
    gateway,
    finishInstall: (error?: Error) => {
      finishInstall(error);
    },
    reportProgress: (progress: InstallProgress) => {
      reportProgress(progress);
    },
  };
}

/**
 * Render the startup check alone.
 *
 * @param gateway - The update gateway of the services.
 * @param language - Language of the interface.
 */
async function renderStartupCheck(gateway: UpdateGateway, language: 'en' | 'fr' = 'en') {
  const { services } = createTestServices({ updateGateway: gateway });
  const i18n = await createI18n(language);
  render(
    <AppProviders services={services} queryClient={createTestQueryClient()} i18n={i18n}>
      <UpdateHost />
    </AppProviders>,
  );
}

describe('UpdateHost', () => {
  it('offers the newer version with its date and English summary', async () => {
    await renderStartupCheck(createGateway().gateway);

    const dialog = await screen.findByRole('dialog', { name: 'Update available' });
    expect(dialog).toHaveTextContent('Version 0.2.0 is out — you have 0.1.0.');
    expect(dialog).toHaveTextContent('Published on Nov 2, 2026');
    expect(screen.getByRole('heading', { level: 3, name: 'Added' })).toBeInTheDocument();
    expect(screen.getByText('In-app updates.')).toBeInTheDocument();
    // The address of a link is never shown nor followed.
    expect(screen.getByText('A crash.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the French summary in French', async () => {
    await renderStartupCheck(createGateway().gateway, 'fr');

    await screen.findByRole('dialog', { name: 'Mise à jour disponible' });
    expect(screen.getByRole('heading', { level: 3, name: 'Ajouts' })).toBeInTheDocument();
    expect(screen.getByText('Les mises à jour dans l’app.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plus tard' })).toBeInTheDocument();
  });

  it('shows the English summary to a French player when there is no French one', async () => {
    const { gateway } = createGateway({
      check: () => Promise.resolve({ ...UPDATE, rawNotes: JSON.stringify({ en: '- Fixes.' }) }),
    });
    await renderStartupCheck(gateway, 'fr');

    expect(await screen.findByText('Fixes.')).toBeInTheDocument();
  });

  it('leaves out the date when the update has none, and says when there is no summary', async () => {
    const { gateway } = createGateway({
      check: () => Promise.resolve({ ...UPDATE, date: null, rawNotes: null }),
    });
    await renderStartupCheck(gateway);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent('Published');
    expect(dialog).toHaveTextContent('No summary for this version.');
  });

  it('closes on Later, without installing', async () => {
    const user = userEvent.setup();
    const { gateway } = createGateway();
    await renderStartupCheck(gateway);

    await user.click(await screen.findByRole('button', { name: 'Later' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(gateway.install).not.toHaveBeenCalled();
  });

  it('shows nothing when the check fails or finds nothing', async () => {
    const check = vi.fn(() => Promise.reject(new AppError('network', 'x')));
    const failing = createGateway({ check });
    await renderStartupCheck(failing.gateway);
    await waitFor(() => {
      expect(check).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the GitHub page of the release', async () => {
    const user = userEvent.setup();
    const { gateway } = createGateway();
    await renderStartupCheck(gateway);

    await user.click(await screen.findByRole('button', { name: 'View on GitHub' }));
    expect(gateway.openReleasePage).toHaveBeenCalledWith('0.2.0');
  });

  it('installs once, shows the progress, and cannot be closed meanwhile', async () => {
    const user = userEvent.setup();
    const { gateway, reportProgress } = createGateway();
    await renderStartupCheck(gateway);

    const install = await screen.findByRole('button', { name: 'Install now' });
    await user.dblClick(install);
    expect(gateway.install).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Downloading the update…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();

    reportProgress({ phase: 'downloading', downloadedBytes: 512, totalBytes: 2048 });
    expect(await screen.findByText('Downloading the update… 25 %')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '25');

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    reportProgress({ phase: 'installing' });
    expect(await screen.findByText('Installing… TheLibrary will restart.')).toBeInTheDocument();
  });

  it('says when the installation fails and gives the choice back', async () => {
    const user = userEvent.setup();
    const { gateway, finishInstall } = createGateway();
    await renderStartupCheck(gateway);

    await user.click(await screen.findByRole('button', { name: 'Install now' }));
    finishInstall(new AppError('invalid_payload', 'signature mismatch'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The update could not be installed. TheLibrary keeps running on its current version; the details are in the log.',
    );
    // The raw error never reaches the screen.
    expect(screen.queryByText(/signature mismatch/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
  });
});
