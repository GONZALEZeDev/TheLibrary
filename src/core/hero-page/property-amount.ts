/**
 * The amounts of the properties of an ability, as deadlock-api writes them, and their sums.
 *
 * A property value is a string (`"33"`, `"4m"`, `"-12"`, `"+1.0"`) or, in some upgrade tiers, a
 * number. The hero page reads it once into an {@link Amount} and adds the bonuses of the upgrade
 * tiers to it, so that a tier can be shown with its effect on every value of the card.
 *
 * @packageDocumentation
 */

/** A number with the unit the API writes after it: metres (`m`), or none. */
export interface Amount {
  /** The number. */
  readonly value: number;
  /** `m` for a distance written `"4m"`; `null` when the API writes no unit. */
  readonly unit: 'm' | null;
}

/** A signed decimal number, optionally followed by `m`, and nothing else. */
const AMOUNT_PATTERN = /^([+-]?\d+(?:\.\d+)?)(m?)$/;

/**
 * Read a property value or an upgrade bonus.
 *
 * @param raw - The value as the API gives it: `"4m"`, `"-12"`, `"+1.0"`, `1`…
 * @returns The amount, or `null` when the value is not a number (a template such as `"{s:sign}"`,
 *   an empty string, a number that is not finite).
 */
export function parseAmount(raw: string | number): Amount | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { value: raw, unit: null } : null;
  }
  const match = AMOUNT_PATTERN.exec(raw.trim());
  if (match === null) {
    return null;
  }
  return { value: Number(match[1]), unit: match[2] === 'm' ? 'm' : null };
}

/**
 * Add an upgrade bonus to a base amount.
 *
 * The unit of the base wins: the API sometimes writes a bonus of a distance without its `m`. The
 * sum is rounded to six decimals, so that 0.1 + 0.2 shows as 0.3.
 *
 * @param base - The amount before the bonus.
 * @param bonus - The bonus.
 * @returns The sum, in the unit of the base.
 */
export function addAmounts(base: Amount, bonus: Amount): Amount {
  return { value: Math.round((base.value + bonus.value) * 1e6) / 1e6, unit: base.unit };
}
