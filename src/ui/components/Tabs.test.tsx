/**
 * Tests of the accessible tabs component: the roles and states a screen reader relies on, the
 * keyboard model of the WAI-ARIA tabs pattern (automatic activation) and the link between a tab and
 * its panel.
 *
 * @packageDocumentation
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from './Tabs';

/** The tabs of the tests: the three sections of the match page. */
const TABS = [
  { id: 'analysis', label: 'Analysis' },
  { id: 'damage', label: 'Damage and build' },
  { id: 'players', label: 'Players' },
] as const;

/** Id of one of {@link TABS}. */
type TabId = (typeof TABS)[number]['id'];

/** Props of {@link Harness}. */
interface HarnessProps {
  /** Tab selected on the first render. */
  readonly initial?: TabId;
  /** Spy called with each tab the component asks to select. */
  readonly onSelect?: (id: TabId) => void;
}

/**
 * Parent that owns the selection, as a page does: `Tabs` is controlled, so it only asks to select a
 * tab and shows the one it is given.
 *
 * @param props - See {@link HarnessProps}.
 * @returns The tabs, with the name of the selected tab as the panel content.
 */
function Harness({ initial = 'analysis', onSelect }: HarnessProps) {
  const [selected, setSelected] = useState<TabId>(initial);
  return (
    <Tabs
      label="Match sections"
      tabs={TABS}
      selected={selected}
      onSelect={(id) => {
        setSelected(id);
        onSelect?.(id);
      }}
    >
      <p>{`Content of ${selected}`}</p>
    </Tabs>
  );
}

/**
 * Get a tab by its name.
 *
 * @param name - Visible name of the tab.
 * @returns The tab element.
 */
