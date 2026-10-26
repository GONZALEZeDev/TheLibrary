/**
 * The list of the deaths of the player in the timeline tab of the match page: when each one came,
 * who killed them and how fast, how many enemies and allies were near, and whether the death was
 * avoidable.
 *
 * The title counts the deaths and, when the positions of the other players are known, the avoidable
 * ones. Each death is a button that picks it, so that the chart above draws its marker larger: the
 * list is the path to each death by the keyboard, and the one for assistive technologies, as the
 * chart is a picture. An avoidable death carries the ▼ shape beside its word, so that the colour
 * never tells it alone.
 *
 * What is not known is said instead of being shown as a zero: a sentence stands in for the rows when
 * the death detail is incomplete, and for the players near and the verdicts when the positions are
 * not in the archive (with the download to come, when one is planned).
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TimelineDeath, TimelinePositions } from '../../../services/match-timeline-view';
import { formatGameTime, formatOneDecimal, INSIGHT_STYLE, NO_VALUE } from './analysis-format';

/** Props of {@link DeathList}. */
export interface DeathListProps {
  /** The deaths of the player, sorted from the earliest; `null` when their detail is incomplete. */
  readonly deaths: readonly TimelineDeath[] | null;
  /**
   * How many of the deaths were avoidable, as the timeline counts them; `null` when the deaths or
   * the positions are not known.
   */
  readonly avoidableCount: number | null;
  /** Whether the players near each death are known. */
  readonly positions: TimelinePositions;
  /** The death picked, an index into `deaths`; `null` when none is. */
  readonly selected: number | null;
  /**
   * Pick a death, or let the picked one go.
   *
   * @param index - The index of the death in `deaths`, or `null` for none.
   */
  readonly onSelect: (index: number | null) => void;
}

/** Between the parts of the title and of the sentence of a death: "Your deaths · 4 · 2 avoidable". */
const SEPARATOR = ' · ';

/** Between the enemies and the allies near a death: "3 enemies near you, no ally". */
const NEAR_SEPARATOR = ', ';

/** The look of the label of an avoidable death: the ▼ shape and the colours of a weakness. */
const AVOIDABLE_STYLE = INSIGHT_STYLE.weakness;

/**
 * The name of the killer of a death.
 *
 * @param death - The death.
 * @param t - Translation function.
 * @returns The name of the hero, "a hero" when the catalogue does not name it, or the troopers and
 *   the environment for a death by the world.
 */
export function killerName(death: TimelineDeath, t: TFunction): string {
  if (death.killer.kind === 'world') {
    return t('timeline.deaths.world');
  }
  return death.killer.name ?? t('timeline.deaths.unknownHero');
}

/**
 * The title of the list.
 *
 * @param deaths - The deaths, or `null` when their detail is incomplete.
 * @param avoidableCount - How many were avoidable, or `null` when it is not known.
 * @param t - Translation function.
 * @returns The count of the deaths (a dash when it is not known), then the count of the avoidable
 *   ones when it is known and there was at least one death.
 */
function titleOf(
  deaths: readonly TimelineDeath[] | null,
  avoidableCount: number | null,
  t: TFunction,
): string {
  const title = t('timeline.deaths.title', {
    count: deaths === null ? NO_VALUE : String(deaths.length),
  });
  // The avoidable count only adds to a count of deaths that is known and is not zero.
  return avoidableCount === null || deaths === null || deaths.length === 0
    ? title
    : `${title}${SEPARATOR}${t('timeline.deaths.titleAvoidable', { count: avoidableCount })}`;
}

/**
 * What a row says of a death.
 *
 * @param death - The death.
 * @param positionsKnown - Whether the players near the death are known.
 * @param t - Translation function.
 * @param language - The language of the interface, for the decimal of the time to kill.
 * @returns Who killed the player and in how long, then, when the positions are known, the enemies
 *   and the allies near them.
 */
