/**
 * The stat panels of the hero page: the weapon, the vitality and the spirit of the hero, as the
 * deadlock.wiki infobox shows them.
 *
 * deadlock-api gives the raw numbers of the game; the wiki, the reference of the page, shows some
 * derived ones. This module makes them the wiki's way:
 * - bullets per second: one over the time between two shots (the API's own `shots_per_second`
 *   counts the burst delay too and gives 1.67 for Paige, where the wiki and the game show 2);
 * - DPS: the damage of a bullet times the bullets per second;
 * - bullet velocity: game units per second turned into metres per second;
 * - dash speed: the distance of a ground dash over its duration;
 * - stamina cooldown: the time to regain one stamina point;
 * - heavy melee gain per level: the light melee gain in proportion of the two base damages.
 *
 * @packageDocumentation
 */
import type { HeroDetail } from '../deadlock-api/hero-detail.schema';
import type { WeaponDetail } from '../deadlock-api/item-detail.schema';

/** The game's units in one metre. */
export const GAME_UNITS_PER_METRE = 39.37;

/** A stat of the panels. */
export type StatKey =
  | 'dps'
  | 'bulletDamage'
  | 'ammo'
  | 'bulletsPerSecond'
  | 'reloadTime'
  | 'bulletVelocity'
  | 'lightMelee'
  | 'heavyMelee'
  | 'health'
  | 'healthRegen'
  | 'moveSpeed'
  | 'sprintSpeed'
  | 'dashSpeed'
  | 'stamina'
  | 'staminaCooldown'
  | 'spiritPower';

/** The unit a stat is shown in, or `null` for a bare number. */
export type StatUnit = 'seconds' | 'metres' | 'metresPerSecond' | null;

/** One row of a panel. */
export interface StatRow {
  readonly key: StatKey;
  /** The base value, at level 1 and without items. */
  readonly value: number;
  readonly unit: StatUnit;
  /** What each level adds, or `null` when the stat does not grow with the levels. */
  readonly perLevel: number | null;
  /** The factor of the spirit power on the stat, or `null` when it has none. */
  readonly spiritScale: number | null;
}

/** The three panels of the page. */
export interface StatPanels {
  /** The weapon: its name and picture, and its rows. */
  readonly weapon: {
    readonly name: string;
    readonly imageUrl: string | null;
    readonly rows: readonly StatRow[];
  };
  readonly vitality: readonly StatRow[];
  readonly spirit: readonly StatRow[];
}

/** The modifiers of `standard_level_up_upgrades` the panels read. */
const LEVEL_UPGRADE = {
  bulletDamage: 'MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL',
  health: 'MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL',
  melee: 'MODIFIER_VALUE_BASE_MELEE_DAMAGE_FROM_LEVEL',
  spiritPower: 'MODIFIER_VALUE_TECH_POWER',
} as const;

/**
 * Make a row, or none when its value is unknown.
 *
 * @param key - The stat.
 * @param value - Its base value, or `undefined` when the hero entry lacks it.
 * @param details - What the row shows besides its value.
 * @param details.unit - Its unit; `null` (a bare number) by default.
 * @param details.perLevel - What each level adds, when the stat grows with the levels.
 * @param details.spiritScale - The factor of the spirit power on it, when it has one.
 * @returns A list of one row, or an empty list: a missing stat is left out, never shown as 0.
 */
function rowOf(
  key: StatKey,
  value: number | undefined,
  details: {
    unit?: StatUnit;
    perLevel?: number | undefined;
    spiritScale?: number | undefined;
  } = {},
): StatRow[] {
  if (value === undefined || !Number.isFinite(value)) {
    return [];
  }
  const { unit = null, perLevel, spiritScale } = details;
  return [
    {
      key,
      value,
      unit,
      // A gain of 0 is no gain: the row shows none.
      perLevel: perLevel === undefined || perLevel === 0 ? null : perLevel,
      spiritScale: spiritScale ?? null,
    },
  ];
}

/**
 * Divide, or give `undefined` when either side is missing or the divisor is 0.
 *
 * @param dividend - The number divided.
 * @param divisor - The number it is divided by.
 * @returns The quotient, or `undefined`.
 */
function ratio(dividend: number | undefined, divisor: number | undefined): number | undefined {
  return dividend === undefined || divisor === undefined || divisor === 0
    ? undefined
    : dividend / divisor;
}

/**
 * Build the stat panels of a hero.
 *
 * @param hero - The hero entry.
 * @param weapon - The hero's weapon.
 * @returns The weapon, vitality and spirit rows, in the order of the wiki. A row whose source stat
 *   is missing from the entry is left out.
 */
export function buildStatPanels(hero: HeroDetail, weapon: WeaponDetail): StatPanels {
  const stats = hero.startingStats;
  const upgrades = hero.levelUpgrades;
  const bulletsPerSecond = 1 / weapon.cycleTime;
  const lightMelee = stats.light_melee_damage;
  const heavyMelee = stats.heavy_melee_damage;
  const meleeGain = upgrades[LEVEL_UPGRADE.melee];
  return {
    weapon: {
      name: weapon.name,
      imageUrl: hero.weaponImageUrl,
      rows: [
        ...rowOf('dps', weapon.bulletDamage * bulletsPerSecond),
        ...rowOf('bulletDamage', weapon.bulletDamage, {
          perLevel: upgrades[LEVEL_UPGRADE.bulletDamage],
        }),
        ...rowOf('ammo', weapon.clipSize),
        ...rowOf('bulletsPerSecond', bulletsPerSecond),
        ...rowOf('reloadTime', weapon.reloadDuration, { unit: 'seconds' }),
        ...rowOf('bulletVelocity', weapon.bulletSpeed / GAME_UNITS_PER_METRE, {
          unit: 'metresPerSecond',
        }),
        ...rowOf('lightMelee', lightMelee, { perLevel: meleeGain }),
        ...rowOf('heavyMelee', heavyMelee, {
          // The heavy melee grows in the same proportion as the light one.
          perLevel:
            meleeGain === undefined ? undefined : ratio(meleeGain * (heavyMelee ?? 0), lightMelee),
          spiritScale: hero.spiritScaling.EHeavyMeleeDamage,
        }),
      ],
    },
    vitality: [
      ...rowOf('health', stats.max_health, { perLevel: upgrades[LEVEL_UPGRADE.health] }),
      ...rowOf('healthRegen', stats.base_health_regen),
      ...rowOf('moveSpeed', stats.max_move_speed, { unit: 'metresPerSecond' }),
      ...rowOf('sprintSpeed', stats.sprint_speed, { unit: 'metresPerSecond' }),
      ...rowOf(
        'dashSpeed',
        ratio(stats.ground_dash_distance_in_meters, stats.ground_dash_duration),
        { unit: 'metresPerSecond' },
      ),
      ...rowOf('stamina', stats.stamina),
      ...rowOf('staminaCooldown', ratio(1, stats.stamina_regen_per_second), { unit: 'seconds' }),
    ],
    spirit: rowOf('spiritPower', 0, { perLevel: upgrades[LEVEL_UPGRADE.spiritPower] }),
  };
}
