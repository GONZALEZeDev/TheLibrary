/**
 * Tests of the Paige page: what it shows in English and in French, the artwork and its fallback,
 * the page without a linked account, and the way back from a failed download.
 *
 * @packageDocumentation
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    expect(within(health as HTMLElement).getByText('625')).toBeInTheDocument();
    expect(within(health as HTMLElement).getByText('+33')).toBeInTheDocument();
    for (const name of ['Bookwyrm', 'Plot Armor', 'Captivating Read', 'Rallying Charge']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows the page kept from an earlier launch at once, then the values of this launch', async () => {
    const test = createTestServices({ now: () => NOW });
    const { paige } = test.services;
    const current = (await paige.getPaigePage('en')) ?? expect.unreachable();
    // The page kept before a game patch: other health values.
    const kept = {
      ...current,
      stats: {
        ...current.stats,
        vitality: current.stats.vitality.map((row) =>
          row.key === 'health' ? { ...row, value: 680, perLevel: 31 } : row,
        ),
      },
    };
    vi.spyOn(paige, 'getPaigePage').mockResolvedValue(kept);
    // The download of this launch waits for the test.
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.spyOn(paige, 'refreshPaigePage').mockImplementation(async () => {
      await released;
      return current;
    });

    await renderPaige(test);

    // The kept page shows at once, and the page asks for the one of this launch.
    const health = (await screen.findByText('Health')).closest('li') as HTMLElement;
    expect(within(health).getByText('680')).toBeInTheDocument();
    expect(within(health).getByText('+31')).toBeInTheDocument();
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledWith('en');
    });

    // The new values replace the old ones as soon as they are in, once.
    release();
    await waitFor(() => {
      expect(within(health).getByText('625')).toBeInTheDocument();
    });
    expect(within(health).getByText('+33')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
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
    expect(within(bulletDamage as HTMLElement).getByText('+0,64')).toBeInTheDocument();
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
