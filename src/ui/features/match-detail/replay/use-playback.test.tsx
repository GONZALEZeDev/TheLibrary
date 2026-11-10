import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayback } from './use-playback';

describe('usePlayback', () => {
  beforeEach(() => {
    // Fake timers also fake requestAnimationFrame and performance.now.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts paused at 0 and rounds, clamps and pauses on seek', () => {
    const { result } = renderHook(() => usePlayback(100));
    expect(result.current).toMatchObject({ timeS: 0, playing: false, speed: 1 });
    act(() => {
      result.current.seek(12.6);
    });
    expect(result.current.timeS).toBe(12);
    act(() => {
      result.current.seek(500);
    });
    expect(result.current.timeS).toBe(100);
    act(() => {
      result.current.seek(-3);
    });
    expect(result.current.timeS).toBe(0);
  });

  it('advances by elapsed time times the speed while playing', () => {
    const { result } = renderHook(() => usePlayback(100));
    act(() => {
      result.current.setSpeed(4);
    });
    act(() => {
      result.current.toggle();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.playing).toBe(true);
    expect(result.current.timeS).toBeGreaterThan(3.5);
    expect(result.current.timeS).toBeLessThanOrEqual(4.1);
  });

  it('rounds to the nearest second on pause', () => {
    const { result } = renderHook(() => usePlayback(100));
    act(() => {
      result.current.toggle();
    });
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    act(() => {
      result.current.toggle();
    });
    expect(result.current.playing).toBe(false);
    expect(result.current.timeS).toBe(2);
    // Nothing moves once paused.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.timeS).toBe(2);
  });

  it('stops at the duration, and toggle at the end restarts from 0', () => {
    const { result } = renderHook(() => usePlayback(5));
    act(() => {
      result.current.setSpeed(10);
    });
    act(() => {
      result.current.toggle();
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toMatchObject({ timeS: 5, playing: false });
    act(() => {
      result.current.toggle();
    });
    expect(result.current).toMatchObject({ timeS: 0, playing: true });
  });

  it('steps from the current integer second and clamps', () => {
    const { result } = renderHook(() => usePlayback(100));
    act(() => {
      result.current.seek(10);
    });
    act(() => {
      result.current.step(5);
    });
    expect(result.current.timeS).toBe(15);
    act(() => {
      result.current.step(-30);
    });
    expect(result.current.timeS).toBe(0);
  });

  it('keeps the position when the speed changes', () => {
    const { result } = renderHook(() => usePlayback(100));
    act(() => {
      result.current.seek(20);
    });
    act(() => {
      result.current.setSpeed(10);
    });
    expect(result.current).toMatchObject({ timeS: 20, speed: 10 });
  });

  it('cancels its frame on unmount', () => {
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const { result, unmount } = renderHook(() => usePlayback(100));
    act(() => {
      result.current.toggle();
    });
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});
