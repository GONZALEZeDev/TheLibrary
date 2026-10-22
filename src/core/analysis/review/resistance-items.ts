/**
 * The resistance items of the review: the shop items that protect the player themself against
 * bullet or spirit damage, by class name.
 *
 * The list is fixed, and kept here like the thresholds, because the item catalogue cannot give it:
 * its resistance properties do not tell the player's own protection from the auras for allies, the
 * actives and the small side stats that other items carry. A rule built on those properties would
 * either miss items that protect the player (Metal Skin, Colossus) or pick items that are about
 * something else. So the review does not look for resistance in the catalogue: it takes these
 * twelve items, and only reads their names, images and ids from it.
 *
 * Because the items are named by their class names, a game patch that renames one leaves it without
 * a match in the catalogue. That does not go unnoticed: the API canary catches it, and the review
 * keeps working in the meantime.
 *
 * @packageDocumentation
 */

/** What a resistance item protects the player against. */
export type ResistanceKind = 'bullet' | 'spirit' | 'both';

/** A resistance item of the shop. */
export interface ResistanceItem {
  /**
   * The class name of the item in the item catalogue (`upgrade_weapon_shielding`): the identifier
   * that does not change with the language, so the list is built on it and not on the item's name.
   */
  readonly className: string;
  /** The damage the item protects against. */
  readonly protects: ResistanceKind;
  /** The tier of the item in the shop: 2, 3 or 4. */
  readonly tier: 2 | 3 | 4;
}

/**
 * The twelve resistance items, in tier order and, within a tier, by what they protect against: the
 * bullet items first, then the spirit ones, then those that protect against both. Their names are
 * the ones of the game:
 * - tier 2: Battle Vest, Weapon Shielding, Enchanter's Emblem, Spirit Shielding;
 * - tier 3: Bullet Resilience, Metal Skin, Spirit Resilience, Dispel Magic;
 * - tier 4: Spellbreaker, Witchmail, Indomitable, Colossus.
 *
 * Left out on purpose: the items whose resistance is for allies (Heroic Aura) or builds up while
 * shooting (Escalating Resilience), and those that carry a resistance only as a small side stat.
 */
export const RESISTANCE_ITEMS: readonly ResistanceItem[] = [
  // Tier 2.
  { className: 'upgrade_regenerating_bullet_shield', protects: 'bullet', tier: 2 }, // Battle Vest
  { className: 'upgrade_weapon_shielding', protects: 'bullet', tier: 2 }, // Weapon Shielding
  { className: 'upgrade_magic_shield', protects: 'spirit', tier: 2 }, // Enchanter's Emblem
  { className: 'upgrade_spirit_bubble', protects: 'spirit', tier: 2 }, // Spirit Shielding
  // Tier 3.
  { className: 'upgrade_improved_bullet_armor', protects: 'bullet', tier: 3 }, // Bullet Resilience
  { className: 'upgrade_metal_skin', protects: 'bullet', tier: 3 }, // Metal Skin
  { className: 'upgrade_tech_purge', protects: 'spirit', tier: 3 }, // Spirit Resilience
  { className: 'upgrade_reduce_debuff_duration', protects: 'spirit', tier: 3 }, // Dispel Magic
  // Tier 4.
  { className: 'upgrade_spellbreaker', protects: 'spirit', tier: 4 }, // Spellbreaker
  { className: 'upgrade_absorbing_armor', protects: 'spirit', tier: 4 }, // Witchmail
  { className: 'upgrade_auto_cleanse', protects: 'both', tier: 4 }, // Indomitable
  { className: 'upgrade_colossus', protects: 'both', tier: 4 }, // Colossus
];
