/**
 * The live feed under the map: the last five things that happened at the second shown (a death, a
 * fallen objective, a mid boss kill), newest first.
 *
 * The feed never changes size: it always has {@link LIVE_FEED_SIZE} line slots, and an empty slot
 * keeps its height. The events of the match are computed once per view, and the lines once per
 * whole second; the list itself is memoised on those lines, so it re-renders at most once per
 * second while the replay plays. The list is not a live region on purpose: it changes every
 * second while playing, which would flood a screen reader.
 *
 * @packageDocumentation
 */

import { memo, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatGameTime } from '../analysis-format';
import {
  feedEvents,
  liveFeedAt,
  LIVE_FEED_SIZE,
  type FeedEvent,
  type ReplayData,
} from './replay-model';
import { LANE_COLOR, TEAM_TEXT } from './team-style';

/** The props of {@link LiveFeed}. */
export interface LiveFeedProps {
  /** The replay. */
  readonly view: ReplayData;
  /** The moment shown, in seconds; may be fractional. */
  readonly timeS: number;
}

/**
 * The sentence of an event. The team names of an objective or a mid boss line are coloured from
 * the data of the event (the `<team>` and `<claimer>` tags of the translation), never from the
 * translated text; a death line is plain.
 *
 * @param props - The props.
 * @param props.event - The event.
 * @returns The sentence.
 */
function Sentence({ event }: { readonly event: FeedEvent }) {
  const { t } = useTranslation();
  switch (event.kind) {
    case 'death': {
      const victim = event.victim.heroName ?? t('timeline.deaths.unknownHero');
      return event.killer === null
        ? t('replay.feed.deathNoKiller', { victim })
        : t('replay.feed.death', {
            victim,
            killer: event.killer.heroName ?? t('timeline.deaths.unknownHero'),
          });
    }
    case 'objective':
      return (
        <Trans
          i18nKey="replay.feed.objective"
          values={{
            team: t(`replay.teams.${event.objective.team}`),
            objective: t(`replay.objective.${event.objective.identity.kind}`),
          }}
          components={{ team: <span className={TEAM_TEXT[event.objective.team]} /> }}
        />
      );
    case 'mid_boss':
      return (
        <Trans
          i18nKey="replay.feed.midBoss"
          values={{
            team: t(`replay.teams.${event.kill.killedByTeam}`),
            claimer: t(`replay.teams.${event.kill.claimedByTeam}`),
          }}
          components={{
            team: <span className={TEAM_TEXT[event.kill.killedByTeam]} />,
            claimer: <span className={TEAM_TEXT[event.kill.claimedByTeam]} />,
          }}
        />
      );
  }
}

/**
 * The five line slots of the feed, filled from the newest event; memoised on the lines.
 *
 * @returns The list.
 */
const FeedList = memo(function FeedList({ lines }: { readonly lines: readonly FeedEvent[] }) {
  const { t } = useTranslation();
  return (
    // Five lines of 1.5 rem, filled or not (box-content: the border adds to the height).
    <ul className="box-content h-[7.5rem] overflow-hidden rounded border border-fg/10 px-2">
      {Array.from({ length: LIVE_FEED_SIZE }, (_, index) => {
        const event = lines[index];
        if (event === undefined) {
          return (
            <li key={index} className="flex h-6 items-center text-sm text-fg-muted">
              {index === 0 && lines.length === 0 ? t('replay.feed.empty') : null}
            </li>
          );
        }
        const laneId = event.kind === 'objective' ? event.objective.identity.lane : null;
        return (
          <li
            key={`${event.kind}-${String(event.timeS)}-${String(index)}`}
            className="flex h-6 items-center gap-2 text-sm"
          >
            <span className="w-10 shrink-0 tabular-nums text-fg-muted">
              {formatGameTime(event.timeS)}
            </span>
            {laneId !== null && (
              <span
                aria-hidden="true"
                data-lane-dot
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: LANE_COLOR[laneId] }}
              />
            )}
            <span className="truncate">
              <Sentence event={event} />
            </span>
          </li>
        );
      })}
    </ul>
  );
});

/**
 * The live feed: five fixed line slots, newest event first.
 *
 * @returns The feed.
 */
export function LiveFeed({ view, timeS }: LiveFeedProps) {
  const { t } = useTranslation();
  // Every event of the match, computed once per view.
  const events = useMemo(() => feedEvents(view), [view]);
  // The lines only change with the whole second.
  const second = Math.floor(timeS);
  const lines = useMemo(() => liveFeedAt(events, second), [events, second]);
  return (
    <section aria-label={t('replay.feed.title')} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('replay.feed.title')}</h3>
      <FeedList lines={lines} />
    </section>
  );
}
