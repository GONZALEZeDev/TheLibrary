/**
 * Tests of the figure tile.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatTile } from './StatTile';

describe('StatTile', () => {
  it('renders a tile as a term and its value', () => {
    render(
      <dl>
        <StatTile label="Wins" value="12 / 20" />
      </dl>,
    );

    const term = screen.getByRole('term');
    const definition = screen.getByRole('definition');
    expect(term).toHaveTextContent('Wins');
    expect(definition).toHaveTextContent('12 / 20');
    // The term and its value share one box, which is the child of the caller's list.
    expect(term.parentElement).toBe(definition.parentElement);
    expect(term.parentElement?.tagName).toBe('DIV');
    expect(term.parentElement?.parentElement?.tagName).toBe('DL');
  });
});
