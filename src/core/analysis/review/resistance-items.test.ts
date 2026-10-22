/**
 * Tests of the resistance items of the review: the fixed list of twelve shop items, the order they
 * come in, and what each of them protects against.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { RESISTANCE_ITEMS } from './resistance-items';

describe('RESISTANCE_ITEMS', () => {
  it('lists the 12 resistance items once each, in tier order', () => {
    expect(RESISTANCE_ITEMS.map((item) => item.className)).toEqual([
      // Tier 2.
      'upgrade_regenerating_bullet_shield',
      'upgrade_weapon_shielding',
      'upgrade_magic_shield',
      'upgrade_spirit_bubble',
      // Tier 3.
      'upgrade_improved_bullet_armor',
      'upgrade_metal_skin',
      'upgrade_tech_purge',
      'upgrade_reduce_debuff_duration',
      // Tier 4.
      'upgrade_spellbreaker',
      'upgrade_absorbing_armor',
      'upgrade_auto_cleanse',
      'upgrade_colossus',
    ]);
    expect(new Set(RESISTANCE_ITEMS.map((item) => item.className)).size).toBe(12);
    expect(RESISTANCE_ITEMS.map((item) => item.tier)).toEqual([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
  });

  it('puts the bullet items first in a tier, then the spirit ones, then those for both', () => {
    expect(RESISTANCE_ITEMS.map((item) => item.protects)).toEqual([
      // Tier 2.
      'bullet',
      'bullet',
      'spirit',
      'spirit',
      // Tier 3.
      'bullet',
      'bullet',
      'spirit',
      'spirit',
      // Tier 4.
      'spirit',
      'spirit',
      'both',
      'both',
    ]);
  });

  it('says what each item protects against', () => {
    const protects = Object.fromEntries(
      RESISTANCE_ITEMS.map((item) => [item.className, item.protects]),
    );
    expect(protects).toEqual({
      // Against bullets: Battle Vest, Weapon Shielding, Bullet Resilience, Metal Skin.
      upgrade_regenerating_bullet_shield: 'bullet',
      upgrade_weapon_shielding: 'bullet',
      upgrade_improved_bullet_armor: 'bullet',
      upgrade_metal_skin: 'bullet',
      // Against spirit: Enchanter's Emblem, Spirit Shielding, Spirit Resilience, Dispel Magic,
      // Spellbreaker, Witchmail.
      upgrade_magic_shield: 'spirit',
      upgrade_spirit_bubble: 'spirit',
      upgrade_tech_purge: 'spirit',
      upgrade_reduce_debuff_duration: 'spirit',
      upgrade_spellbreaker: 'spirit',
      upgrade_absorbing_armor: 'spirit',
      // Against both: Indomitable, Colossus.
      upgrade_auto_cleanse: 'both',
      upgrade_colossus: 'both',
    });
  });
});
