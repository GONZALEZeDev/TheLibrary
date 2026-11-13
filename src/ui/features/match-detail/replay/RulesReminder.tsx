/**
 * The rules reminder of the map replay: a static card that restates the fixed timings of a match
 * (camps, crates, power-ups, Soul Urn, Unstable Rift, Mid Boss returns, trooper waves).
 *
 * Every line is written from the schedule table of the core, through the translation templates, so
 * a timing lives in one place only. The card never depends on the clock of the replay.
 *
 * @packageDocumentation
 */
import { memo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { GameIconId } from '../../../../core/match-map/game-icons';
import {
  GAME_SCHEDULE,
  MID_BOSS_LATER_RETURN_DELAY_S,
  MID_BOSS_RETURN_DELAYS_S,
  SCHEDULE_GAME_BUILD,
  TROOPER_WAVES,
} from '../../../../core/match-map/game-schedule';
import type { ScheduleEntry, ScheduleEventKind } from '../../../../core/match-map/game-schedule';
import { formatGameTime } from '../analysis-format';
import { GameIcon } from './GameIcon';

/** Side of the icon of a line, in pixels. */
const ICON_SIZE = 16;

/** Between the delays of the Mid Boss, in the line that tells how long it takes to return. */
const DELAYS_SEPARATOR = ' / ';

/**
 * The game icon of each scheduled event that has one. Bridge power-ups come in four kinds, so the
 * weapon one stands for all of them. Events missing here are written without an icon.
 */
const SCHEDULE_ICONS: Readonly<Partial<Record<ScheduleEventKind, GameIconId>>> = {
  mid_boss: 'mid_boss',
  soul_urn: 'soul_urn',
  small_camps: 'camp_small',
  medium_camps: 'camp_medium',
  large_camps: 'camp_large',
  bridge_powerups: 'powerup_weapon',
};

/**
 * Write one line of the schedule table.
 *
 * @param entry - The table entry.
 * @param t - Translation function.
 * @returns The text of the line.
 */
function scheduleLine(entry: ScheduleEntry, t: TFunction): string {
  const name = t(`replay.schedule.${entry.kind}`);
  if (entry.type === 'once') {
    const text = t('replay.rules.once', { name, time: formatGameTime(entry.atS) });
    // The respawn is appended where the table holds one, never invented.
    return entry.respawnS === null
      ? text
      : `${text} · ${t('replay.schedule.respawn', { time: formatGameTime(entry.respawnS) })}`;
  }
  if (entry.type === 'repeat') {
    return t('replay.rules.repeat', {
      name,
      first: formatGameTime(entry.firstS),
      every: formatGameTime(entry.everyS),
    });
  }
  return t('replay.rules.window', {
    name,
    from: formatGameTime(entry.fromS),
    to: formatGameTime(entry.toS),
  });
}

/** Props of {@link RuleLine}. */
interface RuleLineProps {
  /** The game icon of the line, when the table of icons has one. */
  readonly icon?: GameIconId | undefined;
  /** The text of the line. */
  readonly children: ReactNode;
}

/**
 * One line of the card: an icon column of a fixed width (so the texts line up whether or not a line
 * has an icon) and the text.
 *
 * @returns The list item.
 */
function RuleLine({ icon, children }: RuleLineProps) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex w-4 shrink-0 justify-center">
        {icon === undefined ? null : (
          // Decorative: the text of the line names the event.
          <GameIcon icon={icon} label="" size={ICON_SIZE} fallback="circle" decorative />
        )}
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * The rules reminder card.
 *
 * @returns The card, with a title, one line per rule and the game build the timings come from.
 */
export const RulesReminder = memo(function RulesReminder() {
  const { t } = useTranslation();
  // Every delay the Mid Boss can take, from its first kill to the later ones.
  const delays = [...MID_BOSS_RETURN_DELAYS_S, MID_BOSS_LATER_RETURN_DELAY_S]
    .map(formatGameTime)
    .join(DELAYS_SEPARATOR);

  return (
    <section className="rounded border border-fg/10 p-3 text-sm">
      <h3 className="mb-2 text-sm font-semibold">{t('replay.rules.title')}</h3>
      <ul className="space-y-1">
        {GAME_SCHEDULE.map((entry) => (
          <RuleLine key={`${entry.kind}-${entry.type}`} icon={SCHEDULE_ICONS[entry.kind]}>
            {scheduleLine(entry, t)}
          </RuleLine>
        ))}
        <RuleLine icon="mid_boss">{t('replay.rules.midBossReturns', { delays })}</RuleLine>
        {TROOPER_WAVES.map((stretch) => (
          <RuleLine key={`troopers-${String(stretch.fromS)}`}>
            {t('replay.rules.troopers', {
              every: formatGameTime(stretch.everyS),
              from: formatGameTime(stretch.fromS),
            })}
          </RuleLine>
        ))}
        <RuleLine>{t('replay.rules.build', { build: SCHEDULE_GAME_BUILD })}</RuleLine>
      </ul>
    </section>
  );
});
