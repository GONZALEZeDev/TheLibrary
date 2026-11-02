/**
 * The card of an ability, as the ability window of the hero page shows it, with its upgrade tiers.
 *
 * The card mirrors the game's: chips for the timings and sizes (cooldown, charges, channel time,
 * range, radius, duration), the properties the game puts forward, the other ones it lists, and the three upgrade
 * tiers. Like in the game, the tiers add up: with the second tier active, the first one counts too.
 * Every value is computed again from its base and the active tiers, and marked when a tier changed
 * it, so that the window shows what an upgrade does.
 *
 * The card also lists a few timings the game does not show but deadlock.wiki gives (the delay
 * before Captivating Read detonates, say): the page aims to be more complete than the game.
 *
 * @packageDocumentation
 */
import type {
  AbilityDetail,
  ImportantProperty,
  ItemProperty,
} from '../deadlock-api/item-detail.schema';
import { addAmounts, parseAmount, type Amount } from './property-amount';

/** How many upgrade tiers are active: none, the first, the first two, or all three. */
export type TierLevel = 0 | 1 | 2 | 3;

/** The kind of damage a value deals: the window names it ("Spirit damage") and shows its icon. */
export type DamageKind = 'spirit' | 'weapon' | null;

/** One value of the card. */
export interface CardValue {
  /** The property it shows. */
  readonly property: string;
  /** The label in the UI language, when the game gives one. */
  readonly label: string | null;
  /** The value, with the active tiers. */
  readonly amount: Amount;
  /** The unit the game writes after the value (`s`, `m`), when it has one. */
  readonly postfix: string | null;
  readonly iconUrl: string | null;
  /** The factor of the spirit power on the value, with the active tiers. */
  readonly spiritScale: number | null;
  readonly damageKind: DamageKind;
  /** `true` when an active tier changed the value or its scaling. */
  readonly changed: boolean;
}

/** A value the game puts forward, with the icon of its status effect when it applies one. */
export interface ImportantValue extends CardValue {
  readonly statusEffectIconUrl: string | null;
}

/** A block of values the game puts forward, with its title when it has one ("On Enemy Hit:"). */
export interface ImportantBlock {
  readonly title: string | null;
  readonly values: readonly ImportantValue[];
}

/**
 * The timings the game hides but deadlock.wiki gives, in the order the window lists them. Each has
 * its own label in the app (`paige.hidden.<key>`): the API gives none for some of them.
 * The channel time is not one of them: like the wiki, the card shows it as a chip, and never twice.
 */
export const HIDDEN_VALUE_KEYS = ['AbilityCastDelay', 'DetonationDelay'] as const;

/** A timing the game hides. */
export type HiddenValueKey = (typeof HIDDEN_VALUE_KEYS)[number];

/** A timing the game hides, with the active tiers. */
export interface HiddenValue {
  readonly key: HiddenValueKey;
  readonly amount: Amount;
  readonly changed: boolean;
}

/**
 * One change of an upgrade tier, as the window writes it when the game gives no text for the tier
 * (deadlock-api leaves some tier texts empty, Captivating Read's first two among them).
 */
export interface TierChange {
  /** The property it changes. */
  readonly property: string;
  /** The label of the property in the UI language, when the game gives one. */
  readonly label: string | null;
  /** What the tier adds. */
  readonly bonus: Amount;
  /** The unit the game writes after the property's values (`s`, `m`, `%`), when it has one. */
  readonly postfix: string | null;
}

