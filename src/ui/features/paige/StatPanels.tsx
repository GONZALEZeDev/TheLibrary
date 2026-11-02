/**
 * The stat panels of the Paige page: the weapon, the vitality and the spirit, as the deadlock.wiki
 * infobox shows them, each tinted with the game's colour of its category.
 *
 * Every row has the icon of its stat, its label, its base value, and when it has them the gain of
 * each level (`+31`) and the factor of the spirit power (the purple star and `×0.45`). The gain and
 * the factor are written for screen readers too, since a bare `+31` says nothing.
 *
 * The icons are the game's own property icons, on the asset bucket. They are white, and tinted
 * through a CSS mask with the colour of the panel.
 *
 * @packageDocumentation
 */
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ASSET_IMAGE_ORIGIN } from '../../../core/deadlock-api/assets.schema';
import type {
  StatKey,
  StatPanels as StatPanelsData,
  StatRow,
} from '../../../core/hero-page/stat-panels';
import { GamePicture } from '../../components/GamePicture';
import { formatAmountWithUnit, formatStatNumber } from './stat-format';

/** The folder of the game's property icons on the asset bucket. */
export const PROPERTY_ICONS = `${ASSET_IMAGE_ORIGIN}assets-api-res/icons/icons/properties/`;

/** The star of the spirit power, the icon of the spirit scaling. */
export const SPIRIT_STAR_ICON = `${ASSET_IMAGE_ORIGIN}assets-api-res/icons/hud/core/icon_spirit.svg`;

/**
 * The icon of each stat. The API ties no icon to the stats of a hero, so the page picks one of the
 * game's property icons for each; the sprint and dash speeds have none of their own and take the
 * one of the move speed.
 */
const STAT_ICON: Readonly<Record<StatKey, string>> = {
  dps: 'damage_bullet_color.svg',
  bulletDamage: 'damage_bullet_color.svg',
  ammo: 'ammo_clip_size.svg',
  bulletsPerSecond: 'fire_rate.svg',
  reloadTime: 'ammo_reload.svg',
  bulletVelocity: 'fire_rate.svg',
  lightMelee: 'melee.svg',
  heavyMelee: 'melee.svg',
  health: 'health.svg',
  healthRegen: 'heal.svg',
  moveSpeed: 'move_speed.svg',
  sprintSpeed: 'move_speed.svg',
  dashSpeed: 'move_speed.svg',
  stamina: 'move_stamina_recharge.svg',
  staminaCooldown: 'move_stamina_recharge.svg',
  spiritPower: 'spirit.svg',
};

/** The three categories of the panels, by their colour classes (theme tokens). */
type Category = 'weapon' | 'vitality' | 'spirit';

/** The classes of each category: the fill of its icons and of the bar of its title. */
const CATEGORY_FILL: Readonly<Record<Category, string>> = {
  weapon: 'bg-stat-weapon',
  vitality: 'bg-stat-vitality',
  spirit: 'bg-stat-spirit',
};

/** Props of {@link MaskedIcon}. */
interface MaskedIconProps {
  /** The white icon, used as a mask. */
  readonly url: string;
  /** The fill class (a theme colour) and the size, e.g. `bg-stat-spirit size-4`. */
  readonly className: string;
}

/**
 * A white icon of the game, tinted with a theme colour.
 *
 * The icon is a CSS mask over a filled box: the style is set through the DOM by React, which the
 * Content Security Policy allows (`style-src 'self'` forbids style attributes written in markup, not
 * styles set by script). The mask is fetched like an image, from the asset bucket.
 *
 * @returns The icon, hidden from screen readers: the label of its row says what it is.
 */
export function MaskedIcon({ url, className }: MaskedIconProps) {
  const mask = `url("${url}") center / contain no-repeat`;
  const style: CSSProperties = { mask, WebkitMask: mask };
  return (
    <span
      aria-hidden="true"
      data-icon=""
      className={`inline-block shrink-0 ${className}`}
      style={style}
    />
  );
}

