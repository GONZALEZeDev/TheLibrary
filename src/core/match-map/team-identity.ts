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
 * The match data does not name the teams. Team 0's base is at the bottom of the minimap, and that
 * base is the Hidden King's, as checked against real matches in the game. If a patch ever swaps
 * them, flipping this one constant fixes the whole replay.
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