/** The card of an ability, with a given number of active tiers. */
export interface AbilityCardView {
  /** The English name: ability names are never translated. */
  readonly name: string;
  readonly imageUrl: string | null;
  /** The description in the UI language, as markup (see `description-markup.ts`). */
  readonly description: string;
  /** The texts of the three tiers in the UI language, as markup. */
  readonly tierDescriptions: readonly [string, string, string];
  /** The chips over the description; a chip that does not apply to the ability is `null`. */
  readonly chips: {
    readonly cooldown: CardValue | null;
    readonly charges: CardValue | null;
    readonly chargeDelay: CardValue | null;
    readonly channelTime: CardValue | null;
    readonly castRange: CardValue | null;
    readonly radius: CardValue | null;
    readonly duration: CardValue | null;
  };
  readonly important: readonly ImportantBlock[];
  readonly basic: readonly CardValue[];
  readonly hidden: readonly HiddenValue[];
  /** What each of the three tiers changes, whether active or not: the text of a tier the game left blank. */
  readonly tierChanges: readonly [
    readonly TierChange[],
    readonly TierChange[],
    readonly TierChange[],
  ];
}

/** What the active tiers do to the properties: the bonuses to the value and to the scaling. */
interface TierEffects {
  readonly values: ReadonlyMap<string, readonly Amount[]>;
  readonly scales: ReadonlyMap<string, number>;
}

/**
 * Gather what the active tiers do, property by property.
 *
 * @param ability - The ability.
 * @param level - How many tiers are active.
 * @returns The bonuses to the values and the additions to the spirit scaling, by property. A bonus
 *   that is not a number is left out.
 */
function tierEffects(ability: AbilityDetail, level: TierLevel): TierEffects {
  const values = new Map<string, Amount[]>();
  const scales = new Map<string, number>();
  for (const tier of ability.tiers.slice(0, level)) {
    for (const upgrade of tier) {
      const bonus = parseAmount(upgrade.bonus);
      if (bonus === null) {
        continue;
      }
      if (upgrade.addsToSpiritScale) {
        scales.set(upgrade.property, (scales.get(upgrade.property) ?? 0) + bonus.value);
      } else {
        values.set(upgrade.property, [...(values.get(upgrade.property) ?? []), bonus]);
      }
    }
  }
  return { values, scales };
}

/**
 * Tell the kind of damage a property deals, from the class and the icon the game gives it.
 *
 * @param property - The property.
 * @returns `spirit`, `weapon`, or `null` for a property that deals no damage.
 */
function damageKindOf(property: ItemProperty): DamageKind {
  if (property.cssClass === 'tech_damage' || property.iconUrl?.endsWith('damage_magic_color.svg')) {
    return 'spirit';
  }
  if (property.iconUrl?.endsWith('damage_bullet_color.svg')) {
    return 'weapon';
  }
  return null;
}

/**
 * Compute one value of the card.
 *
 * @param ability - The ability in the UI language, whose properties give the values and labels.
 * @param effects - What the active tiers do.
 * @param name - The property.
 * @returns The value, or `null` when the ability has no such property or its value is no number.
 */
function valueOf(ability: AbilityDetail, effects: TierEffects, name: string): CardValue | null {
  const property = ability.properties[name];
  const base = property === undefined ? null : parseAmount(property.value);
  if (property === undefined || base === null) {
    return null;
  }
  const bonuses = effects.values.get(name) ?? [];
  const addedScale = effects.scales.get(name);
  const amount = bonuses.reduce(addAmounts, base);
  const scale =
    addedScale === undefined
      ? property.spiritScale
      : Math.round(((property.spiritScale ?? 0) + addedScale) * 1e6) / 1e6;
  return {
    property: name,
    label: property.label,
    amount,
    postfix: property.postfix,
    iconUrl: property.iconUrl,
    spiritScale: scale === null || scale <= 0 ? null : scale,
    damageKind: damageKindOf(property),
    changed: bonuses.length > 0 || addedScale !== undefined,
  };
}

/**
 * Compute a value the game puts forward. A status effect (Immobilize) shows the property that
 * holds its duration, with the effect's icon.
 *
 * @param ability - The ability in the UI language.
 * @param effects - What the active tiers do.
 * @param important - The property the game puts forward.
 * @returns The value, or `null` when it cannot be read.
 */
