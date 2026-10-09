/**
 * Hero identifiers.
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
