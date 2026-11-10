/**
 * The map replay of the timeline tab, laid out around the souls chart (layout "B"): on wide screens
 * the map takes the left 45 % and the chart and the "At 14:05" panel stack on the right, and the
 * playback bar spans the full width below; on narrow screens everything stacks.
 *
 * The chart is a slot (`chart`): the tab builds it, since it shares the picked death with the death
 * list, and this section only decides where it stands. What the section shows depends on the replay
 * (`useMatchReplay`):
 * - loading, `not_archived` or a failed read: the chart alone, as the tab looks without a replay
 *   (the analysis above the tabs says why there is no detail, and a failed read must not hide the
 *   chart that does not need it);
 * - `unreadable`: the chart and a sentence saying that the replay cannot be read;
 * - `replay`: the layout above. The map area holds the map, or a sentence when the map cannot be
 *   drawn (`map` is `null`, or no player has a path); a replay that only knows the tracked player
 *   draws the map with a sentence under it. The bar and the panel always stay.
 *
 * The section is focusable and answers the keyboard, see {@link ReplaySection}.
 *
 * @packageDocumentation
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../../core/domain/match';
import { InstantPanel } from './InstantPanel';
import { PlaybackBar } from './PlaybackBar';
import { stepEvents } from './replay-model';
import { ReplayMap } from './ReplayMap';
import { useMatchReplay } from './use-match-replay';
import type { Playback } from './use-playback';

/** How many seconds an arrow key moves the cursor. */
const SMALL_STEP_S = 1;

/** How many seconds an arrow key moves the cursor while Shift is held. */
const LARGE_STEP_S = 10;

/** The elements that keep every key: they use the arrows, Space and more themselves. */
const ALL_KEYS_TAGS: ReadonlySet<string> = new Set(['TEXTAREA', 'SELECT']);

/**
 * Whether the section leaves a key to the element it was pressed on.
 *
 * The exemption is per key, not per element, so that the arrows keep working once a button of the
 * bar has the focus: a button keeps Space and Enter (its click), a range slider keeps its plain
 * arrows (one second, native), and every other input, a textarea or a select keeps all its keys.
 *
 * @param target - The element the key was pressed on.
 * @param event - The key event.
 * @returns `true` when the element handles the key and the section must not.
 */
function isKeyOwnedByTarget(target: Element, event: KeyboardEvent<HTMLElement>): boolean {
  if (ALL_KEYS_TAGS.has(target.tagName)) return true;
  if (target.tagName === 'BUTTON') return event.key === ' ' || event.key === 'Enter';
  if (target instanceof HTMLInputElement) {
    // The slider moves by one second with the plain arrows; the section takes Shift + arrows
    // and Space.
    if (target.type === 'range') {
      return (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.shiftKey;
    }
    return true;
  }
  return false;
}

/** Props of {@link ReplaySection}. */
export interface ReplaySectionProps {
  /** The match whose replay the section shows. */
  readonly matchId: MatchId;
  /** The playback clock, owned by the tab so that the chart and the death list can move it too. */
  readonly playback: Playback;
  /** The souls chart: in the right column next to the map, or alone when there is no replay. */
  readonly chart: ReactNode;
  /**
   * The seconds of the kills of the tracked player, which the previous / next event buttons jump
   * between with the objectives and the deaths. Keep the array stable between renders.
   */
  readonly trackedKills: readonly number[];
}

/**
 * The replay of one match around the souls chart.
 *
 * Keyboard: the root takes the focus (`tabIndex` 0, named by `replay.title`) and, while it has it,
 * the arrows step the cursor by one second (by ten with Shift) and Space plays or pauses. The
 * controls inside keep only the keys they need, per key: a button keeps Space and Enter (its click)
 * but the arrows still reach the section, so they work after a click on a button; the range slider
 * keeps its plain arrows (one second, native) while Shift + arrows (ten seconds) and Space are
 * handled by the section, which stops the slider from also moving; a textarea, a select or another
 * input keeps every key.
 *
 * @returns The chart alone, the chart and a sentence, or the whole replay layout.
 */
export function ReplaySection({ matchId, playback, chart, trackedKills }: ReplaySectionProps) {
  const { t } = useTranslation();
  const replay = useMatchReplay(matchId);
  // Whether the map draws the trails of the players; on by default, toggled by the map's button.
  const [showTrails, setShowTrails] = useState(true);
  const view = replay.data;
  const stepTimes = useMemo(
    () => (view?.kind === 'replay' ? stepEvents(view, trackedKills) : []),
    [view, trackedKills],
  );

  if (view === undefined || view.kind === 'not_archived') {
    // Loading, a failed read or no detail: the tab looks as it did before the replay existed.
    return <>{chart}</>;
  }
  if (view.kind === 'unreadable') {
    return (
      <>
        {chart}
        <p className="text-sm text-fg-muted">{t('replay.unreadable')}</p>
      </>
    );
  }

  // Drive the cursor from the keyboard, see the TSDoc of the component.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const { target } = event;
    // A control inside the section keeps its own keys.
    if (target !== event.currentTarget && target instanceof Element) {
      if (isKeyOwnedByTarget(target, event)) return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const stepS = event.shiftKey ? LARGE_STEP_S : SMALL_STEP_S;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        playback.step(-stepS);
        break;
      case 'ArrowRight':
        event.preventDefault();
        playback.step(stepS);
        break;
      case ' ':
        event.preventDefault();
        playback.toggle();
        break;
      default:
        break;
    }
  };

  // The map, or the sentence that tells why it is not drawn.
  const mapArea =
    view.map === null ? (
      <p className="text-sm text-fg-muted">{t('replay.notice.mapUnavailable')}</p>
    ) : view.coverage === 'none' ? (
      <p className="text-sm text-fg-muted">{t('replay.notice.noPositions')}</p>
    ) : (
      <div className="space-y-2">
        <ReplayMap
          view={view}
          timeS={playback.timeS}
          showTrails={showTrails}
          onToggleTrails={() => {
            setShowTrails((shown) => !shown);
          }}
        />
        {view.coverage === 'tracked_only' ? (
          <p className="text-sm text-fg-muted">{t('replay.notice.trackedOnly')}</p>
        ) : null}
      </div>
    );

  return (
    // The section is focusable on purpose: the keys of the replay only work while it has the focus,
    // so the arrows and Space do not take over the page. Its label names it for assistive tools.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label={t('replay.title')}
      onKeyDown={onKeyDown}
      className="space-y-4 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright"
    >
      {/* Wide: the map on the left (45 %), the chart then the panel on the right (55 %). */}
      <div className="grid gap-4 lg:grid-cols-[45fr_55fr]">
        <div className="min-w-0">{mapArea}</div>
        <div className="min-w-0 space-y-4">
          {chart}
          <InstantPanel view={view} timeS={playback.timeS} />
        </div>
      </div>
      <PlaybackBar view={view} playback={playback} stepTimes={stepTimes} />
    </section>
  );
}
