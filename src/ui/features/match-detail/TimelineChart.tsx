/**
 * The chart of the timeline tab of the match page: the souls of the player over the match against
 * their lane opponents, on the bands of the phases, with a row of markers under the lines for their
 * deaths, their kills and their purchases.
 *
 * The chart is a picture for the eye, drawn by hand in SVG in a fixed frame that stretches to the
 * width of the page (see `timeline-chart-geometry`). For assistive technologies it is one image
 * named by its title: the list of the deaths under it is the path to each death, by the keyboard as
 * well. Each marker carries a title the pointer shows over it ("Death · 5:41 · Haze"). An avoidable
 * death is a cross inside a ring, so that its colour never tells it alone, and the legend under the
 * chart names every line and marker it draws. Colours are the theme's tokens.
 *
 * The death the list picks is drawn larger on the chart, and the pointer over the marker of a death
 * picks it in the list.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TimelineTabView } from '../../../services/match-timeline-view';
import { formatGameTime } from './analysis-format';
import { killerName } from './DeathList';
import {
  CHART_FRAME,
  CHART_TEXT_SIZE,
  chartScales,
  LINE_WIDTH,
  MARKER_SHAPES,
  markerTransform,
  MIN_NAMED_BAND_WIDTH,
  OPPONENT_DASHES,
  polylinePoints,
  type ChartScales,
} from './timeline-chart-geometry';

/** The timeline of a match. */
type Timeline = Extract<TimelineTabView, { kind: 'timeline' }>;

/** Props of {@link TimelineChart}. */
export interface TimelineChartProps {
  /** The timeline of the match. */
  readonly view: Timeline;
  /** The death picked in the list, an index into `view.deaths`; `null` when none is. */
  readonly selectedDeath: number | null;
  /**
   * Pick a death: the pointer came over its marker.
   *
   * @param index - The index of the death in `view.deaths`, or `null` for none.
   */
  readonly onSelectDeath: (index: number | null) => void;
}

/** The kinds of marker of the chart, which the legend names as well. */
type MarkerKind = 'death' | 'avoidableDeath' | 'kill' | 'purchase';

/** Between the parts of the title of a marker: "Death · 5:41 · Haze". */
const TITLE_SEPARATOR = ' · ';

/**
 * The shape of a marker, drawn around the point `(0, 0)`.
 *
 * @param kind - The kind of marker.
 * @returns The shape: a cross for a death, inside a ring for an avoidable one, a triangle for a kill
 *   and a dot for a purchase.
 */
function renderShape(kind: MarkerKind) {
  switch (kind) {
    case 'death':
    case 'avoidableDeath':
      return (
        <>
          <path
            d={MARKER_SHAPES.crossPath}
            className="stroke-loss"
            strokeWidth={LINE_WIDTH}
            strokeLinecap="round"
          />
          {kind === 'avoidableDeath' && (
            <circle
              r={MARKER_SHAPES.ringRadius}
              className="fill-none stroke-loss"
              strokeWidth={MARKER_SHAPES.ringWidth}
            />
          )}
        </>
      );
    case 'kill':
      return <polygon points={MARKER_SHAPES.trianglePoints} className="fill-win" />;
    case 'purchase':
      return <circle r={MARKER_SHAPES.dotRadius} className="fill-secondary" />;
  }
}

/**
 * The bands of the phases, one shade every other phase, each named at its top when it is wide
 * enough.
 *
 * @param phases - The phases the match reached.
 * @param scales - The scales of the chart.
 * @param t - Translation function.
 * @returns One band per phase.
 */
function renderPhaseBands(phases: Timeline['phases'], scales: ChartScales, t: TFunction) {
  return phases.map(({ phase, startS, endS }, index) => {
    const bandLeft = scales.x(startS);
    const bandWidth = scales.x(endS) - bandLeft;
    return (
      <g key={phase}>
        <rect
          x={bandLeft}
          y={0}
          width={bandWidth}
          height={CHART_FRAME.bandBottom}
          className={index % 2 === 0 ? 'fill-surface-raised' : 'fill-surface'}
        />
        {bandWidth >= MIN_NAMED_BAND_WIDTH && (
          <text
            x={bandLeft + bandWidth / 2}
            y={CHART_FRAME.phaseNameY}
            textAnchor="middle"
            fontSize={CHART_TEXT_SIZE}
            className="fill-fg-muted"
          >
            {t(`analysis.phase.${phase}`)}
          </text>
        )}
      </g>
    );
  });
}

