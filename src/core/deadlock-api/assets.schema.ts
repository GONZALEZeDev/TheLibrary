/**
 * Validation and mapping of deadlock-api's item and rank catalogues (`GET /v1/assets/items` and
 * `GET /v1/assets/ranks`).
 *
 * The item catalogue is the whole game data of the abilities, weapons and shop items (about 6.5 MB
 * with tooltips and properties); the rank catalogue names the twelve tiers and links their badges.
 * The app names and illustrates the damage sources and the final build of a match with them, and
 * keeps only the few fields it shows. Both catalogues are decoration: an entry that cannot be read
 * is skipped, never reported, so one odd entry hides nothing else.
 *
 * Every image link is checked against the asset bucket (see {@link assetImageUrl}): the release
 * Content Security Policy only lets the app load images from there.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';

/**
 * Origin of the asset bucket, with its trailing slash. The release Content Security Policy
 * (`img-src`) only allows images from this origin, so no other image link is ever kept.
 */
export const ASSET_IMAGE_ORIGIN = 'https://assets-bucket.deadlock-api.com/';

/**
 * Keep an image link only when it points into the asset bucket.
 *
 * The trailing slash of {@link ASSET_IMAGE_ORIGIN} makes the prefix check exact: a host that merely
 * starts like the bucket (`assets-bucket.deadlock-api.com.example.net`), or a user-info trick
 * (`assets-bucket.deadlock-api.com@example.net`), does not match.
 *
 * @param value - Anything the payload holds where an image link is expected.
 * @returns The link when it is a string starting with {@link ASSET_IMAGE_ORIGIN}, otherwise `null`.
 */
export function assetImageUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith(ASSET_IMAGE_ORIGIN) ? value : null;
}

/**
 * Pick the first usable image link of a list of candidates.
 *
 * A candidate that is absent, not a string or outside the asset bucket is passed over rather than
 * ending the search, so a foreign link never hides a usable one that comes later in the order.
 *
 * @param candidates - The image fields of an entry, in order of preference.
 * @returns The first candidate {@link assetImageUrl} keeps, or `null` when there is none.
 */
export function firstAssetImageUrl(candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    const url = assetImageUrl(candidate);
    if (url !== null) {
      return url;
    }
  }
  return null;
}

/** The kinds of entries of the item catalogue the app reads, as the API names them in `type`. */
const ITEM_KINDS = ['ability', 'weapon', 'upgrade'] as const;

/**
 * Kind of a catalogue entry: an `ability` (a hero's signature, melee or innate ability), a `weapon`
 * or an `upgrade` (a shop item, which a player buys).
 */
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The slot types of a shop item, as the API names them in `item_slot_type`. */
const ITEM_SLOTS = ['weapon', 'vitality', 'spirit'] as const;

/** Slot of a shop item in the shop and in the inventory: weapon, vitality or spirit. */
export type ItemSlot = (typeof ITEM_SLOTS)[number];

/** Lowest tier of a shop item. */
const MIN_ITEM_TIER = 1;

/** Highest tier of a shop item. */
const MAX_ITEM_TIER = 5;

/**
 * The tier of a shop item, `item_tier`: a whole number from {@link MIN_ITEM_TIER} to
 * {@link MAX_ITEM_TIER}, given as a number or as a numeric string. Anything else, and an absent
 * field, reads as `null` (abilities and weapons have no tier).
 */
const itemTierSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.int().min(MIN_ITEM_TIER).max(MAX_ITEM_TIER))
  .nullable()
  .catch(null);

/**
 * An image field of an entry. It stays `unknown` and optional here, whatever it holds: only
 * {@link firstAssetImageUrl} decides whether it is a link the app may load. (Zod 4 requires the key
 * of a bare `z.unknown()` field, hence the `optional()`.)
 */
const imageFieldSchema = z.unknown().optional();

/**
 * One entry of the item catalogue, as deadlock-api returns it (only the fields the app uses).
 *
 * An entry needs its `id`, its `class_name` and a known `type`, or it is skipped. Every other field
 * is read leniently: one of an unexpected shape, or an absent one, reads as "none" instead of
 * costing the entry.
 */
const itemEntrySchema = z.object({
  id: z.int().positive(),
  class_name: z.string().min(1),
  type: z.enum(ITEM_KINDS),
  name: z.string().trim().catch(''),
  item_slot_type: z.enum(ITEM_SLOTS).nullable().catch(null),
  item_tier: itemTierSchema,
  image: imageFieldSchema,
  image_webp: imageFieldSchema,
  shop_image: imageFieldSchema,
  shop_image_webp: imageFieldSchema,
});

/** One validated entry of the item catalogue. */
type ItemEntry = z.infer<typeof itemEntrySchema>;

/** One ability, weapon or shop item of the catalogue, reduced to what the app shows. */
export interface CatalogueItem {
  /** Numeric id of the game data: the `item_id` of a match's `items[]`, `ability_id` of a stat. */
  readonly id: number;
  /**
   * Class name of the game data, e.g. `upgrade_express_shot`: the `source_name` of a damage row and
   * the key of a hero's loadout.
   */
  readonly className: string;
  /**
   * English display name, or `null` when the catalogue has none: its `name` is empty or repeats the
   * class name (220 of the 781 entries). The caller then falls back to a readable class name.
   */
  readonly name: string | null;
  /** Kind of the entry. */
  readonly kind: ItemKind;
  /** Slot of a shop item; `null` for an ability or a weapon (and for a slot the app does not know). */
  readonly slot: ItemSlot | null;
  /** Tier of a shop item, 1 to 5; `null` for an ability or a weapon. */
  readonly tier: number | null;
  /** Image link on the asset bucket, or `null` when the entry has none (or none the app may load). */
  readonly imageUrl: string | null;
}

