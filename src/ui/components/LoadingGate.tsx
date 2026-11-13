/**
 * The loading gate of the pages that analyse: a panel that says the app is working, shown for at
 * least a short time before the content of the page.
 *
 * The pages read their data from the local database, so it is usually there in a blink, and the
 * content would pop in under the title with nothing to say that the app looked at anything. The gate
 * gives that moment a face: the page shows the panel until its data is read and a minimum time has
 * passed, whichever comes last. The minimum runs from the moment the page asks for its data, in
 * parallel with the read, so it never adds to a real wait.
 *
 * The minimum comes from a React context ({@link MinimumLoadingProvider}): the app gives it
 * {@link MINIMUM_LOADING_MS}, and a test that gives nothing gets none, so the tests that are not about
 * the gate see the content as soon as it is read.
 *
 * @packageDocumentation
 */
import { LoaderCircle } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Panel } from './Panel';

/**
 * The minimum time the gate shows, in milliseconds: long enough to be seen as the app working on
 * what the player picked, short enough to never feel like a wait.
 */
export const MINIMUM_LOADING_MS = 400;

/** The minimum time of the gate, in milliseconds; none unless a provider gives one. */
const MinimumLoadingContext = createContext(0);

/** Props of {@link MinimumLoadingProvider}. */
export interface MinimumLoadingProviderProps {
  /** The minimum time of the gate, in milliseconds; 0 for none. */
  readonly minimumMs: number;
  readonly children: ReactNode;
}

/**
 * Give the pages under it the minimum time of their loading gate.
 *
 * @returns The provider wrapping `children`.
 */
export function MinimumLoadingProvider({ minimumMs, children }: MinimumLoadingProviderProps) {
  return <MinimumLoadingContext value={minimumMs}>{children}</MinimumLoadingContext>;
}

/** The key the gate follows, whether its minimum time has passed, and whether it has opened. */
interface GateState {
  readonly key: unknown;
  readonly elapsed: boolean;
  readonly opened: boolean;
}

/**
 * The state of a gate that starts following a key.
 *
 * @param key - The key.
 * @param minimumMs - The minimum time of the gate: with none, it has passed already.
 * @param skipMinimum - Whether the gate waits for the data alone, with no minimum time.
 * @returns The state.
 */
function closedGate(key: unknown, minimumMs: number, skipMinimum: boolean): GateState {
  return { key, elapsed: minimumMs <= 0 || skipMinimum, opened: false };
}

/**
 * Whether a page shows its loading gate: until its data is read and the minimum time has passed
 * since the key last changed.
 *
 * The key names what the page shows (the match of a match page, say): a new key shows the gate
 * again from its very first render, so the content of the previous key never shows under the new
 * one, and starts the minimum again. A change the key does not follow (another tab of the same
 * match) shows no gate.
 *
 * Once open, the gate stays open for its key, whatever the data does next: the content then shows
 * its own states. A read that starts again (a refresh, or a failed read tried again by the content
 * as it mounts) must not close the gate, which would take the content away, mount it again when the
 * read ends, and start the read again, endlessly.
 *
 * A page returned to through the browser history skips the minimum (`skipMinimum`): the router gives
 * its scroll back right after it draws it, which only works on the content at its full height, not
 * on the short panel of the gate. The option is read when a key starts.
 *
 * @param ready - Whether the data of the page is read (or failed to be: an error is content too).
 * @param resetKey - What the page shows; compared with `Object.is`.
 * @param options - How the gate waits.
 * @param options.skipMinimum - Whether to wait for the data alone, with no minimum time.
 * @returns `true` while the page must show the gate instead of its content.
 */
export function useMinimumLoading(
  ready: boolean,
  resetKey: unknown,
  { skipMinimum = false }: { readonly skipMinimum?: boolean } = {},
): boolean {
  const minimumMs = useContext(MinimumLoadingContext);
  const [gate, setGate] = useState<GateState>(() => closedGate(resetKey, minimumMs, skipMinimum));
  // The state follows the key and opens the gate during the render rather than in an effect, the
  // way React adjusts a state to its props: the render that brings a new key already shows the gate,
  // and the render where the data and the minimum are both there already shows the content.
  let current = Object.is(gate.key, resetKey) ? gate : closedGate(resetKey, minimumMs, skipMinimum);
  if (!current.opened && ready && current.elapsed) {
    current = { ...current, opened: true };
  }
  if (current !== gate) {
    setGate(current);
  }
  useEffect(() => {
    if (minimumMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      // Only the key this timer was started for: a later key has its own timer.
      setGate((latest) =>
        Object.is(latest.key, resetKey) ? { ...latest, elapsed: true } : latest,
      );
    }, minimumMs);
    return () => {
      clearTimeout(timer);
    };
  }, [resetKey, minimumMs]);
  return !current.opened;
}

/** Props of {@link LoadingGate}. */
export interface LoadingGateProps {
  /** What the app is doing, already translated ("Analysing the match…"). */
  readonly text: string;
}

/**
 * The panel a page shows while its gate is closed: a turning icon and what the app is doing.
 *
 * It is a status: a screen reader announces the text politely. The icon only turns when the system
 * allows animations (`motion-safe`); the panel shows either way.
 *
 * @returns The panel.
 */
export function LoadingGate({ text }: LoadingGateProps) {
  return (
    <Panel as="div" padding="normal" role="status" className="flex items-center gap-3">
      <LoaderCircle
        aria-hidden="true"
        className="size-5 text-accent-bright motion-safe:animate-spin"
      />
      <span className="text-sm text-fg-muted">{text}</span>
    </Panel>
  );
}
