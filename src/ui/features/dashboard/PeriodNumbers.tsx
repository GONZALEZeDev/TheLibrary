/**
 * The numbers of the dashboard for one hero over one period: how many matches were played, how many
 * were won, the win rate and the average kills, deaths and assists, each in a tile.
 *
 * The numbers come from the stored matches of the normal game, unranked or ranked, and follow the
 * synchronisation: they are read again whenever the matches change. A period without a match says
 * so instead of showing a row of zeros, since the averages of nothing are undefined.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeroId } from '../../../core/domain/hero';
import { PERIOD_DAYS, type Period } from '../../../core/domain/period';
import type { PeriodStats } from '../../../core/domain/period-stats';
import { toAppError } from '../../../core/errors/app-error';
import { useHeroNames, usePeriodSummary } from '../matches/use-matches';

/** Props of {@link PeriodNumbers}. */
export interface PeriodNumbersProps {
  /** The period to sum up: a rolling window that ends now. */
  readonly period: Period;
  /** The hero whose matches are counted. */
  readonly heroId: HeroId;
}

/** A tile: what is measured, and its value as the player reads it. */
interface Tile {
  /** Identifies the tile among its siblings. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * Write the numbers of a period as tiles, in the language of the interface.
 *
 * @param stats - The numbers of the period.
 * @param t - Translation function.
 * @param language - The language of the interface, which decides how a number is written (the
 *   decimal separator, the space before a percent sign…).
 * @returns The tiles, in reading order.
 */
function buildTiles(stats: PeriodStats, t: TFunction, language: string): Tile[] {
  const count = new Intl.NumberFormat(language);
  const percent = new Intl.NumberFormat(language, { style: 'percent' });
  // One decimal for each average, always: "7.0", not "7", so that a whole average still reads as one.
  const average = new Intl.NumberFormat(language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return [
    { key: 'matches', label: t('dashboard.stats.matches'), value: count.format(stats.matches) },
    { key: 'wins', label: t('dashboard.stats.wins'), value: count.format(stats.wins) },
    { key: 'winRate', label: t('dashboard.stats.winRate'), value: percent.format(stats.winRate) },
    {
      key: 'kda',
      label: t('dashboard.stats.kda'),
      // Written like the K / D / A column of the match list.
      value: [stats.averageKills, stats.averageDeaths, stats.averageAssists]
        .map((value) => average.format(value))
        .join(' / '),
    },
  ];
}

/**
 * The part of the block that depends on the numbers, depending on what is known.
 *
 * @param summary - State of the query of the numbers.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The loading message, the error, the sentence of an empty period, or the tiles.
 */
function renderSummary(
  summary: ReturnType<typeof usePeriodSummary>,
  t: TFunction,
  language: string,
) {
  if (summary.isPending) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        {t('dashboard.loading')}
      </p>
    );
  }
  // A failed refresh keeps the numbers already shown: the error only replaces an empty block.
  if (summary.data === undefined) {
    return (
      <p role="alert" className="text-sm text-loss">
        {t(`errors.kind.${toAppError(summary.error).kind}`)}
      </p>
    );
  }
  const { data } = summary;
  if (data.kind === 'no_account') {
    // Seen for a moment at most, while the account is unlinked: the page shows its invitation as
    // soon as it knows the account is gone, and this block is not part of it.
    return null;
  }
  if (data.kind === 'empty') {
    return <p className="text-sm text-fg-muted">{t('dashboard.stats.empty')}</p>;
  }
  return (
    // The tiles wrap onto several rows when the window is narrow.
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4">
      {buildTiles(data.stats, t, language).map((tile) => (
        <div key={tile.key} className="rounded-xl border border-border bg-surface p-4">
          <dt className="text-sm text-fg-muted">{tile.label}</dt>
          <dd className="mt-2 text-2xl font-semibold tabular-nums">{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The numbers of one hero over one period.
 *
 * @returns The block: its title (the hero and the length of the period), the rule of what is
 *   counted, and the tiles.
 */
export function PeriodNumbers({ period, heroId }: PeriodNumbersProps) {
  const { t, i18n } = useTranslation();
  const summary = usePeriodSummary(period, heroId);
  // The catalogue is needed as soon as the block is shown: it names the hero of the title.
  const heroNames = useHeroNames(true);
  const titleId = useId();
  // Like the match list, the title falls back to the hero's id while the names are unknown.
  const heroName = heroNames.data?.get(heroId) ?? t('matches.table.unknownHero', { id: heroId });

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId} className="text-lg font-medium">
        {t('dashboard.stats.title', { hero: heroName, days: PERIOD_DAYS[period] })}
      </h2>
      <p className="mt-1 mb-4 text-sm text-fg-muted">{t('dashboard.stats.scope')}</p>
      {renderSummary(summary, t, i18n.language)}
    </section>
  );
}