/**
 * Pick the image of an entry: the first usable link of the fields its kind carries.
 *
 * Abilities and weapons carry `image_webp` and `image`. A shop item (`upgrade`) is shown by its shop
 * image, the picture of the item in the shop, which every shopable item has; the image of the mod
 * it applies (`image_webp`, `image`) comes last. WebP comes before PNG everywhere: it is smaller.
 *
 * @param entry - A validated entry.
 * @returns The link, or `null`.
 */
function itemImageUrl(entry: ItemEntry): string | null {
  const own = [entry.image_webp, entry.image];
  return firstAssetImageUrl(
    entry.type === 'upgrade' ? [entry.shop_image_webp, entry.shop_image, ...own] : own,
  );
}

/**
 * Reduce a validated entry to the fields the app keeps.
 *
 * @param entry - A validated entry.
 * @returns The catalogue item.
 */
function toCatalogueItem(entry: ItemEntry): CatalogueItem {
  return {
    id: entry.id,
    className: entry.class_name,
    // The name is already trimmed; an empty one, or the class name repeated, is no name.
    name: entry.name === '' || entry.name === entry.class_name ? null : entry.name,
    kind: entry.type,
    slot: entry.item_slot_type,
    tier: entry.item_tier,
    imageUrl: itemImageUrl(entry),
  };
}

/** The body of a catalogue: a list of anything, each entry being validated on its own. */
const catalogueBodySchema = z.array(z.unknown());

/**
 * Read a catalogue entry by entry, skipping the entries that cannot be read.
 *
 * @param body - The parsed JSON body of the response.
 * @param catalogue - What the catalogue is, for the error messages (e.g. `item`).
 * @param readEntry - Read one entry: the value to keep, or `null` for an entry to skip.
 * @returns The values of the entries kept, in the order of the body.
 * @throws AppError of kind `invalid_payload` when the body is not an array (the context `issue` is
 *   `<path>: <code>` of the first problem, never a value of the payload), or when no entry can be
 *   read: the catalogue is then kept for days, and an empty one would leave every name unknown.
 */
function readCatalogue<Value>(
  body: unknown,
  catalogue: string,
  readEntry: (entry: unknown) => Value | null,
): Value[] {
  const entries = catalogueBodySchema.safeParse(body);
  if (!entries.success) {
    throw new AppError('invalid_payload', `The ${catalogue} catalogue is not an array`, {
      context: { issue: describeFirstIssue(entries.error) },
    });
  }
  const values = entries.data.flatMap((entry) => {
    const value = readEntry(entry);
    return value === null ? [] : [value];
  });
  if (values.length === 0) {
    throw new AppError('invalid_payload', `The ${catalogue} catalogue holds no readable entry`, {
      context: { entries: entries.data.length },
    });
  }
  return values;
}

/**
 * Validate the item catalogue and reduce it to the fields the app shows (about 0.3 MB out of
 * 6.5 MB).
 *
 * An entry without a numeric `id` or a `class_name`, or whose `type` is not `ability`, `weapon` or
 * `upgrade`, is skipped.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The readable entries, in the order of the body.
 * @throws AppError of kind `invalid_payload` when the body is not an array or holds no readable
 *   entry.
 */
export function parseItemCatalogue(body: unknown): CatalogueItem[] {
  return readCatalogue(body, 'item', (entry) => {
    const parsed = itemEntrySchema.safeParse(entry);
    return parsed.success ? toCatalogueItem(parsed.data) : null;
  });
}

/**
 * One tier of the rank catalogue, as deadlock-api returns it (only the fields the app uses).
 *
 * `images` holds forty keys per tier; the app reads the tier badge only. The sub-rank images are
 * served by `api.deadlock-api.com`, which the release Content Security Policy does not allow.
 */
const rankEntrySchema = z.object({
  tier: z.int().nonnegative(),
  name: z.string().trim().min(1),
  images: z
    .object({ large_webp: imageFieldSchema, large: imageFieldSchema })
    .optional()
    .catch(undefined),
});

/** One tier of the rank catalogue, reduced to what the app shows. */
export interface CatalogueRank {
  /** Tier number, 0 (Obscurus) to 11 (Eternus): `floor(badge / 10)` of a match badge. */
  readonly tier: number;
  /** English name of the tier, e.g. `Sentinel`. */
  readonly name: string;
  /** Link of the tier badge on the asset bucket, or `null` when the tier has none usable. */
  readonly imageUrl: string | null;
}

/**
 * Validate the rank catalogue and keep the name and badge of each tier.
 *
 * The badge is the large tier image, WebP first (`images.large_webp`, `images.large`). A tier
 * without a whole number `tier` or a name is skipped.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The readable tiers, sorted by tier.
 * @throws AppError of kind `invalid_payload` when the body is not an array or holds no readable
 *   tier.
 */
export function parseRankCatalogue(body: unknown): CatalogueRank[] {
  const ranks = readCatalogue(body, 'rank', (entry) => {
    const parsed = rankEntrySchema.safeParse(entry);
    if (!parsed.success) {
      return null;
    }
    const { tier, name, images } = parsed.data;
    return {
      tier,
      name,
      imageUrl: firstAssetImageUrl([images?.large_webp, images?.large]),
    };
  });
  return ranks.toSorted((first, second) => first.tier - second.tier);
}
