import { describe, expect, it } from 'vitest';

import { TEAM_IDENTITY_BY_API_TEAM, teamIdentityOf } from './team-identity';

describe('teamIdentityOf', () => {
  it('maps team 0 to the Hidden King, team 1 to the Archmother, anything else to null', () => {
    expect(teamIdentityOf(0)).toBe('hidden_king');
    expect(teamIdentityOf(1)).toBe('archmother');
    for (const other of [2, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(teamIdentityOf(other)).toBeNull();
    }
  });

  it('agrees with the constant table', () => {
    expect(TEAM_IDENTITY_BY_API_TEAM).toEqual({ 0: 'hidden_king', 1: 'archmother' });
  });
});
