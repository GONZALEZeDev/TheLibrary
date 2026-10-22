/**
 * Tests of the title block of a screen.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('shows the title as the only level 1 heading, with its description under it', () => {
    render(<PageHeader title="Settings" description="Choose how the app looks." />);

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Choose how the app looks.')).toBeInTheDocument();
  });

  it('adds no block under the title of a screen that gives nothing to put there', () => {
    const { container } = render(<PageHeader title="Settings" />);

    // The other screens are unchanged: the header holds the title and nothing else.
    expect(container.querySelector('header')?.children).toHaveLength(1);
  });

  it('shows what a screen puts under its title, inside the header and after the title', () => {
    const { container } = render(
      <PageHeader title="Match 100000001">
        <p>The facts of the match</p>
      </PageHeader>,
    );

    const header = container.querySelector('header');
    const facts = screen.getByText('The facts of the match');
    // The facts belong to the title they describe: they sit in its header, close under it, so that
    // the space left is between the whole block and the content that follows.
    expect(header).toContainElement(facts);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(facts.parentElement).toHaveClass('mt-2');
  });

  it('shows what a screen puts under its title after the description', () => {
    render(
      <PageHeader title="Match 100000001" description="A description">
        <p>The facts of the match</p>
      </PageHeader>,
    );

    const description = screen.getByText('A description');
    const facts = screen.getByText('The facts of the match');
    expect(
      description.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([null, undefined, false])('adds no block for a child that is %s', (child) => {
    const { container } = render(<PageHeader title="Settings">{child}</PageHeader>);

    expect(container.querySelector('header')?.children).toHaveLength(1);
  });
});