function sentenceOf(
  death: TimelineDeath,
  positionsKnown: boolean,
  t: TFunction,
  language: string,
): string {
  const killedBy = t('timeline.deaths.killedBy', { killer: killerName(death, t) });
  const killed =
    death.timeToKillS === null
      ? killedBy
      : `${killedBy} ${t('timeline.deaths.timeToKill', { seconds: formatOneDecimal(death.timeToKillS, language) })}`;
  const { enemiesNear, alliesNear } = death;
  if (!positionsKnown || enemiesNear === null || alliesNear === null) {
    return killed;
  }
  const near = [
    t('timeline.deaths.enemies', { count: enemiesNear }),
    t('timeline.deaths.allies', { count: alliesNear }),
  ];
  return `${killed}${SEPARATOR}${near.join(NEAR_SEPARATOR)}`;
}

/**
 * The label of the verdict of a death.
 *
 * @param verdict - The verdict.
 * @param t - Translation function.
 * @returns The chip with the word, and the ▼ shape for an avoidable death; nothing for a death by
 *   the world, which is neither.
 */
function renderVerdict(verdict: TimelineDeath['verdict'], t: TFunction) {
  switch (verdict) {
    case 'avoidable':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${AVOIDABLE_STYLE.text} ${AVOIDABLE_STYLE.tint}`}
        >
          <span aria-hidden="true">{AVOIDABLE_STYLE.arrow}</span>
          <span>{t('timeline.deaths.avoidable')}</span>
        </span>
      );
    case 'balanced':
      return (
        <span className="rounded-md bg-fg-muted/10 px-2 py-0.5 text-xs font-semibold text-fg-muted">
          {t('timeline.deaths.balanced')}
        </span>
      );
    case null:
      return null;
  }
}

/**
 * The sentence under the list: what the players near are read from, or why they are not shown.
 *
 * @param positions - Whether the players near each death are known.
 * @param t - Translation function.
 * @returns The estimate when the positions are known; otherwise the sentence that says they are
 *   missing, followed by the download to come when one is planned (its pronoun stands for the
 *   archive of the sentence before it).
 */
function renderPositionsNote(positions: TimelinePositions, t: TFunction) {
  switch (positions) {
    case 'known':
      return t('timeline.deaths.estimate');
    case 'missing':
      return t('timeline.deaths.noPositions');
    case 'missing_refresh_scheduled':
      return `${t('timeline.deaths.noPositions')} ${t('timeline.deaths.refreshScheduled')}`;
  }
}

/**
 * The list of the deaths of the timeline tab.
 *
 * @returns The section of the deaths: its title, then the rows and the sentence under them, or the
 *   sentence that says the detail is incomplete or that there was no death.
 */
export function DeathList({
  deaths,
  avoidableCount,
  positions,
  selected,
  onSelect,
}: DeathListProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const positionsKnown = positions === 'known';

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 id={titleId} className="text-base font-semibold">
        {titleOf(deaths, avoidableCount, t)}
      </h2>
      {deaths === null ? (
        <p className="text-sm text-fg-muted">{t('timeline.deaths.incomplete')}</p>
      ) : deaths.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('timeline.deaths.none')}</p>
      ) : (
        <>
          <ul className="space-y-1 rounded-xl border border-border bg-surface p-1">
            {deaths.map((death, index) => {
              const pressed = index === selected;
              return (
                // Two deaths are never at the same time in the archive, but the index keeps the
                // key unique.
                <li key={`${String(death.timeS)}-${String(index)}`}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => {
                      onSelect(pressed ? null : index);
                    }}
                    className="grid w-full grid-cols-[3.5rem_1fr_auto] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-raised aria-pressed:bg-surface-raised aria-pressed:ring-1 aria-pressed:ring-accent-bright"
                  >
                    <span className="font-semibold tabular-nums">
                      {formatGameTime(death.timeS)}
                    </span>
                    <span>{sentenceOf(death, positionsKnown, t, i18n.language)}</span>
                    {positionsKnown ? renderVerdict(death.verdict, t) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-fg-muted">{renderPositionsNote(positions, t)}</p>
        </>
      )}
    </section>
  );
}
