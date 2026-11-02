/**
 * Validation and mapping of one item entry of deadlock-api (`GET /v1/assets/items/{class_name}`):
 * an ability with its full tooltip, or a weapon with its numbers.
 *
 * The ability window of the hero page shows an ability the way the game's card does: its
 * properties (value, label, icon, spirit scaling), the properties the card puts forward, its
 * description and its three upgrade tiers. This module keeps those fields, in the shape the window
 * and the cache of the page read.
 *
 * As in `hero-detail.schema.ts`, the schemas of the kept shapes ({@link abilityDetailSchema},
 * {@link weaponDetailSchema}) are checked again by the cache on every read.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { ASSET_IMAGE_ORIGIN, firstAssetImageUrl } from './assets.schema';

/** The endpoint named in the errors and the log lines: a template, never a class name. */
const ENDPOINT = '/v1/assets/items/{class_name}';

/** The spirit power, as the game names the stat a property can scale with. */
const SPIRIT_POWER_STAT = 'ETechPower';

/** A string field that only decorates the card: anything else reads as absent. */
const optionalText = z.string().optional().catch(undefined);

/** One property of an ability as deadlock-api returns it (only the fields the app uses). */
const rawPropertySchema = z.object({
  value: z.union([z.string(), z.number()]).transform(String),
  label: optionalText,
  postfix: optionalText,
  icon: optionalText,
  css_class: optionalText,
  scale_function: z
    .object({
      stat_scale: z.number().optional().catch(undefined),
      specific_stat_scale_type: optionalText,
    })
    .optional()
    .catch(undefined),
});

/** One change of an upgrade tier. */
const rawUpgradeSchema = z.object({
  name: z.string().min(1),
  bonus: z.union([z.string(), z.number()]).transform(String),
  upgrade_type: optionalText,
  scale_stat_filter: optionalText,
});

/** One property the card puts forward, with its status effect when it is one. */
const rawImportantSchema = z.object({
  important_property: z.string().min(1),
  status_effect_value: optionalText,
  important_property_icon: optionalText,
});

/** The ability entry as deadlock-api returns it (only the fields the app uses). */
const rawAbilitySchema = z.object({
  class_name: z.string().min(1),
  name: z.string().trim().min(1),
  image: z.unknown(),
  image_webp: z.unknown(),
  description: z.object({
    desc: z.string().catch(''),
    t1_desc: z.string().catch(''),
    t2_desc: z.string().catch(''),
    t3_desc: z.string().catch(''),
  }),
  // A property that is not readable is left out rather than failing the ability.
  properties: z.record(z.string(), z.unknown()),
  upgrades: z.array(z.object({ property_upgrades: z.array(rawUpgradeSchema).catch([]) })).length(3),
  tooltip_details: z
    .object({
      info_sections: z.array(
        z.object({
          properties_block: z
            .array(
              z.object({
                loc_string: optionalText,
                properties: z.array(rawImportantSchema).catch([]),
              }),
            )
            .optional()
            .catch(undefined),
          basic_properties: z.array(z.string()).optional().catch(undefined),
        }),
      ),
    })
    .optional()
    .catch(undefined),
});

/** The weapon entry as deadlock-api returns it (only the fields the app uses). */
const rawWeaponSchema = z.object({
  class_name: z.string().min(1),
  name: z.string().trim().min(1),
  weapon_info: z.object({
    bullet_damage: z.number().positive(),
    cycle_time: z.number().positive(),
    clip_size: z.number().int().positive(),
    reload_duration: z.number().positive(),
    bullet_speed: z.number().positive(),
  }),
});

/** A picture of the card: on the asset bucket, the only image origin of a download. */
const imageUrlSchema = z.string().startsWith(ASSET_IMAGE_ORIGIN).nullable();

