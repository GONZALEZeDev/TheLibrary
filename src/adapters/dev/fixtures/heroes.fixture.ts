/**
 * Hero catalogue served by the development HTTP client, in the shape of deadlock-api's
 * `GET /v1/assets/heroes` (reduced to a few of its many fields).
 *
 * Ids, names and class names are those of the game (public game data, 2026-10-14), except the
 * invented "Retired Hero". The last two entries are not playable, like some entries of the real
 * response (Baba was still in development), so that the filter is exercised.
 *
 * @packageDocumentation
 */

/** A hero in the raw shape of the API (subset of the fields). */
export interface RawCatalogueHero {
  readonly id: number;
  readonly class_name: string;
  readonly name: string;
  readonly player_selectable: boolean;
  readonly disabled: boolean;
  readonly in_development: boolean;
  readonly development_state: string;
}

/**
 * Build a playable hero of the catalogue.
 *
 * @param id - Hero id of the game data.
 * @param name - English name.
 * @param className - Internal name of the game data.
 * @returns The raw hero.
 */
function playable(id: number, name: string, className: string): RawCatalogueHero {
  return {
    id,
    class_name: className,
    name,
    player_selectable: true,
    disabled: false,
    in_development: false,
    development_state: 'release',
  };
}

/** The hero catalogue of the fixtures. */
export const FIXTURE_HERO_CATALOGUE: readonly RawCatalogueHero[] = [
  playable(1, 'Infernus', 'hero_inferno'),
  playable(2, 'Seven', 'hero_gigawatt'),
  playable(3, 'Vindicta', 'hero_hornet'),
  playable(4, 'Lady Geist', 'hero_ghost'),
  playable(6, 'Abrams', 'hero_atlas'),
  playable(7, 'Wraith', 'hero_wraith'),
  playable(13, 'Haze', 'hero_haze'),
  playable(15, 'Bebop', 'hero_bebop'),
  playable(20, 'Ivy', 'hero_tengu'),
  playable(35, 'Viscous', 'hero_viscous'),
  playable(67, 'Paige', 'hero_bookworm'),
  { ...playable(88, 'Baba', 'hero_baba'), in_development: true },
  { ...playable(90, 'Retired Hero', 'hero_retired'), disabled: true, player_selectable: false },
];