/**
 * The markers of the deaths, in the row of the deaths.
 *
 * @param deaths - The deaths, or `null` when they are not known (no marker then).
 * @param selectedDeath - The index of the death picked in the list, or `null`.
 * @param onSelectDeath - Pick a death.
 * @param scales - The scales of the chart.
 * @param t - Translation function.
 * @returns One marker per death, with its title; the one picked in the list is drawn larger.
 */
function renderDeaths(
  deaths: Timeline['deaths'],
  selectedDeath: number | null,
  onSelectDeath: (index: number) => void,
  scales: ChartScales,
  t: TFunction,
) {
  const { hitHalfSize } = MARKER_SHAPES;
  return (deaths ?? []).map((death, index) => {
    const kind: MarkerKind = death.verdict === 'avoidable' ? 'avoidableDeath' : 'death';
    const selected = index === selectedDeath;
    const title = [t(`timeline.chart.${kind}`), formatGameTime(death.timeS), killerName(death, t)];
    return (
      <g
        // Two deaths are never at the same time in the archive, but the index keeps the key unique.
        key={`${String(death.timeS)}-${String(index)}`}
        transform={markerTransform(scales.x(death.timeS), CHART_FRAME.deathRowY, selected)}
        data-selected={selected}
        onMouseEnter={() => {
          onSelectDeath(index);
        }}
      >
        <title>{title.join(TITLE_SEPARATOR)}</title>
        <rect
          x={-hitHalfSize}
          y={-hitHalfSize}
          width={hitHalfSize * 2}
          height={hitHalfSize * 2}
          className="fill-transparent"
        />
        {renderShape(kind)}
      </g>
    );
  });
}

/**
 * The markers of the kills or of the purchases, in their row.
 *
 * @param kind - The kind of marker.
 * @param marks - The time of each marker and what its title says after the time: the hero killed,
 *   or the item bought.
 * @param scales - The scales of the chart.
 * @param t - Translation function.
 * @returns One marker per entry, with its title.
 */
function renderMarks(
  kind: 'kill' | 'purchase',
  marks: readonly { readonly timeS: number; readonly detail: string }[],
  scales: ChartScales,
  t: TFunction,
) {
  const rowY = kind === 'kill' ? CHART_FRAME.killRowY : CHART_FRAME.purchaseRowY;
  return marks.map(({ timeS, detail }, index) => {
    const title = [t(`timeline.chart.${kind}`), formatGameTime(timeS), detail];
    return (
      // Two purchases may share a second: the index keeps the key unique.
      <g
        key={`${String(timeS)}-${String(index)}`}
        transform={markerTransform(scales.x(timeS), rowY)}
      >
        <title>{title.join(TITLE_SEPARATOR)}</title>
        {renderShape(kind)}
      </g>
    );
  });
}

/**
 * One entry of the legend: the line or the marker the chart draws, then its name.
 *
 * @param swatch - The line or the shape, drawn around `(0, 0)`.
 * @param label - The name.
 * @returns The entry.
 */
function renderLegendEntry(swatch: ReactNode, label: string) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" viewBox="-10 -10 20 20" className="size-4 overflow-visible">
        {swatch}
      </svg>
      <span>{label}</span>
    </span>
  );
}

/**
 * The legend of the chart, which names only what the chart can draw: no opponent line for a player
 * without lane opponents, no death when the deaths are not known, no avoidable death when the
 * positions are not known, no kill when the kills are not known, and no purchase when the player
 * bought nothing.
 *
 * @param view - The timeline of the match.
 * @param t - Translation function.
 * @returns The legend.
 */
