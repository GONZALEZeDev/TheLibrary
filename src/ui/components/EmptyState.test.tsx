/**
 * Tests of the empty-state placeholder.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('shows the title as a heading and the description', () => {
    render(<EmptyState icon={Inbox} title="No matches yet" description="They will appear here." />);

    expect(screen.getByRole('heading', { level: 2, name: 'No matches yet' })).toBeInTheDocument();
    expect(screen.getByText('They will appear here.')).toBeInTheDocument();
  });

  it('hides the decorative icon from assistive technologies', () => {
    const { container } = render(<EmptyState icon={Inbox} title="Title" description="Text" />);

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
