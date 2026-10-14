/**
 * Validation and mapping of deadlock-api's hero catalogue (`GET /v1/assets/heroes`).
 *
 * The response describes each hero in depth (about 1.4 MB for 42 heroes); the app keeps only the
 * id and the English name of the heroes a player can pick.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { Hero } from '../domain/hero';
import { AppError } from '../errors/app-error';

/** One hero of the catalogue, as deadlock-api returns it (only the fields the app uses). */
const catalogueHeroSchema = z.object({
  id: z.int().positive(),
  name: z.string().trim().min(1),
  // Flags of the game data; an absent flag never hides a hero.
  player_selectable: z.boolean().optional(),
  disabled: z.boolean().optional(),
  in_development: z.boolean().optional(),
});

/** One validated hero of the catalogue. */
type CatalogueHero = z.infer<typeof catalogueHeroSchema>;

/**
 * Tell whether players can pick a hero. `only_active=true` already leaves out most other heroes,
 * but not all of them: on 2026-10-14 the response still contained a hero `in_development`.
 *
 * @param hero - A validated hero of the catalogue.
 * @returns `true` for a playable hero.
 */
function isPlayable(hero: CatalogueHero): boolean {
  return hero.player_selectable !== false && hero.disabled !== true && hero.in_development !== true;
}

/**
 * Validate the hero catalogue and keep its playable heroes.
 *
 * The catalogue only names heroes on screen, so a malformed entry is skipped instead of failing
 * the whole catalogue: its hero is then shown by its id.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The playable heroes, sorted by id.
 * @throws AppError of kind `invalid_payload` when the body is not an array or holds no valid hero.
 */
export function parseHeroes(body: unknown): Hero[] {
  if (!Array.isArray(body)) {
    throw new AppError('invalid_payload', 'The hero catalogue is not an array', {
      context: { endpoint: '/v1/assets/heroes' },
    });
  }
  const heroes = body.flatMap((entry): Hero[] => {
    const parsed = catalogueHeroSchema.safeParse(entry);
    return parsed.success && isPlayable(parsed.data)
      ? [{ id: parsed.data.id, name: parsed.data.name }]
      : [];
  });
  if (heroes.length === 0) {
    throw new AppError('invalid_payload', 'The hero catalogue holds no playable hero', {
      context: { entries: body.length },
    });
  }
  return heroes.toSorted((first, second) => first.id - second.id);
}
