/**
 * The header of a match page: what the match history says of the match, in one wrapping line under
 * the title of the page. It is given to the title block of the page as its content, which leaves the
 * space below: the line has no margin of its own, so it is not closer to the tabs than to the title it
 * describes.
 *
 * It reads the stored row of the match (the hero, the date, the type, the result, the duration, the
 * K/D/A and the souls), not its archive, so it is the same for an archived match and for any other:
 * a match the app does not archive (Street Brawl, a custom game, another hero) still says what it
 * was, above the sentence that says why it has no detail.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import type { HeroAsset } from '../../../core/domain/hero';
import { matchTypeOf } from '../../../core/domain/match-type';
import type { MatchListItem } from '../../../services/matches.service';
import { GamePicture } from '../../components/GamePicture';
import { formatMediumDateTime, MS_PER_SECOND } from '../../format/date';
import { formatDuration } from '../../format/duration';
import { formatMetricValue } from './analysis-format';

/** Props of {@link MatchHeader}. */
export interface MatchHeaderProps {
  /** The match, as the history lists it. */
  readonly match: MatchListItem;
  /**
   * The hero the player played, from the hero catalogue; `undefined` while the catalogue is not
   * there or when it does not know the hero (the header then names the hero by its id).
   */
  readonly hero: HeroAsset | undefined;
}

/**
 * A figure of the header with its label, e.g. "Duration 34:30": a bare number would say nothing.
 *
 * @param label - What the figure is.
 * @param value - The figure, already written.
 * @returns The item of the header.
 */
function renderFigure(label: string, value: string) {
  return (
    <li>
      <span className="text-fg-muted">{label}</span> <span className="tabular-nums">{value}</span>
    </li>
  );
}

/**
 * Header of a match page.
 *
 * @returns The facts of the match, in a wrapping line.
 */
export function MatchHeader({ match, hero }: MatchHeaderProps) {
  const { t, i18n } = useTranslation();
  // The machine-readable form of the start, for the `dateTime` of the `<time>` element.
  const startedAtIso = new Date(match.startTime * MS_PER_SECOND).toISOString();
  // `null` for a pair of modes the app does not know: nothing is shown rather than a wrong label.
  const matchType = matchTypeOf(match);

  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      {/*
        The item is as high as the portrait (`min-h-6`) even before the portrait is there, or when
        the hero has none: a catalogue that arrives late (a first launch downloads it) then does not
        make the line grow.
      */}
      <li className="flex min-h-6 items-center gap-2 font-medium">
        {/*
          A hero with no portrait (or none the app may load), or whose portrait cannot be loaded
          (offline, say), is shown by its name alone. The picture has its 24 px box before the file
          arrives, but not before the catalogue does: `min-h-6` above covers that.
        */}
        <GamePicture src={hero?.imageUrl ?? null} size="small" fit="cover" fallback="none" />
        {/* The English name of the catalogue, whatever the language of the interface. */}
        <span>{hero?.name ?? t('matches.table.unknownHero', { id: match.heroId })}</span>
      </li>
      <li>
        <time dateTime={startedAtIso}>{formatMediumDateTime(match.startTime, i18n.language)}</time>
      </li>
      {matchType !== null && <li>{t(`matchType.${matchType}`)}</li>}
      {/* Written like the result column of the match list: the word, and a colour. */}
      <li className={match.won ? 'text-win' : 'text-loss'}>
        {match.won ? t('matches.table.win') : t('matches.table.loss')}
      </li>
      {renderFigure(t('matchDetail.header.duration'), formatDuration(match.durationS))}
      {/* Written like the K / D / A column of the match list. */}
      {renderFigure(
        t('matchDetail.header.kda'),
        `${String(match.kills)} / ${String(match.deaths)} / ${String(match.assists)}`,
      )}
      {/* Written like the souls column of the players tab: one rule for one figure. */}
      {renderFigure(
        t('matchDetail.header.souls'),
        formatMetricValue(match.netWorth, 'amount', i18n.language),
      )}
    </ul>
  );
}
