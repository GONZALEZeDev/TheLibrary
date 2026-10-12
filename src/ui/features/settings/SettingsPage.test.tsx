/**
 * Tests of the settings screen, rendered with the real providers and the development adapters.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { SettingsPage } from './SettingsPage';

/**
 * Render the settings screen in English, on a first launch.
 *
 * @returns The services, to inspect what was saved.
 */
async function renderSettingsPage() {
  const { services } = createTestServices();
  const i18n = await createI18n('en');
  render(
    <AppProviders services={services} queryClient={createTestQueryClient()} i18n={i18n}>
      <SettingsPage />
    </AppProviders>,
  );
  return { services };
}

describe('SettingsPage', () => {
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
    await expect(services.settings.get()).resolves.toEqual({ schemaVersion: 1, language: 'fr' });
  });
});
