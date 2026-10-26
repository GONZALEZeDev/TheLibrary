/**
 * Tests of the win/loss badge.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { createI18n } from '../i18n/i18n';
import { ResultBadge } from './ResultBadge';

/**
 * Render a badge in a language.
 *
 * @param language - The language of the catalogues.
 * @param won - Whether the badge tells a win.
 * @param size - The size of the badge, when not the default.
 * @returns The container of the render.
 */
async function renderBadge(language: 'en' | 'fr', won: boolean, size?: 'small' | 'medium') {
  const i18n = await createI18n(language);
  return render(
    <I18nextProvider i18n={i18n}>
      <ResultBadge won={won} {...(size === undefined ? {} : { size })} />
    </I18nextProvider>,
  );
}

describe('ResultBadge', () => {
  it.each([
    ['en', true, 'W', 'Win'],
    ['en', false, 'L', 'Loss'],
    ['fr', true, 'V', 'Victoire'],
    ['fr', false, 'D', 'Défaite'],
  ] as const)(
    'shows the letter and says the word of a win and a loss (%s, won: %s)',
    async (language, won, letter, word) => {
      const { container } = await renderBadge(language, won);

      // The word is read once, by the screen-reader text; the letter is only for the eyes.
      expect(container).toHaveTextContent(`${letter}${word}`);
      expect(screen.getByText(word)).toHaveClass('sr-only');
      expect(screen.getByText(letter)).toHaveAttribute('aria-hidden', 'true');
    },
  );

  it('draws a win and a loss with different shapes', async () => {
    const win = (await renderBadge('en', true)).container.firstElementChild;
    const loss = (await renderBadge('en', false)).container.firstElementChild;

    // A win is a filled square, a loss an outlined one: the result is not told by colour alone.
    expect(win).toHaveClass('bg-win/20', 'text-win');
    expect(win).not.toHaveClass('border');
    expect(loss).toHaveClass('border', 'border-loss', 'text-loss');
    expect(loss).not.toHaveClass('bg-win/20');
  });

  it('draws a small badge smaller than a medium one', async () => {
    const small = (await renderBadge('en', true, 'small')).container.firstElementChild;
    const medium = (await renderBadge('en', true)).container.firstElementChild;

    expect(small).toHaveClass('size-6');
    expect(medium).toHaveClass('size-8');
  });
});
