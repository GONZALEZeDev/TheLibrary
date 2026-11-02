/**
 * Tests of the stat panels of the hero page, against Paige's numbers on deadlock.wiki.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_PAIGE_HERO,
  FIXTURE_PAIGE_WEAPON,
} from '../../adapters/dev/fixtures/paige.fixture';
import { parseHeroDetail, type HeroDetail } from '../deadlock-api/hero-detail.schema';
import { parseWeaponDetail } from '../deadlock-api/item-detail.schema';
import { buildStatPanels, type StatRow } from './stat-panels';

const PAIGE = parseHeroDetail(FIXTURE_PAIGE_HERO.english);
const WEAPON = parseWeaponDetail(FIXTURE_PAIGE_WEAPON);

/** The row of a key in a list of rows; fails the test when it is missing. */
function row(rows: readonly StatRow[], key: StatRow['key']): StatRow {
  const found = rows.find((candidate) => candidate.key === key);
  if (found === undefined) {
    throw new Error(`No ${key} row`);
  }
  return found;
}

describe('buildStatPanels', () => {
  it('lists the weapon rows in the order of the wiki, named after the weapon', () => {
    const { weapon } = buildStatPanels(PAIGE, WEAPON);

    expect(weapon.name).toBe("Chapter's End");
    expect(weapon.imageUrl).toMatch(/bookworm_gun\.webp$/);
    expect(weapon.rows.map((stat) => stat.key)).toEqual([
      'dps',
      'bulletDamage',
      'ammo',
      'bulletsPerSecond',
      'reloadTime',
      'bulletVelocity',
      'lightMelee',
      'heavyMelee',
    ]);
  });

  it('derives the weapon numbers the wiki shows', () => {
    const rows = buildStatPanels(PAIGE, WEAPON).weapon.rows;

    expect(row(rows, 'dps')).toMatchObject({ value: 64, unit: null, perLevel: null });
    expect(row(rows, 'bulletDamage')).toMatchObject({ value: 32, perLevel: 0.61 });
    expect(row(rows, 'ammo').value).toBe(14);
    expect(row(rows, 'bulletsPerSecond').value).toBe(2);
    expect(row(rows, 'reloadTime')).toMatchObject({ value: 2.5, unit: 'seconds' });
    expect(row(rows, 'bulletVelocity').value).toBeCloseTo(43.43, 2);
    expect(row(rows, 'bulletVelocity').unit).toBe('metresPerSecond');
    expect(row(rows, 'lightMelee')).toMatchObject({ value: 42, perLevel: 1.2 });
    const heavyMelee = row(rows, 'heavyMelee');
    expect(heavyMelee.value).toBe(120);
    expect(heavyMelee.perLevel).toBeCloseTo(3.43, 2);
    expect(heavyMelee.spiritScale).toBe(0.45);
  });

  it('derives the vitality numbers the wiki shows', () => {
    const { vitality } = buildStatPanels(PAIGE, WEAPON);

    expect(vitality.map((stat) => stat.key)).toEqual([
      'health',
      'healthRegen',
      'moveSpeed',
      'sprintSpeed',
      'dashSpeed',
      'stamina',
      'staminaCooldown',
    ]);
    expect(row(vitality, 'health')).toMatchObject({ value: 680, perLevel: 31 });
    expect(row(vitality, 'healthRegen').value).toBe(2);
    expect(row(vitality, 'moveSpeed')).toMatchObject({ value: 6.9, unit: 'metresPerSecond' });
    expect(row(vitality, 'sprintSpeed').value).toBe(3.5);
    expect(row(vitality, 'dashSpeed').value).toBeCloseTo(13.89, 2);
    expect(row(vitality, 'stamina').value).toBe(3);
    expect(row(vitality, 'staminaCooldown').value).toBeCloseTo(4.5, 2);
    expect(row(vitality, 'staminaCooldown').unit).toBe('seconds');
  });

  it('shows the spirit power from 0 with its gain per level', () => {
    expect(buildStatPanels(PAIGE, WEAPON).spirit).toEqual([
      { key: 'spiritPower', value: 0, unit: null, perLevel: 1.1, spiritScale: null },
    ]);
  });

  it('leaves out a row whose stat is missing rather than showing 0', () => {
    const startingStats = Object.fromEntries(
      Object.entries(PAIGE.startingStats).filter(([stat]) => stat !== 'sprint_speed'),
    );
    const hero: HeroDetail = { ...PAIGE, startingStats };

    const { vitality } = buildStatPanels(hero, WEAPON);

    expect(vitality.map((stat) => stat.key)).not.toContain('sprintSpeed');
  });
});
