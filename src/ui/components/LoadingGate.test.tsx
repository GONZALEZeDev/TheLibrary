/**
 * Tests of the loading gate: the minimum time it shows, the key that starts it again, and its panel.
 *
 * @packageDocumentation
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LoadingGate,
  MINIMUM_LOADING_MS,
  MinimumLoadingProvider,
  useMinimumLoading,
} from './LoadingGate';

/** The props of the hook under test. */
interface GateProps {
  readonly ready: boolean;
  readonly resetKey: unknown;
}

/**
 * Render the hook under a provider with a minimum time.
 *
 * @param minimumMs - The minimum time of the gate.
 * @param initialProps - The first props of the hook.
 * @returns The rendered hook.
 */
function renderGate(minimumMs: number, initialProps: GateProps) {
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <MinimumLoadingProvider minimumMs={minimumMs}>{children}</MinimumLoadingProvider>
  );
  return renderHook(({ ready, resetKey }: GateProps) => useMinimumLoading(ready, resetKey), {
    wrapper,
    initialProps,
  });
}

/**
 * Let the virtual clock run.
 *
 * @param ms - How long.
 */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMinimumLoading', () => {
  it('holds the minimum time of the app', () => {
    expect(MINIMUM_LOADING_MS).toBe(400);
  });

  it('keeps the gate for the minimum time even when the data is read at once', () => {
    const { result } = renderGate(400, { ready: true, resetKey: 'a' });

    expect(result.current).toBe(true);
    advance(399);
    expect(result.current).toBe(true);
    advance(1);
    expect(result.current).toBe(false);
  });

  it('keeps the gate past the minimum until the data is read', () => {
    const { result, rerender } = renderGate(400, { ready: false, resetKey: 'a' });

    advance(1_000);
    expect(result.current).toBe(true);
    rerender({ ready: true, resetKey: 'a' });
    expect(result.current).toBe(false);
  });

  it('shows the gate again from the first render of a new key, for the whole minimum', () => {
    const { result, rerender } = renderGate(400, { ready: true, resetKey: 'a' });
    advance(400);
    expect(result.current).toBe(false);

    rerender({ ready: true, resetKey: 'b' });
    expect(result.current).toBe(true);
    advance(399);
    expect(result.current).toBe(true);
    advance(1);
    expect(result.current).toBe(false);
  });

  it('stays open for its key once open, even when the data is read again', () => {
    const { result, rerender } = renderGate(400, { ready: true, resetKey: 'a' });
    advance(400);
    expect(result.current).toBe(false);

    // A read that starts again (a refresh, a failed read tried again) is not a new opening.
    rerender({ ready: false, resetKey: 'a' });
    expect(result.current).toBe(false);
    // A new key is.
    rerender({ ready: false, resetKey: 'b' });
    expect(result.current).toBe(true);
  });

  it('waits for the data alone when told to skip the minimum, as a page returned to does', () => {
    const { result, rerender } = renderHook(
      ({ ready }: { readonly ready: boolean }) =>
        useMinimumLoading(ready, 'a', { skipMinimum: true }),
      {
        wrapper: ({ children }: { readonly children: ReactNode }) => (
          <MinimumLoadingProvider minimumMs={400}>{children}</MinimumLoadingProvider>
        ),
        initialProps: { ready: false },
      },
    );

    expect(result.current).toBe(true);
    rerender({ ready: true });
    expect(result.current).toBe(false);
  });

  it('opens at once with no minimum, as in a test that gives none', () => {
    const { result } = renderHook(() => useMinimumLoading(true, 'a'));

    expect(result.current).toBe(false);
  });
});

describe('LoadingGate', () => {
  it('says what the app is doing as a status, with a decorative icon that turns only with motion', () => {
    const { container } = render(<LoadingGate text="Analysing the match…" />);

    expect(screen.getByRole('status')).toHaveTextContent('Analysing the match…');
    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveClass('motion-safe:animate-spin');
  });
});
