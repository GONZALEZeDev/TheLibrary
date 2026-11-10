/**
 * The "At 14:05" panel of the map replay: what the match looks like at the moment of the shared
 * cursor, as three short lists (the objectives fallen, the players dead with their respawn
 * countdown, and the next scheduled event).
 *
 * @packageDocumentation
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '../../../components/Panel';
import { formatGameTime } from '../analysis-format';
import { instantAt } from './replay-model';
import type { ReplayData } from './replay-model';

/** Props of {@link InstantPanel}. */
export interface InstantPanelProps {
  /** The replay. */
  readonly view: ReplayData;
  /** The moment of the shared cursor, in seconds; fractional while the replay plays. */
  readonly timeS: number;
}

/**
 * The panel of one moment of the match.
 *
 * The summary is computed once per whole second, so that while the replay plays at full speed the
 * lists are rebuilt only when the second changes and not at every animation frame.
 *
 * @returns The panel: its title with the time, then the three lists.
 */
export function InstantPanel({ view, timeS }: InstantPanelProps) {
  const { t } = useTranslation();
  // The panel only reads whole seconds: key the computation on the second, not on the frame.
  const second = Math.floor(timeS);
  const summary = useMemo(() => instantAt(view, second), [view, second]);

  return (
    <Panel as="section" padding="normal" className="space-y-3 text-sm">
      <h3 className="text-base font-semibold">
        {t('replay.panel.title', { time: formatGameTime(second) })}
      </h3>

      {/* The objectives fallen by now, the latest first. */}
      <div>
        <h4 className="text-xs font-semibold uppercase text-fg-muted">
          {t('replay.panel.destroyed')}
        </h4>
        {summary.destroyed.length === 0 ? (
          <p className="text-fg-muted">{t('replay.panel.noneDestroyed')}</p>
        ) : (
          <ul>
            {summary.destroyed.map((objective, index) => (
              <li
                // Two objectives of a kind can fall at the same second: the index keeps the key unique.
                key={`${objective.identity.kind}-${String(objective.destroyedAtS)}-${String(index)}`}
                className="flex justify-between gap-2"
              >
                <span>
                  {t(`replay.objective.${objective.identity.kind}`)}
                  {' · '}
                  {t(`replay.side.${objective.side}`)}
                </span>
                <span className="text-fg-muted">{formatGameTime(objective.destroyedAtS ?? 0)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The players dead at this moment, with or without a path. */}
      <div>
        <h4 className="text-xs font-semibold uppercase text-fg-muted">{t('replay.panel.dead')}</h4>
        {summary.dead.length === 0 ? (
          <p className="text-fg-muted">{t('replay.panel.noneDead')}</p>
        ) : (
          <ul>
            {summary.dead.map(({ player, respawnInS }) => (
              <li key={player.slot} className="flex justify-between gap-2">
                <span>{player.heroName ?? t('timeline.deaths.unknownHero')}</span>
                <span className="text-fg-muted">
                  {respawnInS === null
                    ? t('replay.panel.respawnUnknown')
                    : t('replay.panel.respawnsIn', { s: respawnInS })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The next scheduled event after this moment. */}
      <div>
        <h4 className="text-xs font-semibold uppercase text-fg-muted">{t('replay.panel.next')}</h4>
        {summary.next === null ? (
          <p className="text-fg-muted">{t('replay.panel.noNext')}</p>
        ) : (
          <p>
            {t(`replay.schedule.${summary.next.kind}`)}
            {' · '}
            {formatGameTime(summary.next.timeS)}
          </p>
        )}
      </div>
    </Panel>
  );
}
