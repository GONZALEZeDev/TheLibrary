/**
 * Tests of the Paige page: what it shows in English and in French, the artwork and its fallback,
 * the page without a linked account, and the way back from a failed download.
 *
 * @packageDocumentation
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureApi, jsonResponse } from '../../../adapters/dev/fixture-http-client.adapter';
import type { Language } from '../../../core/settings/language';
import {
  createTestQueryClient,
  createTestServices,
  type TestServices,
} from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { PaigePage } from './PaigePage';

/** Time of the tests. */
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

/**
 * Render the Paige page on services built for it.
 *
 * @param test - The services of the test.
 * @param language - The UI language.
 * @returns The render result.
 */
async function renderPaige(test: TestServices, language: Language = 'en') {
  const i18n = await createI18n(language);
  return render(
    <AppProviders
      services={test.services}
      queryClient={createTestQueryClient(test.logger)}
      i18n={i18n}
    >
      <PaigePage />
    </AppProviders>,
  );
}

describe('PaigePage', () => {
  it('shows her keywords, her stats and her four abilities in English', async () => {
    await renderPaige(createTestServices({ now: () => NOW }));

    expect(await screen.findByText('Helpful')).toBeInTheDocument();
    expect(screen.getByText('Protector')).toBeInTheDocument();
    expect(screen.getByText('Booksmart')).toBeInTheDocument();
    const health = screen.getByText('Health').closest('li');
    expect(health).not.toBeNull();
    expect(within(health as HTMLElement).getByText('680')).toBeInTheDocument();
    expect(within(health as HTMLElement).getByText('+31')).toBeInTheDocument();
    for (const name of ['Bookwyrm', 'Plot Armor', 'Captivating Read', 'Rallying Charge']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows the deadlock.wiki artwork, and the bust of the API when it fails to load', async () => {
    const { container } = await renderPaige(createTestServices({ now: () => NOW }));
    await screen.findByText('Helpful');

    const artwork = container.querySelector('img[srcset*="cdn.deadlock.wiki"]');
    expect(artwork).not.toBeNull();
    fireEvent.error(artwork as HTMLImageElement);

    await waitFor(() => {
      expect(container.querySelector('img[src$="bookworm_card.webp"]')).not.toBeNull();
    });
    expect(container.querySelector('img[srcset*="cdn.deadlock.wiki"]')).toBeNull();
  });

  it('writes the numbers the French way and keeps the ability names in English', async () => {
    await renderPaige(createTestServices({ now: () => NOW }), 'fr');

    expect(await screen.findByText('Utile')).toBeInTheDocument();
    const bulletDamage = screen.getByText('Dégâts par balle').closest('li');
    expect(within(bulletDamage as HTMLElement).getByText('32')).toBeInTheDocument();
    expect(within(bulletDamage as HTMLElement).getByText('+0,61')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bookwyrm' })).toBeInTheDocument();
  });

  it('shows the whole page, pictures included, while no account is linked', async () => {
    const { container } = await renderPaige(
      createTestServices({ now: () => NOW, accountId: null }),
    );

    expect(await screen.findByText('Helpful')).toBeInTheDocument();
    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(container.querySelector('img[srcset*="cdn.deadlock.wiki"]')).not.toBeNull();
    expect(screen.queryByText('Link your Steam account')).toBeNull();
  });

  it('offers to try again when the page cannot be downloaded, and shows it once it can', async () => {
    const fixtures = createFixtureApi({ now: NOW });
    const network = { down: true };
    const test = createTestServices({
      now: () => NOW,
      handler: (request) =>
        network.down && request.url.includes('/v1/assets/heroes/')
          ? jsonResponse({ error: 'boom' }, 500)
          : fixtures(request),
    });
    await renderPaige(test);
    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 5_000 });

    network.down = false;
    fireEvent.click(retry);

    expect(await screen.findByText('Helpful')).toBeInTheDocument();
  });
});
