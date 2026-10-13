/**
 * Tests of the language picker.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import type { Language } from '../../../core/settings/language';
import { createI18n } from '../../i18n/i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

/**
 * Render a UI element with an English i18next instance.
 *
 * @param element - The element to render.
 */
async function renderInEnglish(element: ReactElement): Promise<void> {
  const i18n = await createI18n('en');
  render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

describe('LanguageSwitcher', () => {
  it('checks the current language', async () => {
    await renderInEnglish(<LanguageSwitcher value="fr" onChange={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'Français' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'English' })).not.toBeChecked();
  });

  it('reports the language picked by the user', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(language: Language) => void>();
    await renderInEnglish(<LanguageSwitcher value="en" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Français' }));

    expect(onChange).toHaveBeenCalledWith('fr');
  });

  it('can be operated with the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(language: Language) => void>();
    // English is the second option: if Tab landed on the first one, the focus check would fail.
    await renderInEnglish(<LanguageSwitcher value="en" onChange={onChange} />);

    // Tab enters the group on the checked option; an arrow key picks the previous one.
    await user.tab();
    expect(screen.getByRole('radio', { name: 'English' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');

    expect(onChange).toHaveBeenCalledWith('fr');
  });
});