function renderLegend(view: Timeline, t: TFunction) {
  const line = (className: string, dashes?: string) => (
    <line x1={-8} x2={8} className={className} strokeWidth={LINE_WIDTH} strokeDasharray={dashes} />
  );
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
      {renderLegendEntry(line('stroke-accent-bright'), t('timeline.chart.you'))}
      {view.souls.opponents !== null &&
        renderLegendEntry(
          line('stroke-secondary', OPPONENT_DASHES),
          t('timeline.chart.opponent', { count: view.souls.opponentCount }),
        )}
      {view.deaths !== null && renderLegendEntry(renderShape('death'), t('timeline.chart.death'))}
      {/* A death is only told avoidable when the positions are known, which the count says. */}
      {view.deaths !== null &&
        view.avoidableCount !== null &&
        renderLegendEntry(renderShape('avoidableDeath'), t('timeline.chart.avoidableDeath'))}
      {view.kills !== null && renderLegendEntry(renderShape('kill'), t('timeline.chart.kill'))}
      {view.purchases.length > 0 &&
        renderLegendEntry(renderShape('purchase'), t('timeline.chart.purchase'))}
    </div>
  );
}

/**
 * The chart of the timeline tab.
 *
 * @returns The section of the chart: its title, the picture, the legend and, when the kills are not
 *   known, the sentence that says so.
 */
export function TimelineChart({ view, selectedDeath, onSelectDeath }: TimelineChartProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const { you, opponents } = view.souls;
  const scales = chartScales(view.durationS, [you, opponents]);
  const { width, height, left, right, soulsBottom, axisY } = CHART_FRAME;
  const title = t('timeline.chart.title');
  const purchases = view.purchases.map(({ timeS, name }) => ({
    timeS,
    detail: name ?? t('timeline.chart.unknownItem'),
  }));
  // A hero the catalogue does not name is "a hero", as in the list of the deaths.
  const kills = view.kills?.map(({ timeS, victim }) => ({
    timeS,
    detail: victim.name ?? t('timeline.deaths.unknownHero'),
  }));

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 id={titleId} className="text-base font-semibold">
        {title}
      </h2>
      <div className="rounded-xl border border-border bg-surface p-3">
        <svg
          role="img"
          aria-label={title}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          width="100%"
        >
          {renderPhaseBands(view.phases, scales, t)}
          {/* No souls: the bottom of the lines. */}
          <line x1={left} x2={right} y1={soulsBottom} y2={soulsBottom} className="stroke-border" />
          {/* The lane opponents first, so that the line of the player is drawn over theirs. */}
          {opponents !== null && (
            <polyline
              points={polylinePoints(opponents, scales)}
              className="fill-none stroke-secondary"
              strokeWidth={LINE_WIDTH}
              strokeDasharray={OPPONENT_DASHES}
              strokeLinejoin="round"
            />
          )}
          <polyline
            points={polylinePoints(you, scales)}
            className="fill-none stroke-accent-bright"
            strokeWidth={LINE_WIDTH}
            strokeLinejoin="round"
          />
          {/* The row of the markers, each kind on its own line; the deaths last, over the rest. */}
          {renderMarks('purchase', purchases, scales, t)}
          {kills !== undefined && renderMarks('kill', kills, scales, t)}
          {renderDeaths(view.deaths, selectedDeath, onSelectDeath, scales, t)}
          {/* The time axis: the start and the end of the match. */}
          <text x={left} y={axisY} fontSize={CHART_TEXT_SIZE} className="fill-fg-muted">
            {formatGameTime(0)}
          </text>
          <text
            x={right}
            y={axisY}
            textAnchor="end"
            fontSize={CHART_TEXT_SIZE}
            className="fill-fg-muted"
          >
            {formatGameTime(view.durationS)}
          </text>
        </svg>
        {renderLegend(view, t)}
        {view.kills === null && (
          <p className="mt-2 text-xs text-fg-muted">{t('timeline.chart.noKills')}</p>
        )}
      </div>
    </section>
  );
}
