/**
 * Validation and mapping of one hero entry of deadlock-api (`GET /v1/assets/heroes/{hero_id}`).
 *
 * The hero page shows a hero the way the game does: its keywords and colour, its pictures, its base
 * stats and what it gains at each level, and its loadout. The entry (about 33 KB) carries much more;
 * this module keeps those fields, in the shape the page and its cache read.
 *
 * Two schemas live here: the one of the answer, lenient where a field only decorates the page, and
 * the one of the kept hero ({@link heroDetailSchema}), which the cache checks again on every read.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { ASSET_IMAGE_ORIGIN, firstAssetImageUrl } from './assets.schema';

/** The endpoint named in the errors and the log lines: a template, never an id. */
const ENDPOINT = '/v1/assets/heroes/{hero_id}';

/** The slots of the four signature abilities in the hero's `items`, in order (the ultimate last). */
const SIGNATURE_SLOTS = ['signature1', 'signature2', 'signature3', 'signature4'] as const;

/**
 * A map the page reads key by key (`images`, `colors`…). A value that is not such a map reads as
 * absent: these fields decorate the page and must not cost the hero its stats.
 */
const looseMapSchema = z.record(z.string(), z.unknown()).optional().catch(undefined);

/** A stat of `starting_stats`: its value, with fields the app does not read. */
const startingStatSchema = z.object({ value: z.number() });

/** A stat scaled by another one (`scaling_stats`): the heavy melee by the spirit power, say. */
const scalingStatSchema = z.object({ scaling_stat: z.string(), scale: z.number() });

/** The hero entry as deadlock-api returns it (only the fields the app uses). */
const heroEntrySchema = z.object({
  id: z.int().positive(),
  name: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).catch([]),
  colors: looseMapSchema,
  images: looseMapSchema,
  starting_stats: z.record(z.string(), z.unknown()),
  standard_level_up_upgrades: z.record(z.string(), z.unknown()),
  scaling_stats: z.record(z.string(), z.unknown()).catch({}),
  items: z.object({
    weapon_primary: z.string().min(1),
    signature1: z.string().min(1),
    signature2: z.string().min(1),
    signature3: z.string().min(1),
    signature4: z.string().min(1),
  }),
  shop_stat_display: z.object({ weapon_stats_display: looseMapSchema }).optional().catch(undefined),
});

/** A picture the page may show: on the asset bucket, the only image origin of a download. */
const imageUrlSchema = z.string().startsWith(ASSET_IMAGE_ORIGIN).nullable();

/**
 * Schema of a kept hero. It is the shape {@link parseHeroDetail} gives, and the cache of the hero
 * page checks it again on every read, so a cached hero whose pictures point elsewhere, say, counts
 * as nothing cached.
 */
export const heroDetailSchema = z.object({
  id: z.int().positive(),
  name: z.string().min(1),
  /** The keywords of the hero, in the language of the answer (Helpful, Protector, Booksmart). */
  tags: z.array(z.string().min(1)),
  /** The reference colour of the hero, e.g. `#258F63`. */
  styleColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  /** The stylised name (an SVG). */
  nameImageUrl: imageUrlSchema,
  /** The backdrop of the hero's selection screen. */
  backgroundImageUrl: imageUrlSchema,
  /** The bust of the hero card. */
  cardImageUrl: imageUrlSchema,
  /** The picture of the weapon. */
  weaponImageUrl: imageUrlSchema,
  /** The base stats by key of `starting_stats` (`max_health`, `sprint_speed`…). */
  startingStats: z.record(z.string(), z.number()),
  /** What each level adds, by modifier (`MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL`…). */
  levelUpgrades: z.record(z.string(), z.number()),
  /** The factor of the spirit power on a stat, by stat (`EHeavyMeleeDamage`: 0.45). */
  spiritScaling: z.record(z.string(), z.number()),
  /** The class name of the weapon. */
  weaponClass: z.string().min(1),
  /** The class names of the four signature abilities, in slot order (the ultimate last). */
  abilityClasses: z.tuple([
    z.string().min(1),
    z.string().min(1),
    z.string().min(1),
    z.string().min(1),
  ]),
});

/** A hero as the hero page reads it. */
export type HeroDetail = z.infer<typeof heroDetailSchema>;

/**
 * Keep the numbers of a map of the answer, by key.
 *
 * @param entries - A map of the answer.
 * @param read - Gives the number of an entry, or `null` when it holds none.
 * @returns The entries that hold a number.
 */
function numbersOf(
  entries: Record<string, unknown>,
  read: (value: unknown) => number | null,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]): [string, number][] => {
      const number = read(value);
      return number === null ? [] : [[key, number]];
    }),
  );
}

/**
 * Validate one hero entry and keep what the hero page shows.
 *
 * A picture is kept only when it points into the asset bucket (WebP first); a colour that is not a
 * hexadecimal one falls back to the app's accent, the reference colour of Paige. A stat that is not
 * a number is left out rather than shown as 0.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The hero.
 * @throws AppError of kind `invalid_payload` when the entry is not a hero with its stats, its weapon
 *   and its four abilities.
 */
export function parseHeroDetail(body: unknown): HeroDetail {
  const parsed = heroEntrySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('invalid_payload', 'The hero entry is not a hero with its loadout', {
      context: { endpoint: ENDPOINT },
    });
  }
  const entry = parsed.data;
  const styleHex = entry.colors?.style_hex;
  const weaponDisplay = entry.shop_stat_display?.weapon_stats_display;
  return heroDetailSchema.parse({
    id: entry.id,
    name: entry.name,
    tags: entry.tags,
    styleColor:
      typeof styleHex === 'string' && /^#[0-9a-f]{6}$/i.test(styleHex) ? styleHex : '#258F63',
    nameImageUrl: firstAssetImageUrl([entry.images?.name_image]),
    backgroundImageUrl: firstAssetImageUrl([
      entry.images?.background_image_webp,
      entry.images?.background_image,
    ]),
    cardImageUrl: firstAssetImageUrl([
      entry.images?.icon_hero_card_webp,
      entry.images?.icon_hero_card,
    ]),
    weaponImageUrl: firstAssetImageUrl([
      weaponDisplay?.weapon_image_webp,
      weaponDisplay?.weapon_image,
    ]),
    startingStats: numbersOf(entry.starting_stats, (value) => {
      const stat = startingStatSchema.safeParse(value);
      return stat.success ? stat.data.value : null;
    }),
    levelUpgrades: numbersOf(entry.standard_level_up_upgrades, (value) =>
      typeof value === 'number' ? value : null,
    ),
    spiritScaling: numbersOf(entry.scaling_stats, (value) => {
      const scaling = scalingStatSchema.safeParse(value);
      return scaling.success && scaling.data.scaling_stat === 'ETechPower'
        ? scaling.data.scale
        : null;
    }),
    weaponClass: entry.items.weapon_primary,
    abilityClasses: SIGNATURE_SLOTS.map((slot) => entry.items[slot]),
  });
}
