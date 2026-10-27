/**
 * The points of the review on the dashboard: the first weaknesses and the first strengths of the
 * player's last matches, side by side on a wide window and stacked on a narrow one.
 *
 * Each point is a link to the tab of the review that lists it, written like the summary tab writes
 * it: its name, after the arrow of its side. The arrow is for the eyes and a hidden word says the
 * side, so the colour never says it alone. The review is read from the local database, so the points
 * come in a blink; while they do, and when there is no review, the block says so in one line. The
 * rest of the dashboard never waits for it.
 *
 * @packageDocumentation
 */
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Review, ReviewRow } from '../../../services/review-view';
import { Panel } from '../../components/Panel';
import { StatusLine } from '../../components/StatusLine';
import { INSIGHT_STYLE } from '../match-detail/analysis-format';
import { reviewLabel, reviewRowKey, reviewTabOf } from '../review/review-format';
import { REVIEW_LINK, REVIEW_SECTION_TITLE } from '../review/review-layout';
import { useReviewWithCommunity } from '../review/use-review';

/** How many points of each side the dashboard lists: the first ones, which are the most often flagged. */
const POINTS_PER_SIDE = 3;

/**
 * The two blocks, in the order they are shown: the side of the summary each lists, the part of the
 * summary it reads, its title, and the sentence that says nothing recurs.
 */
const BLOCKS = [
  {
    side: 'weakness',
    points: 'weaknesses',
    title: 'review.summary.weaknesses',
    none: 'review.summary.noWeakness',
  },
  {
    side: 'strength',
    points: 'strengths',
    title: 'review.summary.strengths',
    none: 'review.summary.noStrength',
  },
] as const satisfies readonly {
  readonly side: keyof typeof INSIGHT_STYLE;
  readonly points: keyof Review['summary'];
  readonly title: string;
  readonly none: string;
}[];

/** The side of a block. */
type BlockSide = (typeof BLOCKS)[number]['side'];

/** Props of {@link Point}. */
interface PointProps {
  /** The point of the review. */
  readonly row: ReviewRow;
  /** The side of the summary the point is on. */
  readonly side: BlockSide;
}

/**
 * One point of a block.
 *
 * @returns The item: the arrow of the side, then the name of the point as a link to its tab, followed
 *   by the hidden word of the side.
 */
function Point({ row, side }: PointProps) {
  const { t, i18n } = useTranslation();
  const mark = INSIGHT_STYLE[side];

  return (
    <li className="flex gap-2 text-sm">
      <span aria-hidden="true" className={mark.text}>
        {mark.arrow}
      </span>
      {/* No `replace`: the dashboard and the review are two entries of the history, and going back
          from the review comes back to the dashboard. */}
      <Link to="/review" search={{ tab: reviewTabOf(row.subject) }} className={REVIEW_LINK}>
        {reviewLabel(row.subject, t, i18n.language)}{' '}
        <span className="sr-only">{t(`analysis.flag.${side}`)}</span>
      </Link>
    </li>
  );
}

/** Props of {@link Blocks}. */
interface BlocksProps {
  /** The summary of the review. */
  readonly summary: Review['summary'];
}

/**
 * The two blocks of points of a review.
 *
 * @returns The weaknesses and the strengths, the first points of each.
 */
function Blocks({ summary }: BlocksProps) {
  const { t } = useTranslation();
  const idPrefix = useId();

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {BLOCKS.map((block) => {
        const rows = summary[block.points].slice(0, POINTS_PER_SIDE);
        const headingId = `${idPrefix}-${block.side}`;
        return (
          <Panel key={block.side} aria-labelledby={headingId} padding="normal">
            <h2 id={headingId} className={REVIEW_SECTION_TITLE}>
              {t(block.title)}
            </h2>
            {rows.length === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">{t(block.none)}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {rows.map((row) => (
                  // The key names the point and nothing a language writes, as the review's own lists do.
                  <Point key={reviewRowKey(row.subject)} row={row} side={block.side} />
                ))}
              </ul>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

/**
 * The points of the review.
 *
 * @returns The two blocks of points, a line while the review is read or when it cannot be, the
 *   sentence of an empty review, or nothing when no account is linked.
 */
export function DashboardPoints() {
  const { t } = useTranslation();
  const { review } = useReviewWithCommunity();
  const view = review.data;

  if (view === undefined) {
    return review.isError ? (
      <StatusLine kind="error" error={review.error} />
    ) : (
      <StatusLine kind="loading" text={t('dashboard.points.loading')} />
    );
  }
  if (view.kind === 'ready') {
    return <Blocks summary={view.review.summary} />;
  }
  if (view.kind === 'empty') {
    return (
      <Panel padding="normal" className="text-sm">
        <p>{t('review.empty')}</p>
      </Panel>
    );
  }
  // No account: the page around invites to link one, and has nothing to say of a review.
  return null;
}
