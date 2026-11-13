/**
 * The objectives history under the map: every objective destroyed in the match, oldest first, in a
 * card of a fixed height that scrolls inside itself.
 *
 * The list is complete from the first second; what has not fallen yet at the moment shown is
 * greyed. A line stays clickable either way (seeking ahead is allowed) and moves the cursor to the
 * second the objective fell. The list is computed once per view, and each line is memoised on
 * primitives, so only the lines whose greyed state flips re-render when the whole second changes.
 *
 * @packageDocumentation
 */

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapLaneId } from '../../../../core/match-map/map-objectives';
import type { ObjectiveKind } from '../../../../core/match-map/map-objectives';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import { formatGameTime } from '../analysis-format';
import { objectiveHistory, type ReplayData } from './replay-model';
import { LANE_COLOR, TEAM_TEXT } from './team-style';

/** The props of {@link ObjectivesHistory}. */
export interface ObjectivesHistoryProps {
  /** The replay. */
  readonly view: ReplayData;
  /** The moment shown, in seconds; may be fractional. */
  readonly timeS: number;
  /** Called with the second of a line the user clicked. */
  readonly onSeek: (timeS: number) => void;
}

/** The props of one line: primitives only, so that `memo` compares them cheaply. */
interface LineProps {
  /** The second the objective fell at. */
  readonly destroyedAtS: number;
  /** What the objective is. */
  readonly kind: ObjectiveKind;
  /** The lane of the objective; `null` when it has none. */
  readonly lane: MapLaneId | null;
  /** The team the objective belonged to. */
  readonly team: TeamIdentity;
  /** Whether the objective has not fallen yet at the moment shown. */
  readonly pending: boolean;
  /** Called with the second of the line when it is clicked. */
  readonly onSeek: (timeS: number) => void;
}

/**
 * One line of the history: its time, the lane dot, the kind and the team that lost it.
 *
 * @returns The line, as a button that seeks.
 */
const HistoryLine = memo(function HistoryLine({
  destroyedAtS,
  kind,
  lane,
  team,
  pending,
  onSeek,
}: LineProps) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        type="button"
        data-pending={pending ? 'true' : undefined}
        onClick={() => {
          onSeek(destroyedAtS);
        }}
        className={`flex h-6 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-surface-raised ${
          pending ? 'opacity-40' : ''
        }`}
      >
        <span className="w-10 shrink-0 tabular-nums text-fg-muted">
          {formatGameTime(destroyedAtS)}
        </span>
        {lane !== null && (
          <span
            aria-hidden="true"
            data-lane-dot
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: LANE_COLOR[lane] }}
          />
        )}
        <span>{t(`replay.objective.${kind}`)}</span>
        <span className={TEAM_TEXT[team]}>{t(`replay.teams.${team}`)}</span>
        {pending && <span className="sr-only">{t('replay.history.pending')}</span>}
      </button>
    </li>
  );
});

/** The props of {@link HistoryList}. */
interface HistoryListProps {
  /** The destroyed objectives, oldest first. */
  readonly history: ReturnType<typeof objectiveHistory>;
  /** The whole second shown, which decides the greyed lines. */
  readonly second: number;
  /** Called with the second of a line the user clicked. */
  readonly onSeek: (timeS: number) => void;
}

/**
 * The list body (or the empty sentence), memoised on the history, the whole second and the seek
 * callback, so a frame inside the same second does not touch it.
 *
 * @returns The list.
 */
const HistoryList = memo(function HistoryList({ history, second, onSeek }: HistoryListProps) {
  const { t } = useTranslation();
  if (history.length === 0) {
    return <p className="px-2 py-1 text-sm text-fg-muted">{t('replay.history.empty')}</p>;
  }
  return (
    <ul>
      {history.map((objective) => (
        <HistoryLine
          key={`${objective.team}-${objective.identity.kind}-${String(objective.identity.lane)}-${String(objective.identity.index)}`}
          destroyedAtS={objective.destroyedAtS}
          kind={objective.identity.kind}
          lane={objective.identity.lane}
          team={objective.team}
          pending={objective.destroyedAtS > second}
          onSeek={onSeek}
        />
      ))}
    </ul>
  );
});

/**
 * The history card: a title and the scrolling list of the destroyed objectives.
 *
 * @returns The card.
 */
export function ObjectivesHistory({ view, timeS, onSeek }: ObjectivesHistoryProps) {
  const { t } = useTranslation();
  // The destroyed objectives of the match, computed once per view.
  const history = useMemo(() => objectiveHistory(view), [view]);
  const second = Math.floor(timeS);
  return (
    <section aria-label={t('replay.history.title')} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('replay.history.title')}</h3>
      {/* Six lines of 1.5 rem (box-content: border and padding add to it); more scroll inside. */}
      <div className="box-content h-[9rem] overflow-y-auto rounded border border-fg/10 p-1">
        <HistoryList history={history} second={second} onSeek={onSeek} />
      </div>
    </section>
  );
}
