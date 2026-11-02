/**
 * The window of an ability of the Paige page, laid out like the game's ability card, with its three
 * upgrade tiers.
 *
 * From top to bottom: the ability's sphere and its chips (cooldown, charges, range, radius,
 * duration), its description, the values the game puts forward (in boxes, with their icon and the
 * factor of the spirit power), the other values it lists, the three tiers, and the timings the game
 * hides but deadlock.wiki gives.
 *
 * A tier is a toggle. As in the game, the tiers add up: clicking the second activates the first too,
 * and clicking the highest active one again drops it. Every value is computed again from its base
 * and the active tiers, and what a tier changed turns to the accent colour. The tiers start off
 * each time the window opens: its content is mounted only while it is open.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { Info } from 'lucide-react';
import { Fragment, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildAbilityCard,
  type AbilityCardView,
  nextTierLevel,
  type CardValue,
  type ImportantValue,
  type TierChange,
  type TierLevel,
} from '../../../core/hero-page/ability-card';
import type { Amount } from '../../../core/hero-page/property-amount';
import type { AbilityPair } from '../../../services/paige-page.service';
import { BUTTON_CLASSES } from '../../components/button-styles';
import { Dialog } from '../../components/Dialog';
import { SPHERE_STYLE } from './AbilityOrbs';
import { DescriptionText } from './DescriptionText';
import { formatAmountWithUnit, formatStatNumber } from './stat-format';
import { MaskedIcon, PROPERTY_ICONS, SpiritScaling } from './StatPanels';

/** The points each tier costs in the game, in order. */
const TIER_POINTS = [1, 2, 5] as const;

/**
 * Write an amount of the card with its unit: metres for a distance, seconds for a time written `s`,
 * the API's own unit otherwise (a percentage, say).
 *
 * @param amount - The amount.
 * @param postfix - The unit the game writes after the property's values, when it has one.
 * @param language - The UI language.
 * @param t - The translator.
 * @returns The amount and its unit.
 */
function formatWithUnit(
  amount: Amount,
  postfix: string | null,
  language: string,
  t: TFunction,
): string {
  if (amount.unit === 'm' || postfix === 'm') {
    return formatAmountWithUnit(amount.value, 'm', language, t);
  }
  if (postfix === 's') {
    return formatAmountWithUnit(amount.value, 'seconds', language, t);
  }
  return `${formatStatNumber(amount.value, language)}${postfix ?? ''}`;
}

/**
 * Write a value of the card with its unit.
 *
 * @param value - The value.
 * @param language - The UI language.
 * @param t - The translator.
 * @returns The value and its unit.
 */
function formatCardValue(value: CardValue, language: string, t: TFunction): string {
  return formatWithUnit(value.amount, value.postfix, language, t);
}

/** Props of {@link TierChanges}. */
interface TierChangesProps {
  readonly changes: readonly TierChange[];
}

/**
 * What a tier changes, one line per value (`+150 Healing`), for a tier the game gives no text for.
 *
 * @returns The lines.
 */
