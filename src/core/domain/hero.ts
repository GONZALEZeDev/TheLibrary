/**
 * Heroes.
 *
 * Hero ids are the numeric ids of the game data, as returned by deadlock-api
 * (`GET /v1/assets/heroes`).
 *
 * @packageDocumentation
 */

/** Numeric id of a Deadlock hero. */
export type HeroId = number;

/** Paige (`hero_bookworm`), the hero TheLibrary focuses on. */
export const PAIGE_HERO_ID: HeroId = 67;

/**
 * A playable hero of the catalogue.
 *
 * Its name is the English one whatever the language of the interface: players know the heroes by
 * their English names, and some French translations of the game differ from them (owner's choice).
 */
export interface Hero {
  readonly id: HeroId;
  /** English name, e.g. `Paige`. */
  readonly name: string;
}

/**
 * The fixed abilities of a hero, by class name: what the hero brings into every match, as opposed
 * to the shop items a player buys. A damage source of a match is classified by this loadout, not by
 * the `hero` field of the item catalogue (which cannot tell another hero's ability from a shared
 * innate one).
 *
 * The class names are those of the game data (`citadel_weapon_bookworm_set2`) and match both the
 * item catalogue and the `source_name` of a damage row.
 */
export interface HeroLoadout {
  /** Class name of the primary weapon. */
  readonly weapon: string;
  /** Class name of the melee attack. */
  readonly melee: string;
  /** Class names of the four signature abilities, in slot order: the ultimate is the last one. */
  readonly abilities: readonly string[];
}

/**
 * A playable hero with its look and its loadout, as the hero catalogue describes it.
 *
 * It extends {@link Hero} without changing it: what only needs a name keeps using `Hero`.
 */
export interface HeroAsset extends Hero {
  /** Small portrait on the asset bucket, or `null` when the hero has none (or none the app may load). */
  readonly imageUrl: string | null;
  /** The hero's weapon and abilities, or `null` when the catalogue does not give all of them. */
  readonly loadout: HeroLoadout | null;
}
