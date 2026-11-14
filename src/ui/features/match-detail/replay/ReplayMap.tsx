/**
 * The map of the replay: the minimap picture with the zip lines, the objectives (standing or
 * fallen) and every player as the icon of their hero, at the moment the shared cursor shows.
 *
 * The map is drawn by hand in SVG. Its `viewBox` is told in a fixed frame of {@link MAP_SIZE} units
 * (the relative positions of the data times that size) and follows a {@link MapViewport} held by
 * the component: the wheel zooms towards the pointer, dragging pans, and a button shows the whole
 * map again. Icons, rings, markers and strokes are divided by the zoom, so that they keep their
 * size on the screen and nearby heroes separate instead of overlapping when the player zooms in.
 *
 * The picture and the lanes never change while the cursor moves, so they are a memoised layer of
 * their own; each frame only re-renders the objectives, the trails and the players. For assistive
 * technologies the map is one image named by its title; each icon and marker carries a title the
 * pointer shows over it ("Walker · Archmother"). Everything is coloured by the game's team
 * identity (Hidden King or Archmother), never by ally or enemy, and a team is never told by its
 * colour alone: an enemy player has a dashed ring (an ally a solid one). Objectives are logos in
 * the colour of their team: guardians and walkers are their game icon tinted by a mask, titans,
 * cores and shrines are the glyphs of the tracks, and the mid boss pit carries its own golden
 * icon; an icon that fails to load leaves a drawn shape. A fallen objective is faded and dashed.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { GAME_ICONS, gameIconContentScale } from '../../../../core/match-map/game-icons';
import type { RelativePoint } from '../../../../core/match-map/map-geometry';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import type { ReplayViewObjective, ReplayViewPlayer } from '../../../../services/match-replay-view';
import { Button } from '../../../components/Button';
import {
  FULL_MAP,
  panBy,
  positionBetween,
  trailOf,
  zoomAt,
  type MapViewport,
  type ReplayData,
} from './replay-model';
import { ObjectiveGlyphPath, type GlyphKind } from './ObjectiveGlyphs';
import { TEAM_FILL, TEAM_STROKE } from './team-style';

/** The size of the frame the map is drawn in: the relative units (0 to 1) of the data times it. */
const MAP_SIZE = 1000;

/** The size of a hero icon on the screen, in frame units at zoom 1. */
const ICON_SIZE = 36;

/** The thickness of a ring around an icon, in frame units at zoom 1. */
const RING_WIDTH = 3;

/** How far the outer ring of the tracked player sits outside the ring of the icon, at zoom 1. */
const TRACKED_RING_GAP = 4;

/** The dash and the gap of the ring of an enemy player, in frame units at zoom 1. */
const ENEMY_DASH = 7;
const ENEMY_GAP = 4;

/** How much one notch of the wheel changes the zoom: in when the wheel goes up, out when down. */
const WHEEL_ZOOM_FACTOR = 1.2;

/** How many seconds of path a trail shows. */
const TRAIL_SECONDS = 10;

/** The width of the zip lines on the screen, in pixels. */
const LANE_WIDTH_PX = 3;

/** The width of a trail on the screen, in pixels. */
const TRAIL_WIDTH_PX = 2;

/** Between the parts of the title of an icon or a marker: "Walker · Archmother". */
const TITLE_SEPARATOR = ' · ';

/** The half size of the marker of each kind of objective, in frame units at zoom 1. */
const OBJECTIVE_RADIUS = {
  core: 16,
  titan: 16,
  guardian: 9,
  walker: 11,
  shrine: 8,
  base_guardian: 9,
} as const satisfies Record<ReplayViewObjective['identity']['kind'], number>;

/** The half size of the marker of the mid boss pit, in frame units at zoom 1. */
const MID_BOSS_RADIUS = 14;

/** The API icon of the objectives that are told by one: tinted in the colour of their team. */
const OBJECTIVE_ICON = {
  guardian: GAME_ICONS.guardian,
  base_guardian: GAME_ICONS.guardian,
  walker: GAME_ICONS.walker,
} as const satisfies Partial<Record<ReplayViewObjective['identity']['kind'], string>>;