function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('Tabs', () => {
  it('exposes a tab list with the selected tab', () => {
    render(<Harness initial="damage" />);

    // The list is named, and holds one tab per entry, in order.
    const list = screen.getByRole('tablist', { name: 'Match sections' });
    expect(screen.getAllByRole('tab').map((element) => element.textContent)).toEqual([
      'Analysis',
      'Damage and build',
      'Players',
    ]);
    expect(list).toContainElement(tab('Analysis'));
    // Only the selected tab is selected, and only it is a tab stop (roving tabindex).
    expect(tab('Damage and build')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Damage and build')).toHaveAttribute('tabindex', '0');
    for (const name of ['Analysis', 'Players']) {
      expect(tab(name)).toHaveAttribute('aria-selected', 'false');
      expect(tab(name)).toHaveAttribute('tabindex', '-1');
    }
    // Only the selected panel is rendered.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByText('Content of damage')).toBeInTheDocument();
  });

  it('moves and selects with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(id: TabId) => void>();
    render(<Harness onSelect={onSelect} />);

    // Tab reaches the selected tab only: the other tabs are not tab stops.
    await user.tab();
    expect(tab('Analysis')).toHaveFocus();

    // Each key moves the focus and selects the tab it lands on (automatic activation).
    const steps: readonly { key: string; landsOn: string }[] = [
      { key: '{ArrowRight}', landsOn: 'Damage and build' },
      { key: '{ArrowRight}', landsOn: 'Players' },
      // Wraps from the last tab to the first...
      { key: '{ArrowRight}', landsOn: 'Analysis' },
      // ...and from the first tab to the last.
      { key: '{ArrowLeft}', landsOn: 'Players' },
      { key: '{ArrowLeft}', landsOn: 'Damage and build' },
      { key: '{Home}', landsOn: 'Analysis' },
      { key: '{End}', landsOn: 'Players' },
    ];
    for (const { key, landsOn } of steps) {
      await user.keyboard(key);
      expect(tab(landsOn)).toHaveFocus();
      expect(tab(landsOn)).toHaveAttribute('aria-selected', 'true');
      expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    }
    expect(onSelect.mock.calls.map(([id]) => id)).toEqual([
      'damage',
      'players',
      'analysis',
      'players',
      'damage',
      'analysis',
      'players',
    ]);
  });

  it('selects a tab when it is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(tab('Players'));

    expect(tab('Players')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Content of players')).toBeInTheDocument();
  });

  it('does not ask to select the tab that is already selected', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(id: TabId) => void>();
    render(<Harness onSelect={onSelect} />);

    // A parent that navigates on `onSelect` (the match page pushes a history entry) would record a
    // duplicate entry for a click that changes nothing.
    await user.click(tab('Analysis'));
    expect(onSelect).not.toHaveBeenCalled();

    // A click on another tab still selects it.
    await user.click(tab('Players'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('players');
  });

  it.each(['ArrowLeft', 'ArrowRight', 'Home', 'End'])(
    'takes the %s key from the browser, so that the page does not move',
    (key) => {
      render(<Harness />);

      // `fireEvent` returns false when a listener called `preventDefault()`. Home is pressed on the
      // first tab, where the focus does not move: the key is still ours, and the page must not scroll.
      const notPrevented = fireEvent.keyDown(tab('Analysis'), { key });

      expect(notPrevented).toBe(false);
    },
  );

  it.each([
    { name: 'Alt+ArrowLeft', init: { key: 'ArrowLeft', altKey: true } },
    { name: 'Ctrl+ArrowRight', init: { key: 'ArrowRight', ctrlKey: true } },
    { name: 'Meta+Home', init: { key: 'Home', metaKey: true } },
    { name: 'ArrowDown', init: { key: 'ArrowDown' } },
    { name: 'ArrowUp', init: { key: 'ArrowUp' } },
    { name: 'a letter', init: { key: 'a' } },
    // Enter and Space activate a button: preventing them would break the native click.
    { name: 'Enter', init: { key: 'Enter' } },
    { name: 'Space', init: { key: ' ' } },
  ])('leaves $name to the browser', ({ init }) => {
    render(<Harness />);

    const notPrevented = fireEvent.keyDown(tab('Analysis'), init);

    expect(notPrevented).toBe(true);
  });

  it('leaves the other keys, and the arrows combined with a modifier, to the browser', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(id: TabId) => void>();
    render(<Harness onSelect={onSelect} />);
    await user.tab();

    // Alt+ArrowLeft is the browser's "back": a tab list must not swallow it.
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('a');

    expect(onSelect).not.toHaveBeenCalled();
    expect(tab('Analysis')).toHaveFocus();
  });

  it('labels the panel by its tab', () => {
    render(<Harness initial="damage" />);

    // The panel is named by the selected tab, through `aria-labelledby`...
    const panel = screen.getByRole('tabpanel', { name: 'Damage and build' });
    expect(panel).toHaveAttribute('aria-labelledby', tab('Damage and build').id);
    // ...the tab points back at the panel it controls...
    expect(tab('Damage and build')).toHaveAttribute('aria-controls', panel.id);
    expect(panel.id).not.toBe('');
    expect(panel).toHaveTextContent('Content of damage');
    // ...and the panel can take the focus, so a keyboard user reaches its content from the tab.
    expect(panel).toHaveAttribute('tabindex', '0');
  });

  it('follows the selected tab when the parent changes it', () => {
    const { rerender } = render(
      <Tabs label="Sections" tabs={TABS} selected="analysis" onSelect={vi.fn()}>
        <p>First</p>
      </Tabs>,
    );

    rerender(
      <Tabs label="Sections" tabs={TABS} selected="players" onSelect={vi.fn()}>
        <p>Last</p>
      </Tabs>,
    );

    expect(screen.getByRole('tabpanel', { name: 'Players' })).toHaveTextContent('Last');
    expect(tab('Players')).toHaveAttribute('aria-selected', 'true');
  });

  it('gives two instances ids that do not collide', () => {
    render(
      <>
        <Tabs label="First" tabs={TABS} selected="analysis" onSelect={vi.fn()}>
          <p>One</p>
        </Tabs>
        <Tabs label="Second" tabs={TABS} selected="analysis" onSelect={vi.fn()}>
          <p>Two</p>
        </Tabs>
      </>,
    );

    const ids = screen.getAllByRole('tab').map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
