/**
 * Tests of the figure of a row of the review: the figure on screen, and the name of its column before
 * it for assistive technologies only.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewFigure } from './ReviewFigure';

describe('ReviewFigure', () => {
  it('writes the figure after the name of its column, which only a screen reader reads', () => {
    render(<ReviewFigure column="Last 20" figure="44%" className="text-sm tabular-nums" />);

    const line = screen.getByText('44%');
    // The line reads "Last 20 44%", not a bare figure.
    expect(line.textContent).toBe('Last 20 44%');
    expect(line.tagName).toBe('P');
    expect(line).toHaveClass('text-sm', 'tabular-nums');
    expect(screen.getByText('Last 20')).toHaveClass('sr-only');
  });
});
