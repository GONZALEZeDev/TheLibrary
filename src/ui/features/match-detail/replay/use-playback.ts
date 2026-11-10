/**
 * The playback clock of the map replay: the one moment the whole replay is drawn at.
 *
 * It is the only state that changes at every animation frame, so the components read the moment
 * from here and derive everything else (positions, trails, panel) from it.
 *
 * @packageDocumentation
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How fast the replay plays, as a multiple of the real time. */
export type PlaybackSpeed = 1 | 4 | 10;

/** The playback clock and its controls. */
export interface Playback {
  /** The moment, in seconds since the match start: fractional while playing, whole once paused. */
  readonly timeS: number;
  /** Whether the clock is running. */
  readonly playing: boolean;
  /** The speed of the clock. */
  readonly speed: PlaybackSpeed;
  /** Jump to a moment: rounded, clamped to the match, and the clock pauses. */
  readonly seek: (timeS: number) => void;
  /** Move by a number of seconds from the current whole second, and pause. */
  readonly step: (deltaS: number) => void;
  /** Play or pause; playing from the end starts again from 0. */
  readonly toggle: () => void;
  /** Change the speed without moving the replay. */
  readonly setSpeed: (speed: PlaybackSpeed) => void;
}

/**
 * Run the playback clock of a match.
 *
 * @param durationS - How long the match lasted, in seconds; the clock stops there.
 * @returns The moment and the controls.
 */
export function usePlayback(durationS: number): Playback {
  const [timeS, setTimeS] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);
  // The moment as the frame loop and the controls see it, so they never read a stale render.
  const timeRef = useRef(0);

  /** Move the clock to a moment, kept inside the match. */
  const moveTo = useCallback(
    (moment: number) => {
      timeRef.current = Math.min(Math.max(moment, 0), durationS);
      setTimeS(timeRef.current);
    },
    [durationS],
  );

  // The frame loop only exists while playing and is cancelled on pause, speed change or unmount.
  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now();
    let frame = 0;
    const tick = () => {
      const now = performance.now();
      moveTo(timeRef.current + ((now - last) / 1000) * speed);
      last = now;
      if (timeRef.current >= durationS) {
        // The end of the match: stop on a whole second.
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, speed, durationS, moveTo]);

  const seek = useCallback(
    (moment: number) => {
      setPlaying(false);
      moveTo(Math.floor(moment));
    },
    [moveTo],
  );

  const step = useCallback(
    (deltaS: number) => {
      setPlaying(false);
      moveTo(Math.round(timeRef.current) + deltaS);
    },
    [moveTo],
  );

  const toggle = useCallback(() => {
    if (playing) {
      // Pausing lands on the nearest second.
      setPlaying(false);
      moveTo(Math.round(timeRef.current));
      return;
    }
    // Playing from the end starts the match again.
    if (timeRef.current >= durationS) moveTo(0);
    setPlaying(true);
  }, [playing, durationS, moveTo]);

  const setSpeed = useCallback((next: PlaybackSpeed) => {
    setSpeedState(next);
  }, []);

  return { timeS, playing, speed, seek, step, toggle, setSpeed };
}