/** Props of {@link SpiritScaling}. */
interface SpiritScalingProps {
  /** The factor of the spirit power. */
  readonly factor: number;
}

/**
 * The factor of the spirit power on a value: the purple star and `×1.3`, as in the game.
 *
 * @returns The factor, with its meaning written for screen readers.
 */
export function SpiritScaling({ factor }: SpiritScalingProps) {
  const { t, i18n } = useTranslation();
  const shown = formatStatNumber(factor, i18n.language);
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-bold text-stat-spirit">
      <MaskedIcon url={SPIRIT_STAR_ICON} className="size-3 bg-stat-spirit" />
      <span aria-hidden="true">×{shown}</span>
      <span className="sr-only">{t('paige.spiritScaling', { factor: shown })}</span>
    </span>
  );
}

/** Props of {@link StatLine}. */
interface StatLineProps {
  readonly row: StatRow;
  readonly category: Category;
}

/**
 * One row of a panel.
 *
 * @returns The row: icon, label, value, and its gain per level and spirit scaling when it has them.
 */
function StatLine({ row, category }: StatLineProps) {
  const { t, i18n } = useTranslation();
  const gain = row.perLevel === null ? null : formatStatNumber(row.perLevel, i18n.language);
  return (
    <li className="grid grid-cols-[1rem_1fr_auto] items-center gap-2 border-b border-border/60 py-1 text-sm last:border-b-0">
      <MaskedIcon
        url={`${PROPERTY_ICONS}${STAT_ICON[row.key]}`}
        className={`size-4 ${CATEGORY_FILL[category]}`}
      />
      <span>{t(`paige.stats.${row.key}`)}</span>
      <span className="flex items-baseline justify-end gap-1.5 whitespace-nowrap">
        <span className="font-bold tabular-nums">
          {formatAmountWithUnit(row.value, row.unit, i18n.language, t)}
        </span>
        {gain !== null && (
          <span className="text-xs font-bold text-accent-bright">
            <span aria-hidden="true">+{gain}</span>
            <span className="sr-only">{t('paige.perLevel', { value: gain })}</span>
          </span>
        )}
        {row.spiritScale !== null && <SpiritScaling factor={row.spiritScale} />}
      </span>
    </li>
  );
}

/** Props of {@link Panel}. */
interface PanelProps {
  readonly category: Category;
  readonly rows: readonly StatRow[];
  /** What sits between the title and the rows (the weapon's picture and name). */
  readonly children?: ReactNode;
}

/**
 * One panel: its title with the bar of its colour, then its rows.
 *
 * @returns The panel.
 */
function Panel({ category, rows, children }: PanelProps) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-border bg-surface/90 px-3 py-2.5">
      <h2 className="mb-1.5 flex items-center gap-2 font-title text-base font-extrabold">
        {t(`paige.panels.${category}`)}
        <span aria-hidden="true" className={`h-0.5 flex-1 rounded ${CATEGORY_FILL[category]}`} />
      </h2>
      {children}
      <ul>
        {rows.map((row) => (
          <StatLine key={row.key} row={row} category={category} />
        ))}
      </ul>
    </section>
  );
}

/** Props of {@link StatPanels}. */
export interface StatPanelsProps {
  readonly stats: StatPanelsData;
}

/**
 * The three panels: the weapon on the left, the vitality above the spirit on the right.
 *
 * @returns The panels.
 */
export function StatPanels({ stats }: StatPanelsProps) {
  return (
    <div className="grid grid-cols-2 items-start gap-3">
      <Panel category="weapon" rows={stats.weapon.rows}>
        <div className="mb-1 flex items-center gap-2 text-sm text-fg-muted">
          <GamePicture src={stats.weapon.imageUrl} size="medium" fit="contain" fallback="none" />
          {/* The weapon's name, like the abilities', stays in English. */}
          <span lang="en">{stats.weapon.name}</span>
        </div>
      </Panel>
      <div className="grid gap-3">
        <Panel category="vitality" rows={stats.vitality} />
        <Panel category="spirit" rows={stats.spirit} />
      </div>
    </div>
  );
}
