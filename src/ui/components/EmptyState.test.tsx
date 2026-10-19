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

  it('shows an action below its description', () => {
    render(
      <EmptyState icon={Inbox} title="No account" description="Link your Steam account.">
        <button type="button">Link account</button>
      </EmptyState>,
    );

    const action = screen.getByRole('button', { name: 'Link account' });
    expect(action).toBeInTheDocument();
    // The position is a bit mask: the "following" bit is set when the button comes after the
    // description in the document.
    const description = screen.getByText('Link your Steam account.');
    const position = description.compareDocumentPosition(action);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders nothing below the description without an action', () => {
    const { container } = render(<EmptyState icon={Inbox} title="Title" description="Text" />);

    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('.mt-6')).toBeNull();
  });
});
