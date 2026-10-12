/**
 * Tests of the dashboard screen.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../i18n/i18n';
import { DashboardPage } from './DashboardPage';

describe('DashboardPage', () => {
  it('shows its title and invites the user to link their Steam account', async () => {
    const i18n = await createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <DashboardPage />
      </I18nextProvider>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'No data yet' })).toBeInTheDocument();
    expect(screen.getByText(/Link your Steam account/)).toBeInTheDocument();
  });
});
