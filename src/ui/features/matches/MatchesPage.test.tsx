/**
 * Tests of the match history screen.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../i18n/i18n';
import { MatchesPage } from './MatchesPage';

describe('MatchesPage', () => {
  it('shows its title and explains when matches will appear', async () => {
    const i18n = await createI18n('fr');
    render(
      <I18nextProvider i18n={i18n}>
        <MatchesPage />
      </I18nextProvider>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Parties' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: "Aucune partie pour l'instant" }),
    ).toBeInTheDocument();
  });
});