function TierChanges({ changes }: TierChangesProps) {
  const { t, i18n } = useTranslation();
  return (
    <>
      {changes.map((change, index) => (
        <Fragment key={change.property}>
          {index > 0 && <br />}
          <strong className="text-accent-bright">
            {change.bonus.value > 0 ? '+' : ''}
            {formatWithUnit(change.bonus, change.postfix, i18n.language, t)}
          </strong>{' '}
          {change.label ?? change.property}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The label of a value: a damage value says which damage it is ("Spirit damage", "Spirit damage
 * per second"), whatever the API calls it; any other value keeps the game's label.
 *
 * @param value - The value.
 * @param t - The translator.
 * @returns The label.
 */
function labelOf(value: CardValue, t: TFunction): string {
  const perSecond = value.property === 'DPS';
  if (value.damageKind === 'spirit') {
    return t(perSecond ? 'paige.ability.spiritDps' : 'paige.ability.spiritDamage');
  }
  if (value.damageKind === 'weapon') {
    return t(perSecond ? 'paige.ability.weaponDps' : 'paige.ability.weaponDamage');
  }
  return value.label ?? value.property;
}

/**
 * The colour of a value.
 *
 * @param value - A value of the card.
 * @param value.changed - Whether an active tier changed it.
 * @returns The accent's class when a tier changed the value, nothing otherwise.
 */
function valueClass(value: { readonly changed: boolean }): string {
  return value.changed ? 'text-accent-bright' : '';
}

/** Props of {@link ValueBox}. */
interface ValueBoxProps {
  readonly value: ImportantValue;
}

/**
 * A value the game puts forward: its icon and number, its label, and the factor of the spirit power.
 *
 * @returns The box.
 */
function ValueBox({ value }: ValueBoxProps) {
  const { t, i18n } = useTranslation();
  const icon = value.statusEffectIconUrl ?? value.iconUrl;
  return (
    <li className="relative min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-2 pt-3 pb-2 text-center">
      {value.spiritScale !== null && (
        <span className="absolute top-1 right-1.5">
          <SpiritScaling factor={value.spiritScale} />
        </span>
      )}
      <span
        className={`flex items-center justify-center gap-1 text-xl font-bold tabular-nums ${valueClass(value)}`}
      >
        {icon !== null && <img src={icon} alt="" className="size-5" />}
        {formatCardValue(value, i18n.language, t)}
      </span>
      <span className="block text-xs text-fg-muted">{labelOf(value, t)}</span>
    </li>
  );
}

/** A chip of the card: what it measures. */
type ChipKey = keyof AbilityCardView['chips'];

/** The chips in the order of the game's card. */
const CHIP_ORDER: readonly ChipKey[] = [
  'cooldown',
  'charges',
  'chargeDelay',
  'channelTime',
  'castRange',
  'radius',
  'duration',
];

/** The label of each chip when the game gives none, and the unit of its value. */
const CHIP_DETAILS = {
  cooldown: { labelKey: 'paige.ability.cooldown', unit: 'seconds' },
  charges: { labelKey: 'paige.ability.chargesTitle', unit: null },
  chargeDelay: { labelKey: 'paige.ability.chargeDelayTitle', unit: 'seconds' },
  channelTime: { labelKey: 'paige.ability.channelTime', unit: 'seconds' },
  castRange: { labelKey: 'paige.ability.castRange', unit: 'm' },
  radius: { labelKey: 'paige.ability.radius', unit: 'm' },
  duration: { labelKey: 'paige.ability.duration', unit: 'seconds' },
} as const satisfies Record<
  ChipKey,
  { readonly labelKey: string; readonly unit: 'seconds' | 'm' | null }
>;

/**
 * The icon of a chip when the game gives none for the property (Captivating Read's radius has
 * none, where Bookwyrm's has one): every chip of a kind looks the same.
 */
const CHIP_FALLBACK_ICONS: Readonly<Record<ChipKey, string>> = {
  cooldown: `${PROPERTY_ICONS}cooldown.svg`,
  charges: `${PROPERTY_ICONS}recharge.svg`,
  chargeDelay: `${PROPERTY_ICONS}recharge.svg`,
  channelTime: `${PROPERTY_ICONS}duration.svg`,
  castRange: `${PROPERTY_ICONS}range.svg`,
  radius: `${PROPERTY_ICONS}range.svg`,
  duration: `${PROPERTY_ICONS}duration.svg`,
};

/** Props of {@link Chip}. */
interface ChipProps {
  readonly chip: ChipKey;
  readonly value: CardValue;
}

/**
 * A chip of the card: the game's icon of what it measures and its value, named on hover (the
 * `title`) and for screen readers, as on deadlock.wiki.
 *
 * @returns The chip.
 */
function Chip({ chip, value }: ChipProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { labelKey, unit } = CHIP_DETAILS[chip];
  const label = value.label ?? t(labelKey);
  const shown = formatAmountWithUnit(value.amount.value, unit, language, t);
  return (
    <li
      title={label}
      className={`flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 py-0.5 text-sm font-bold ${valueClass(value)}`}
    >
      <MaskedIcon url={value.iconUrl ?? CHIP_FALLBACK_ICONS[chip]} className="size-4 bg-fg" />
      <span className="sr-only">{label} </span>
      <span>
        {chip === 'charges'
          ? t('paige.ability.charges', { count: value.amount.value })
          : chip === 'chargeDelay'
            ? t('paige.ability.chargeDelay', { value: shown })
            : shown}
      </span>
    </li>
  );
}

/** Props of {@link AbilityCard}. */
interface AbilityCardProps {
  readonly ability: AbilityPair;
  readonly onClose: () => void;
}

/**
 * The content of the window. Its tier state lives here, so it starts off at each opening: the
 * dialog mounts its content only while it is open.
 *
 * @returns The card of the ability and its tiers.
 */
function AbilityCard({ ability, onClose }: AbilityCardProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [level, setLevel] = useState<TierLevel>(0);
  const hiddenTitleId = useId();
  const card = useMemo(
    () => buildAbilityCard(ability.english, ability.localised, level),
    [ability, level],
  );
  const { chips } = card;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-full"
          style={SPHERE_STYLE}
        >
          {card.imageUrl !== null && <img src={card.imageUrl} alt="" className="size-8" />}
        </span>
        <ul aria-label={t('paige.ability.chips')} className="flex flex-wrap gap-1.5">
          {CHIP_ORDER.map((key) => {
            const value = chips[key];
            return value === null ? null : <Chip key={key} chip={key} value={value} />;
          })}
        </ul>
      </div>
      <p className="text-sm leading-relaxed text-fg-muted">
        <DescriptionText markup={card.description} />
      </p>
      {card.important.map((block, index) => (
        // The blocks never change order for an ability: their index is a stable key.
        <section key={String(index)}>
          {block.title !== null && (
            <h3 className="mb-1 text-xs font-bold text-fg-muted">{block.title}</h3>
          )}
          {/* The boxes of a block share its whole width, whether it has two values or three. */}
          <ul className="flex gap-1.5">
            {block.values.map((value) => (
              <ValueBox key={value.property} value={value} />
            ))}
          </ul>
        </section>
      ))}
      {card.basic.length > 0 && (
        <ul className="grid gap-1.5">
          {card.basic.map((value) => (
            <li
              key={value.property}
              className="rounded-md border border-border bg-surface-raised px-2 py-1 text-center text-sm"
            >
              <span className={`font-bold ${valueClass(value)}`}>
                {formatCardValue(value, language, t)}
              </span>{' '}
              <span className="text-fg-muted">{labelOf(value, t)}</span>
            </li>
          ))}
        </ul>
      )}
      <section>
        <h3 className="sr-only">{t('paige.ability.upgrades')}</h3>
        <div className="grid grid-cols-3 gap-1.5">
          {TIER_POINTS.map((points, index) => {
            const tier = (index + 1) as 1 | 2 | 3;
            const active = tier <= level;
            return (
              <button
                key={points}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setLevel(nextTierLevel(level, tier));
                }}
                className={`rounded-md border px-2 py-2 text-center text-sm leading-snug ${
                  active
                    ? // On the accent fill, the highlighted numbers turn white to stay readable.
                      'border-accent-bright bg-accent text-white [&_strong]:text-white'
                    : 'border-border bg-bg hover:border-accent'
                }`}
              >
                <span className="sr-only">{t('paige.ability.tier', { points })} </span>
                <span
                  aria-hidden="true"
                  className="mb-1 inline-block rounded bg-surface-raised px-1.5 font-bold text-fg"
                >
                  {points}
                </span>
                <span className="block">
                  {/* deadlock-api leaves some tier texts blank: the window then writes what the
                      tier changes itself. */}
                  {(card.tierDescriptions[index] ?? '').trim() === '' ? (
                    <TierChanges changes={card.tierChanges[index] ?? []} />
                  ) : (
                    <DescriptionText markup={card.tierDescriptions[index] ?? ''} />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {card.hidden.length > 0 && (
        // The timings the game hides are what the page adds to the game: they stand out.
        <section
          aria-labelledby={hiddenTitleId}
          className="rounded-md border border-accent/60 bg-accent/10 px-3 py-2"
        >
          <h3
            id={hiddenTitleId}
            className="mb-1 flex items-center gap-1.5 text-sm font-bold text-accent-bright"
          >
            <Info aria-hidden="true" className="size-4" />
            {t('paige.ability.hidden')}
          </h3>
          <ul className="grid gap-0.5 text-sm">
            {card.hidden.map((value) => (
              <li key={value.key} className="flex justify-between gap-3">
                <span>{t(`paige.hidden.${value.key}`)}</span>
                <span className={`font-bold tabular-nums ${valueClass(value)}`}>
                  {formatAmountWithUnit(value.amount.value, 'seconds', language, t)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex justify-end">
        <button type="button" onClick={onClose} className={BUTTON_CLASSES.subtle}>
          {t('paige.ability.close')}
        </button>
      </div>
    </div>
  );
}

/** Props of {@link AbilityDialog}. */
export interface AbilityDialogProps {
  /** The ability shown, or `null` while the window is closed. */
  readonly ability: AbilityPair | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * The window of an ability, titled with its English name.
 *
 * @returns The dialog.
 */
export function AbilityDialog({ ability, open, onClose }: AbilityDialogProps) {
  return (
    <Dialog
      open={open && ability !== null}
      title={ability?.english.name ?? ''}
      size="wide"
      onClose={onClose}
    >
      {ability !== null && <AbilityCard ability={ability} onClose={onClose} />}
    </Dialog>
  );
}
