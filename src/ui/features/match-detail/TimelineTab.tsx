/**
 * The timeline tab of the match page: the chart of the souls of the player over the match, with
 * their deaths, kills and purchases, then the list of their deaths, with the ones that were avoidable.
 *
 * What the tab shows depends on the state of the view (`useTimelineTab`):
 * - `timeline`: the chart (with the map replay around it, when the match has one), then the list of
 *   the deaths;
 * - `unreadable`: a sentence saying the archive of the match cannot be read;
 * - `not_archived`: nothing. The analysis above the tabs says why there is nothing (the detail of
 *   the match is not archived).
 *
 * The tab owns the playback clock of the replay: a click on the chart seeks it to the clicked time,
 * and picking a death in the list moves it to a few seconds before that death. The pointer over a
 * death marker of the chart only highlights the death and never moves the clock. It also holds the death picked, which the chart and
 * the list share: a row of the list picks its death and the chart draws its marker larger, and the
 * pointer over a marker of the chart picks its row. The chart and the list are each a section with
 * its own title; the tab only stacks them.
 *
 * While the replay plays, this component renders at every animation frame (the clock is its state).
 * The chart and the list are therefore built as memoised elements: the list never depends on the
 * clock, and the chart only on its whole second.
 *
 * @packageDocumentation
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../core/domain/match';
import { StatusLine } from '../../components/StatusLine';
import { DeathList } from './DeathList';
import { DEATH_LEAD_S } from './replay/replay-model';
import { ReplaySection } from './replay/ReplaySection';
import { usePlayback } from './replay/use-playback';
import { TimelineChart } from './TimelineChart';
import { useTimelineTab } from './use-match-timeline';

/** Props of {@link TimelineTab}. */
export interface TimelineTabProps {
  /** The match whose timeline the tab shows. */
  readonly matchId: MatchId;
}

/**
 * The timeline tab of one match.
 *
 * @returns The chart and the list of the deaths, or the sentence of a tab that cannot show them, or
 *   nothing for a match whose detail is not archived.
 */
export function TimelineTab({ matchId }: TimelineTabProps) {
  const { t } = useTranslation();
  const timeline = useTimelineTab(matchId);
  // The death picked in the list or on the chart, an index into the deaths of the view.
  const [selectedDeath, setSelectedDeath] = useState<number | null>(null);
  const view = timeline.data;
  const timelineView = view?.kind === 'timeline' ? view : null;
  // The one playback clock of the tab, shared by the chart, the death list and the replay. Hooks
  // run on every render, so while the view is not read the clock is one of an empty match.
  const playback = usePlayback(timelineView?.durationS ?? 0);
  // The seconds of the kills of the tracked player, kept stable for the replay's step buttons.
  const trackedKills = useMemo(
    () => timelineView?.kills?.map((kill) => kill.timeS) ?? [],
    [timelineView],
  );

  const { seek } = playback;

  // Pick a death in the list (or let it go): the replay cursor goes a few seconds before a picked
  // death, and letting it go (a `null` index) does not move the cursor. The chart does not use
  // this: it picks on hover, which must only highlight.
  const pickDeath = useCallback(
    (index: number | null) => {
      setSelectedDeath(index);
      const death = index === null ? undefined : timelineView?.deaths?.[index];
      if (death !== undefined) seek(Math.max(0, death.timeS - DEATH_LEAD_S));
    },
    [timelineView, seek],
  );

  // The chart cursor moves by whole seconds, which is the resolution of the data: the map glides
  // between seconds, but the chart is only drawn again when the second changes.
  const cursorSecond = Math.floor(playback.timeS);
  const chart = useMemo(
    () =>
      timelineView === null ? null : (
        <TimelineChart
          view={timelineView}
          selectedDeath={selectedDeath}
          onSelectDeath={setSelectedDeath}
          cursorS={cursorSecond}
          onPickTime={seek}
        />
      ),
    [timelineView, selectedDeath, cursorSecond, seek],
  );

  // The list does not depend on the clock: it is not drawn again while the replay plays.
  const deathList = useMemo(
    () =>
      timelineView === null ? null : (
        <DeathList
          deaths={timelineView.deaths}
          avoidableCount={timelineView.avoidableCount}
          positions={timelineView.positions}
          selected={selectedDeath}
          onSelect={pickDeath}
        />
      ),
    [timelineView, selectedDeath, pickDeath],
  );

  if (view === undefined) {
    // While the view is read (from the local archive, so in a blink) nothing is shown. A failed
    // refresh keeps the view already shown: the error only replaces an empty tab.
    return timeline.isError ? <StatusLine kind="error" error={timeline.error} /> : null;
  }
  switch (view.kind) {
    case 'not_archived':
      // The analysis above the tabs says why there is nothing.
      return null;
    case 'unreadable':
      return <p className="text-sm text-fg-muted">{t('timeline.deaths.unreadable')}</p>;
    case 'timeline':
      return (
        <div className="space-y-6">
          <ReplaySection
            matchId={matchId}
            playback={playback}
            trackedKills={trackedKills}
            chart={chart}
          />
          {deathList}
        </div>
      );
  }
}