function importantValueOf(
  ability: AbilityDetail,
  effects: TierEffects,
  important: ImportantProperty,
): ImportantValue | null {
  const value = valueOf(
    ability,
    effects,
    important.statusEffect?.valueProperty ?? important.property,
  );
  return value === null
    ? null
    : { ...value, statusEffectIconUrl: important.statusEffect?.iconUrl ?? null };
}

/**
 * Keep a value only when it is above 0: a chip of a range of 0 has nothing to say.
 *
 * @param value - The value, or `null`.
 * @returns The value when it is above 0, `null` otherwise.
 */
function positive(value: CardValue | null): CardValue | null {
  return value !== null && value.amount.value > 0 ? value : null;
}

/**
 * List what one tier changes, in the order of the game.
 *
 * @param ability - The ability in the UI language, whose properties give the labels and units.
 * @param tier - The changes of the tier.
 * @returns The changes of the values; a change to the spirit scaling, or a bonus that is no number,
 *   is left out.
 */
function changesOf(ability: AbilityDetail, tier: AbilityDetail['tiers'][number]): TierChange[] {
  return tier.flatMap((upgrade): TierChange[] => {
    const bonus = parseAmount(upgrade.bonus);
    if (upgrade.addsToSpiritScale || bonus === null) {
      return [];
    }
    const property = ability.properties[upgrade.property];
    return [
      {
        property: upgrade.property,
        label: property?.label ?? null,
        bonus,
        postfix: property?.postfix ?? null,
      },
    ];
  });
}

/**
 * Build the card of an ability with a number of active tiers.
 *
 * @param english - The ability in English: its name is the one the card shows, in every language.
 * @param localised - The ability in the UI language (the English entry itself in English): it
 *   gives the values, labels and texts.
 * @param level - How many tiers are active; they add up, as in the game.
 * @returns The card.
 */
export function buildAbilityCard(
  english: AbilityDetail,
  localised: AbilityDetail,
  level: TierLevel,
): AbilityCardView {
  const effects = tierEffects(localised, level);
  const value = (name: string) => valueOf(localised, effects, name);
  const charges = positive(value('AbilityCharges'));
  return {
    name: english.name,
    imageUrl: english.imageUrl ?? localised.imageUrl,
    description: localised.description,
    tierDescriptions: localised.tierDescriptions,
    chips: {
      cooldown: positive(value('AbilityCooldown')),
      charges,
      chargeDelay: charges === null ? null : positive(value('AbilityCooldownBetweenCharge')),
      channelTime: positive(value('AbilityChannelTime')),
      castRange: positive(value('AbilityCastRange')),
      radius: positive(value('Radius')),
      duration: positive(value('AbilityDuration')),
    },
    important: localised.important.map((block) => ({
      title: block.title,
      values: block.properties.flatMap((important) => {
        const shown = importantValueOf(localised, effects, important);
        return shown === null ? [] : [shown];
      }),
    })),
    basic: localised.basic.flatMap((name) => {
      const shown = value(name);
      return shown === null ? [] : [shown];
    }),
    tierChanges: [
      changesOf(localised, localised.tiers[0]),
      changesOf(localised, localised.tiers[1]),
      changesOf(localised, localised.tiers[2]),
    ],
    hidden: HIDDEN_VALUE_KEYS.flatMap((key): HiddenValue[] => {
      const shown = positive(value(key));
      return shown === null ? [] : [{ key, amount: shown.amount, changed: shown.changed }];
    }),
  };
}

/**
 * The tiers active after a click on one of them.
 *
 * @param current - How many tiers are active.
 * @param clicked - The tier clicked: 1, 2 or 3.
 * @returns The tiers up to the one clicked; or, when it is the highest active one, one tier less.
 */
export function nextTierLevel(current: TierLevel, clicked: 1 | 2 | 3): TierLevel {
  return clicked === current ? ((clicked - 1) as TierLevel) : clicked;
}
