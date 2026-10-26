/**
 * The timeline tab of the match page: the chart of the souls of the player over the match, with
 * their deaths, kills and purchases, then the list of their deaths, with the ones that were avoidable.
 *
 * What the tab shows depends on the state of the view (`useTimelineTab`):
 * - `timeline`: the chart, then the list of the deaths;
 * - `unreadable`: a sentence saying the archive of the match cannot be read;
 * - `not_archived`: nothing. The analysis above the tabs says why there is nothing (the detail of
 *   the match is not archived).
 *
 * The tab holds the death picked, which the chart and the list share: a row of the list picks its
 * death and the chart draws its marker larger, and the pointer over a marker of the chart picks its
 * row. The chart and the list are each a section with its own title; the tab only stacks them.
 *
 * @packageDocumentation
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchId } from '../../../core/domain/match';
import { StatusLine } from '../../components/StatusLine';
import { DeathList } from './DeathList';
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
          <TimelineChart
            view={view}
            selectedDeath={selectedDeath}
            onSelectDeath={setSelectedDeath}
          />
          <DeathList
            deaths={view.deaths}
            avoidableCount={view.avoidableCount}
            positions={view.positions}
            selected={selectedDeath}
            onSelect={setSelectedDeath}
          />
        </div>
      );
  }
}
