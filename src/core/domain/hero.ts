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
