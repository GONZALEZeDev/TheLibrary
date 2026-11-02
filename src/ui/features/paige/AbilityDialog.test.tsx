/**
 * Tests of the ability window of the Paige page: the card of the game, its upgrade tiers that add
 * up, the damage named by its kind, the timings of the wiki, and the safety of the descriptions.
 *
 * @packageDocumentation
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { FIXTURE_PAIGE_ABILITIES } from '../../../adapters/dev/fixtures/paige.fixture';
import { parseAbilityDetail } from '../../../core/deadlock-api/item-detail.schema';
import type { Language } from '../../../core/settings/language';
import type { AbilityPair } from '../../../services/paige-page.service';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { AbilityDialog } from './AbilityDialog';

/** One of Paige's abilities in English, and in the UI language. */
function pair(className: string, language: 'english' | 'french' = 'english'): AbilityPair {
  return {
    english: parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[className]),
    localised: parseAbilityDetail(FIXTURE_PAIGE_ABILITIES[language][className]),
  };
}

const BOOKWYRM = 'ability_bookworm_dragonfire';

/** A button that opens the window, and the window, as the page holds them. */
function Harness({ ability }: { readonly ability: AbilityPair }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Reopen
      </button>
      <AbilityDialog
        ability={ability}
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

/**
 * Render the window of an ability, open.
 *
 * @param ability - The ability.
 * @param language - The UI language.
 * @returns A simulated user.
 */
async function renderDialog(ability: AbilityPair, language: Language = 'en') {
  const test = createTestServices();
  const i18n = await createI18n(language);
  render(
    <AppProviders
      services={test.services}
      queryClient={createTestQueryClient(test.logger)}
      i18n={i18n}
    >
      <Harness ability={ability} />
    </AppProviders>,
  );
  return userEvent.setup();
}

describe('AbilityDialog', () => {
  it('shows Bookwyrm as the game does, its damage named spirit damage', async () => {
    await renderDialog(pair(BOOKWYRM));
    const dialog = screen.getByRole('dialog', { name: 'Bookwyrm' });

    expect(within(dialog).getByText('33s')).toBeInTheDocument();
    expect(within(dialog).getByText('1 charge')).toBeInTheDocument();
    const damage = within(dialog).getByText('Spirit damage').closest('li');
    expect(within(damage as HTMLElement).getByText('60')).toBeInTheDocument();
    expect(within(damage as HTMLElement).getByText('×1.3')).toBeInTheDocument();
    expect(within(dialog).getByText('Spirit damage per second')).toBeInTheDocument();
  });

  it('shows each chip with the icon of what it measures, and names it on hover', async () => {
    await renderDialog(pair('ability_bookworm_knightcharge'));
    const dialog = screen.getByRole('dialog', { name: 'Rallying Charge' });
    const chips = within(dialog).getByRole('list', { name: 'Timings and sizes' });

    const items = within(chips).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('title'))).toEqual([
      'Cooldown',
      'Channel Duration',
      'Cast Range',
      'Duration',
    ]);
    for (const item of items) {
      expect(item.querySelector('[data-icon]')).not.toBeNull();
    }
    expect(within(chips).getByText('0.7s')).toBeInTheDocument();
  });

  it('adds the first two tiers together when the second is clicked', async () => {
    const user = await renderDialog(pair(BOOKWYRM));
    const dialog = screen.getByRole('dialog', { name: 'Bookwyrm' });

    await user.click(within(dialog).getByRole('button', { name: /Tier 2/ }));

    expect(within(dialog).getByText('21s')).toBeInTheDocument();
    expect(within(dialog).getByText('2 charges')).toBeInTheDocument();
    expect(within(dialog).getByText('5m')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Tier 1/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: /Tier 2/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: /Tier 5/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('drops the highest active tier when it is clicked again', async () => {
    const user = await renderDialog(pair(BOOKWYRM));
    const dialog = screen.getByRole('dialog', { name: 'Bookwyrm' });
    const tier2 = within(dialog).getByRole('button', { name: /Tier 2/ });

    await user.click(tier2);
    await user.click(tier2);

    expect(tier2).toHaveAttribute('aria-pressed', 'false');
    expect(within(dialog).getByRole('button', { name: /Tier 1/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('opens again with no tier active', async () => {
    const user = await renderDialog(pair(BOOKWYRM));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Bookwyrm' })).getByRole('button', {
        name: /Tier 5/,
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Reopen' }));

    const dialog = screen.getByRole('dialog', { name: 'Bookwyrm' });
    expect(within(dialog).getByText('33s')).toBeInTheDocument();
    for (const name of [/Tier 1/, /Tier 2/, /Tier 5/]) {
      expect(within(dialog).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it("shows the timings of the wiki, such as Captivating Read's detonation delay", async () => {
    await renderDialog(pair('ability_bookworm_aoemagic'));
    const dialog = screen.getByRole('dialog', { name: 'Captivating Read' });

    const details = within(dialog).getByRole('region', { name: 'Details (wiki)' });
    const detonation = within(details).getByText('Detonation delay').closest('li');
    expect(within(detonation as HTMLElement).getByText('1.25s')).toBeInTheDocument();
  });

  it('writes what a tier changes when the game gives no text for it', async () => {
    await renderDialog(pair('ability_bookworm_aoemagic'));
    const dialog = screen.getByRole('dialog', { name: 'Captivating Read' });

    expect(
      within(dialog).getByRole('button', { name: /Tier 1.*-14s Cooldown/ }),
    ).toBeInTheDocument();
  });

  it('keeps the English name and writes the rest in French', async () => {
    await renderDialog(pair(BOOKWYRM, 'french'), 'fr');
    const dialog = screen.getByRole('dialog', { name: 'Bookwyrm' });

    expect(within(dialog).getAllByText('Dégâts spirituels').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('33 s')).toBeInTheDocument();
  });

  it('never puts the markup of a description into the page', async () => {
    const bookwyrm = pair(BOOKWYRM);
    const hostile: AbilityPair = {
      ...bookwyrm,
      localised: {
        ...bookwyrm.localised,
        description: '<script>window.hacked = true</script><img src=x onerror="1">Safe text',
      },
    };

    await renderDialog(hostile);
    const dialog = screen.getByRole('dialog', { name: 'Bookwyrm' });

    expect(within(dialog).getByText('Safe text')).toBeInTheDocument();
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('img[src="x"]')).toBeNull();
  });
});
