/**
 * The look of the two teams inside the match replay.
 *
 * The replay colours a team by its game identity (Hidden King or Archmother), never by ally or
 * enemy. Tailwind only generates a utility whose full class name appears in the source, so every
 * class below is written out literally and never built by concatenation.
 *
 * @packageDocumentation
 */

import type { GameIconId } from '../../../../core/match-map/game-icons';
import type { MapLaneId } from '../../../../core/match-map/map-objectives';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';

/** The text colour class of each team. */
export const TEAM_TEXT: Readonly<Record<TeamIdentity, string>> = {
  hidden_king: 'text-team-hidden-king',
  archmother: 'text-team-archmother',
};

/** The fill class of each team, for HTML boxes (`bg-`) and SVG shapes (`fill-`) alike. */
export const TEAM_FILL: Readonly<Record<TeamIdentity, string>> = {
  hidden_king: 'bg-team-hidden-king fill-team-hidden-king',
  archmother: 'bg-team-archmother fill-team-archmother',
};

/** The stroke class of each team, for SVG outlines and rings. */
export const TEAM_STROKE: Readonly<Record<TeamIdentity, string>> = {
  hidden_king: 'stroke-team-hidden-king',
  archmother: 'stroke-team-archmother',
};

/** The game icon of each team's Patron. */
export const TEAM_LOGO: Readonly<Record<TeamIdentity, GameIconId>> = {
  hidden_king: 'patron_hidden_king',
  archmother: 'patron_archmother',
};

/**
 * The zip-line colour of each lane in the map asset: yellow for lane 1, blue for lane 3, green for
 * lane 4. Keyed by lane id because the order of the map's lanes follows their first point, not
 * their number, so a colour must never be derived from that order.
 */
export const LANE_COLOR: Readonly<Record<MapLaneId, string>> = {
  1: '#F1CC30',
  3: '#29b1cc',
  4: '#59b247',
};