/** The generic glyph of the objectives that are told by one. */
const OBJECTIVE_GLYPH = {
  titan: 'titan',
  core: 'core',
  shrine: 'shrine',
} as const satisfies Partial<Record<ReplayViewObjective['identity']['kind'], GlyphKind>>;

/** How big the tinted icon or the glyph of an objective is next to its half size. */
const OBJECTIVE_ICON_RATIO = 2.6;

/** The opacity of the tinted icon of a fallen objective. */
const DESTROYED_ICON_OPACITY = 0.45;

/** The extra radius of the background halo behind a standing marker, in frame units at zoom 1. */
const HALO_WIDTH = 2;

/** The dash and the gap of the ring around a fallen icon, in frame units at zoom 1. */
const DESTROYED_DASH = 4;
const DESTROYED_GAP = 3;

/** Props of {@link ReplayMap}. */
export interface ReplayMapProps {
  /** The replay; a `map` of `null` draws nothing (the page says the map is unavailable instead). */
  readonly view: ReplayData;
  /** The moment shown, in seconds since the start of the match; fractional while playing. */
  readonly timeS: number;
  /** Whether each player leaves a trail of their last seconds. */
  readonly showTrails: boolean;
  /** Switch the trails on or off. */
  readonly onToggleTrails: () => void;
}

/**
 * A relative position as the point of the frame.
 *
 * @param point - The relative position, from 0 to 1 on both axes.
 * @returns The same place in frame units.
 */
function frameOf(point: RelativePoint) {
  return { x: point.left * MAP_SIZE, y: point.top * MAP_SIZE };
}

/** Props of {@link Backdrop}. */
interface BackdropProps {
  /** What the map is drawn with. */
  readonly map: NonNullable<ReplayData['map']>;
}

/**
 * The layer that never changes while the cursor moves: the minimap picture and the zip lines in the
 * colours the API gives them. It is memoised so that the cursor does not redraw it.
 *
 * @returns The picture and the lanes.
 */