/** A property of an ability, as the ability window reads it. */
const itemPropertySchema = z.object({
  /** The value as the API writes it (`"33"`, `"4m"`). */
  value: z.string(),
  /** The label in the language of the answer, when the game shows one. */
  label: z.string().nullable(),
  /** The unit the game writes after the value (`s`, `m`), when there is one. */
  postfix: z.string().nullable(),
  /** The icon of the property. */
  iconUrl: imageUrlSchema,
  /** The class the game styles the value with (`tech_damage` for spirit damage, say). */
  cssClass: z.string().nullable(),
  /** The factor of the spirit power on the value, when it has one. */
  spiritScale: z.number().positive().nullable(),
});

/** A property of an ability, as the ability window reads it. */
export type ItemProperty = z.infer<typeof itemPropertySchema>;

/** One change of an upgrade tier. */
const tierUpgradeSchema = z.object({
  /** The property it changes. */
  property: z.string().min(1),
  /** What it adds, as the API writes it (`"-12"`, `"1m"`, `"0.16"`). */
  bonus: z.string(),
  /** `true` when it adds to the factor of the spirit power instead of to the value. */
  addsToSpiritScale: z.boolean(),
});

/** One change of an upgrade tier. */
export type TierUpgrade = z.infer<typeof tierUpgradeSchema>;

/** A property the card puts forward. */
const importantPropertySchema = z.object({
  property: z.string().min(1),
  /** The status effect it applies (Immobilize, Stun), with the property that holds its value. */
  statusEffect: z.object({ valueProperty: z.string().min(1), iconUrl: imageUrlSchema }).nullable(),
});

/** A property the card puts forward. */
export type ImportantProperty = z.infer<typeof importantPropertySchema>;

/**
 * Schema of a kept ability. It is the shape {@link parseAbilityDetail} gives, checked again by the
 * cache of the hero page on every read.
 */
export const abilityDetailSchema = z.object({
  className: z.string().min(1),
  /** The name in the language of the answer: the page always shows the English one. */
  name: z.string().min(1),
  imageUrl: imageUrlSchema,
  /** The description, as markup (see `description-markup.ts`). */
  description: z.string(),
  /** The texts of the three upgrade tiers, as markup. */
  tierDescriptions: z.tuple([z.string(), z.string(), z.string()]),
  /** The properties by name (`AbilityCooldown`, `Damage`…). */
  properties: z.record(z.string(), itemPropertySchema),
  /** The changes of the three upgrade tiers (1, 2 and 5 points), in order. */
  tiers: z.tuple([
    z.array(tierUpgradeSchema),
    z.array(tierUpgradeSchema),
    z.array(tierUpgradeSchema),
  ]),
  /**
   * The properties the card puts forward, by block. A block may have a title in the language of the
   * answer: Rallying Charge has one block for the enemies it hits, one for the allies.
   */
  important: z.array(
    z.object({ title: z.string().nullable(), properties: z.array(importantPropertySchema) }),
  ),
  /** The other properties the card lists, by name. */
  basic: z.array(z.string()),
});

/** An ability as the ability window reads it. */
export type AbilityDetail = z.infer<typeof abilityDetailSchema>;

/** Schema of a kept weapon: the numbers the stat panels derive the weapon's stats from. */
export const weaponDetailSchema = z.object({
  className: z.string().min(1),
  /** The name in the language of the answer: the page always reads the English entry. */
  name: z.string().min(1),
  /** Damage of one bullet. */
  bulletDamage: z.number().positive(),
  /** Seconds between two shots. */
  cycleTime: z.number().positive(),
  /** Bullets in a clip. */
  clipSize: z.number().int().positive(),
  /** Seconds of a reload. */
  reloadDuration: z.number().positive(),
  /** Speed of a bullet, in game units per second. */
  bulletSpeed: z.number().positive(),
});

/** A weapon as the stat panels read it. */
export type WeaponDetail = z.infer<typeof weaponDetailSchema>;

