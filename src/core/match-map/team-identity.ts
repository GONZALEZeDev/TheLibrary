/**
 * The two teams of a Deadlock match by their in-game identity: the Hidden King and the Archmother.
 *
 * The match replay colours everything by this identity (never by ally or enemy), so the same team
 * keeps the same colour whichever side the owner played on.
 *
 * @packageDocumentation
 */

/** The in-game identity of a team: the Hidden King or the Archmother. */
export type TeamIdentity = 'hidden_king' | 'archmother';

/**
 * Which identity each API team number stands for.
 *
 * The match data does not name the teams. This mapping is the current belief (team 0's base is at
 * the bottom of the minimap), to be confirmed by the owner in the app. If it turns out to be the
 * other way round, flipping it is this one constant.
 */
export const TEAM_IDENTITY_BY_API_TEAM: Readonly<Record<0 | 1, TeamIdentity>> = {
  0: 'hidden_king',
  1: 'archmother',
};

/**
 * Look up the identity of a team number.
 *
 * @param team - The team number as the API reports it.
 * @returns The identity of team 0 or 1, and `null` for anything else (NaN, 2, -1, 0.5...).
 */
export function teamIdentityOf(team: number): TeamIdentity | null {
  // Only the exact integers 0 and 1 name a team; everything else is unknown.
  if (team === 0 || team === 1) {
    return TEAM_IDENTITY_BY_API_TEAM[team];
  }
  return null;
}