const Backdrop = memo(function Backdrop({ map }: BackdropProps) {
  return (
    <>
      <image href={map.imageUrl} x={0} y={0} width={MAP_SIZE} height={MAP_SIZE} />
      {map.lanes.map((lane, index) => (
        <polyline
          // The lanes have no id: they come in a fixed order.
          key={index}
          points={lane.points
            .map((point) => `${String(point.left * MAP_SIZE)},${String(point.top * MAP_SIZE)}`)
            .join(' ')}
          fill="none"
          stroke={lane.color}
          strokeWidth={LANE_WIDTH_PX}
          strokeOpacity={0.7}
          strokeLinejoin="round"
          // The width is told in screen pixels, so that the zoom does not thicken the lanes.
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
});

/** Props of {@link ObjectiveMarker}. */
interface ObjectiveMarkerProps {
  /** The objective. */
  readonly objective: ReplayViewObjective;
  /** Whether it still stands at the moment shown. */
  readonly standing: boolean;
  /** The zoom of the map, to keep the marker the same size on the screen. */
  readonly scale: number;
  /** The title the pointer shows over it ("Walker · Archmother"). */
  readonly label: string;
}

/**
 * The marker of one objective, in the colour of its team (never changed by its side): a guardian or
 * a walker is its API icon tinted by a mask, a titan, a core or a shrine is its glyph. A fallen
 * glyph uses its own destroyed state; a fallen icon is faded and surrounded by a dashed ring of its
 * team colour. It is memoised, so only an objective that falls (or a zoom) redraws it; whether its
 * icon failed to load is its own state, and the plain disc of its team takes its place.
 *
 * @returns The marker, or nothing when the objective has no position on the picture.
 */
const ObjectiveMarker = memo(function ObjectiveMarker({
  objective,
  standing,
  scale,
  label,
}: ObjectiveMarkerProps) {
  // Set once the icon failed to load: a drawn disc takes its place.
  const [iconFailed, setIconFailed] = useState(false);
  // One mask per marker: the ids must not collide inside the one SVG.
  const maskId = useId();
  if (objective.position === null) return null;
  const { x, y } = frameOf(objective.position);
  const { kind } = objective.identity;
  const radius = OBJECTIVE_RADIUS[kind] / scale;
  const size = radius * OBJECTIVE_ICON_RATIO;
  const iconUrl =
    kind in OBJECTIVE_ICON ? OBJECTIVE_ICON[kind as keyof typeof OBJECTIVE_ICON] : null;
  const glyph =
    kind in OBJECTIVE_GLYPH ? OBJECTIVE_GLYPH[kind as keyof typeof OBJECTIVE_GLYPH] : null;

  // A thin disc of the background colour behind a standing marker, so the icon reads on the map.
  const halo = (
    <circle data-halo="" r={size / 2 + HALO_WIDTH / scale} className="fill-bg" fillOpacity={0.7} />
  );
  let body;
  if (glyph !== null) {
    body = (
      <ObjectiveGlyphPath
        kind={glyph}
        size={size}
        team={objective.team}
        destroyed={!standing}
        // The titan opens towards its own base (the map edge) and bulges towards the centre: in
        // the bottom half it is a dome opening down, in the top half a cup opening up.
        opensDown={objective.position.top >= 0.5}
      />
    );
    // A standing glyph gets the halo of the map colour, so that it never blends into the picture.
    if (standing)
      body = (
        <>
          {halo}
          {body}
        </>
      );
  } else if (iconUrl === null || iconFailed) {
    // Without an icon (or when it failed to load): a plain disc of the team, dashed once fallen.
    body = (
      <circle
        r={size / 2}
        className={
          standing
            ? `${TEAM_FILL[objective.team]} stroke-bg`
            : `fill-none ${TEAM_STROKE[objective.team]}`
        }
        strokeWidth={standing ? 1 : RING_WIDTH / scale}
        strokeDasharray={
          standing
            ? undefined
            : `${String(DESTROYED_DASH / scale)} ${String(DESTROYED_GAP / scale)}`
        }
      />
    );
  } else {
    body = (
      <>
        <defs>
          {/* The icon as a stencil: only its opaque parts let the team colour through. */}
          <mask id={maskId} style={{ maskType: 'alpha' }}>
            <image
              href={iconUrl}
              x={-size / 2}
              y={-size / 2}
              width={size}
              height={size}
              onError={() => {
                setIconFailed(true);
              }}
            />
          </mask>
        </defs>
        {standing && halo}
        <g opacity={standing ? undefined : DESTROYED_ICON_OPACITY}>
          <rect
            x={-size / 2}
            y={-size / 2}
            width={size}
            height={size}
            mask={`url(#${maskId})`}
            className={TEAM_FILL[objective.team]}
          />
        </g>
        {!standing && (
          <circle
            r={size / 2}
            className={`fill-none ${TEAM_STROKE[objective.team]}`}
            strokeWidth={RING_WIDTH / scale}
            strokeDasharray={`${String(DESTROYED_DASH / scale)} ${String(DESTROYED_GAP / scale)}`}
          />
        )}
      </>
    );
  }

  return (
    <g
      data-state={standing ? 'standing' : 'destroyed'}
      transform={`translate(${String(x)} ${String(y)})`}
    >
      <title>{label}</title>
      {body}
    </g>
  );
});

/** Props of {@link MidBossMarker}. */
interface MidBossMarkerProps {
  /** Where the pit is, in frame units. */
  readonly x: number;
  /** Where the pit is, in frame units. */
  readonly y: number;
  /** The zoom of the map, to keep the marker the same size on the screen. */
  readonly scale: number;
  /** The title the pointer shows over it. */
  readonly label: string;
}

/**
 * The marker of the mid boss pit: its game icon, or a drawn disc when the icon fails to load. It
 * is memoised, so only a zoom redraws it.
 *
 * @returns The marker.
 */
const MidBossMarker = memo(function MidBossMarker({ x, y, scale, label }: MidBossMarkerProps) {
  // Set once the icon failed to load: the drawn disc takes its place.
  const [iconFailed, setIconFailed] = useState(false);
  const radius = MID_BOSS_RADIUS / scale;
  // The picture is mostly transparent margin: it is enlarged around the same centre so that the
  // drawing fills the radius (the fallback disc keeps the plain radius).
  const imageRadius = radius * gameIconContentScale('mid_boss');
  return (
    <g transform={`translate(${String(x)} ${String(y)})`}>
      <title>{label}</title>
      {iconFailed ? (
        <circle
          r={radius}
          className="fill-surface-raised stroke-fg-muted"
          strokeWidth={RING_WIDTH / scale}
        />
      ) : (
        <image
          href={GAME_ICONS.mid_boss}
          x={-imageRadius}
          y={-imageRadius}
          width={imageRadius * 2}
          height={imageRadius * 2}
          onError={() => {
            setIconFailed(true);
          }}
        />
      )}
    </g>
  );
});

/** Props of {@link PlayerIcon}. */
interface PlayerIconProps {
  /** The player. */
  readonly player: ReplayViewPlayer;
  /** Where the player is, in frame units. */
  readonly x: number;
  /** Where the player is, in frame units. */
  readonly y: number;
  /** The zoom of the map. */
  readonly scale: number;
  /** The id of the clip path that rounds the icons. */
  readonly clipId: string;
  /** The title the pointer shows over the icon ("Haze · Hidden King"). */
  readonly label: string;
}

/**
 * One player: the icon of their hero rounded by a circle, inside a ring of their team's colour; the
 * tracked player has a second ring around it. A hero without an icon is a plain disc of the colour
 * of the team.
 *
 * @returns The icon.
 */
function PlayerIcon({ player, x, y, scale, clipId, label }: PlayerIconProps) {
  const size = ICON_SIZE / scale;
  return (
    <g transform={`translate(${String(x)} ${String(y)})`}>
      <title>{label}</title>
      {player.iconUrl === null ? (
        <circle r={size / 2} className={TEAM_FILL[player.team]} />
      ) : (
        <image
          href={player.iconUrl}
          x={-size / 2}
          y={-size / 2}
          width={size}
          height={size}
          clipPath={`url(#${clipId})`}
        />
      )}
      <circle
        r={size / 2}
        className={`fill-none ${TEAM_STROKE[player.team]}`}
        strokeWidth={RING_WIDTH / scale}
        // An enemy ring is dashed, an ally ring solid: the team is not told by its colour alone.
        strokeDasharray={
          player.side === 'enemy'
            ? `${String(ENEMY_DASH / scale)} ${String(ENEMY_GAP / scale)}`
            : undefined
        }
      />
      {player.isTracked && (
        <circle
          r={size / 2 + TRACKED_RING_GAP / scale}
          className="fill-none stroke-fg"
          strokeWidth={RING_WIDTH / scale}
        />
      )}
    </g>
  );
}

/**
 * The title of an icon or a marker: its name, then the game's name of its team.
 *
 * @param name - The name.
 * @param team - The in-game identity of its team.
 * @param t - Translation function.
 * @returns The title ("Haze · Hidden King").
 */
function titleOf(name: string, team: TeamIdentity, t: TFunction): string {
  return [name, t(`replay.teams.${team}`)].join(TITLE_SEPARATOR);
}

/**
 * The map of the replay with its zoom button and its trails switch.
 *
 * @returns The map and the two buttons under it.
 */
export function ReplayMap({ view, timeS, showTrails, onToggleTrails }: ReplayMapProps) {
  const { t } = useTranslation();
  const clipId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState<MapViewport>(FULL_MAP);
  // Where the pointer was at the last move of a drag, in screen pixels; `null` when not dragging.
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const { map } = view;

  // The wheel is attached by hand: React listens to it passively and could not cancel it, so the
  // page would scroll under the map while the player zooms.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      // Where the pointer is in the picture, from 0 to 1 (the middle when nothing is laid out).
      const fractionX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      const fractionY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
      const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      setViewport((current) =>
        zoomAt(
          current,
          {
            left: current.left + fractionX / current.scale,
            top: current.top + fractionY / current.scale,
          },
          factor,
        ),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    // Only the main button drags: a right click must not start a pan.
    if (event.button !== 0) return;
    dragFrom.current = { x: event.clientX, y: event.clientY };
    // Keep the drag when the pointer leaves the picture (jsdom, which the tests run in, has no
    // capture).
    if ('setPointerCapture' in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    // No button down: the release happened elsewhere, so a stuck drag ends here.
    if (event.buttons === 0) {
      dragFrom.current = null;
      return;
    }
    const from = dragFrom.current;
    const rect = event.currentTarget.getBoundingClientRect();
    if (from === null || rect.width <= 0 || rect.height <= 0) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    dragFrom.current = { x: event.clientX, y: event.clientY };
    // The picture follows the pointer: the window moves the other way, by the share of the window
    // the pointer crossed.
    setViewport((current) =>
      panBy(current, -dx / rect.width / current.scale, -dy / rect.height / current.scale),
    );
  }, []);

  const endDrag = useCallback(() => {
    dragFrom.current = null;
  }, []);

  // The icons of the players alive now; the tracked player last, so that they are drawn on top.
  const icons = useMemo(
    () =>
      view.players
        .map((player) => ({ player, point: positionBetween(player.positions, timeS) }))
        .filter((entry) => entry.point !== null)
        .toSorted(
          (first, second) => Number(first.player.isTracked) - Number(second.player.isTracked),
        ),
    [view.players, timeS],
  );

  // The page says the map is unavailable instead of drawing it; this is only a guard.
  if (map === null) return null;

  const { scale } = viewport;
  const boxSize = MAP_SIZE / scale;
  const second = Math.floor(timeS);
  const mapTitle = t('replay.map.title');

  return (
    <div className="space-y-2">
      <svg
        ref={svgRef}
        role="img"
        aria-label={mapTitle}
        viewBox={`${String(viewport.left * MAP_SIZE)} ${String(viewport.top * MAP_SIZE)} ${String(boxSize)} ${String(boxSize)}`}
        width="100%"
        className="aspect-square cursor-grab touch-none select-none rounded-md bg-surface active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <defs>
          {/* One circle for every icon, in bounding-box units so it fits any icon size. */}
          <clipPath id={clipId} clipPathUnits="objectBoundingBox">
            <circle cx={0.5} cy={0.5} r={0.5} />
          </clipPath>
        </defs>
        <Backdrop map={map} />
        {view.objectives.map((objective) => (
          <ObjectiveMarker
            // An objective is told by its team and what it is (a lane or a side tells the rest).
            key={`${objective.side}-${objective.identity.kind}-${String(objective.identity.lane)}-${String(objective.identity.index)}`}
            objective={objective}
            standing={objective.destroyedAtS === null || objective.destroyedAtS > second}
            scale={scale}
            label={titleOf(t(`replay.objective.${objective.identity.kind}`), objective.team, t)}
          />
        ))}
        {/* The mid boss pit, which stands apart from the objectives of the teams. */}
        <MidBossMarker
          x={frameOf(map.midBoss).x}
          y={frameOf(map.midBoss).y}
          scale={scale}
          label={t('replay.schedule.mid_boss')}
        />
        {showTrails &&
          icons.map(({ player }) => {
            const trail = trailOf(player.positions, timeS, TRAIL_SECONDS);
            // A single point draws nothing.
            if (trail.length < 2) return null;
            return (
              <polyline
                key={player.slot}
                data-trail=""
                points={trail
                  .map(
                    (point) => `${String(point.left * MAP_SIZE)},${String(point.top * MAP_SIZE)}`,
                  )
                  .join(' ')}
                className={`fill-none ${TEAM_STROKE[player.team]}`}
                strokeWidth={TRAIL_WIDTH_PX}
                strokeOpacity={0.7}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        {icons.map(({ player, point }) => {
          // `icons` holds only the players with a point; the filter above cannot tell the type.
          if (point === null) return null;
          const { x, y } = frameOf(point);
          return (
            <PlayerIcon
              key={player.slot}
              player={player}
              x={x}
              y={y}
              scale={scale}
              clipId={clipId}
              label={titleOf(player.heroName ?? t('timeline.deaths.unknownHero'), player.team, t)}
            />
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-2">
        <Button
          look="subtle"
          disabled={scale === FULL_MAP.scale}
          onClick={() => {
            setViewport(FULL_MAP);
          }}
        >
          {t('replay.map.resetZoom')}
        </Button>
        <Button look="subtle" aria-pressed={showTrails} onClick={onToggleTrails}>
          {t(showTrails ? 'replay.map.trailsOn' : 'replay.map.trailsOff')}
        </Button>
      </div>
    </div>
  );
}