/**
 * Read one property of an ability.
 *
 * @param raw - The property as the API gives it.
 * @returns The property, or `null` when it has no readable value.
 */
function readProperty(raw: unknown): ItemProperty | null {
  const parsed = rawPropertySchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { value, label, postfix, icon, css_class: cssClass, scale_function: scale } = parsed.data;
  const scaleStat = scale?.specific_stat_scale_type;
  const statScale = scale?.stat_scale;
  return {
    value,
    label: label === undefined || label === '' ? null : label,
    postfix: postfix === undefined || postfix === '' ? null : postfix,
    iconUrl: firstAssetImageUrl([icon]),
    cssClass: cssClass ?? null,
    // The factor counts when it scales with the spirit power: no named stat (the damage scale
    // functions) or the spirit power by name. A factor of 0 is no scaling.
    spiritScale:
      statScale !== undefined &&
      statScale > 0 &&
      (scaleStat === undefined || scaleStat === SPIRIT_POWER_STAT)
        ? statScale
        : null,
  };
}

/**
 * Validate one ability entry and keep what the ability window shows.
 *
 * A property whose value is unreadable is left out; the pictures are kept only when they point into
 * the asset bucket.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The ability.
 * @throws AppError of kind `invalid_payload` when the entry is not an ability with three upgrade
 *   tiers.
 */
export function parseAbilityDetail(body: unknown): AbilityDetail {
  const parsed = rawAbilitySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('invalid_payload', 'The item entry is not an ability with three tiers', {
      context: { endpoint: ENDPOINT },
    });
  }
  const entry = parsed.data;
  const properties = Object.fromEntries(
    Object.entries(entry.properties).flatMap(([name, raw]): [string, ItemProperty][] => {
      const property = readProperty(raw);
      return property === null ? [] : [[name, property]];
    }),
  );
  const tiers = entry.upgrades.map((tier) =>
    tier.property_upgrades.map((upgrade): TierUpgrade => ({
      property: upgrade.name,
      bonus: upgrade.bonus,
      addsToSpiritScale:
        upgrade.upgrade_type === 'EAddToScale' && upgrade.scale_stat_filter === SPIRIT_POWER_STAT,
    })),
  );
  const sections = entry.tooltip_details?.info_sections ?? [];
  const important = sections.flatMap((section) =>
    (section.properties_block ?? []).map((block) => ({
      title: block.loc_string === undefined || block.loc_string === '' ? null : block.loc_string,
      properties: block.properties.map((property): ImportantProperty => ({
        property: property.important_property,
        statusEffect:
          property.status_effect_value === undefined
            ? null
            : {
                valueProperty: property.status_effect_value,
                iconUrl: firstAssetImageUrl([property.important_property_icon]),
              },
      })),
    })),
  );
  return abilityDetailSchema.parse({
    className: entry.class_name,
    name: entry.name,
    imageUrl: firstAssetImageUrl([entry.image_webp, entry.image]),
    description: entry.description.desc,
    tierDescriptions: [
      entry.description.t1_desc,
      entry.description.t2_desc,
      entry.description.t3_desc,
    ],
    properties,
    tiers,
    important,
    basic: sections.flatMap((section) => section.basic_properties ?? []),
  });
}

/**
 * Validate one weapon entry and keep the numbers the stat panels read.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The weapon.
 * @throws AppError of kind `invalid_payload` when the entry is not a weapon with its numbers.
 */
export function parseWeaponDetail(body: unknown): WeaponDetail {
  const parsed = rawWeaponSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('invalid_payload', 'The item entry is not a weapon with its numbers', {
      context: { endpoint: ENDPOINT },
    });
  }
  const { class_name: className, name, weapon_info: info } = parsed.data;
  return {
    className,
    name,
    bulletDamage: info.bullet_damage,
    cycleTime: info.cycle_time,
    clipSize: info.clip_size,
    reloadDuration: info.reload_duration,
    bulletSpeed: info.bullet_speed,
  };
}
