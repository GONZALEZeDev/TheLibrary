/**
 * Tests of the ability card and its upgrade tiers, against the game's numbers.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_PAIGE_ABILITIES } from '../../adapters/dev/fixtures/paige.fixture';
import { parseAbilityDetail, type AbilityDetail } from '../deadlock-api/item-detail.schema';
import { buildAbilityCard, nextTierLevel, type CardValue } from './ability-card';

/** One of Paige's abilities, parsed, in a language. */
function ability(className: string, language: 'english' | 'french' = 'english'): AbilityDetail {
  return parseAbilityDetail(FIXTURE_PAIGE_ABILITIES[language][className]);
}

const BOOKWYRM = ability('ability_bookworm_dragonfire');
const PLOT_ARMOR = ability('ability_bookworm_knightbarrier');
const CAPTIVATING_READ = ability('ability_bookworm_aoemagic');

/** The value of a chip; fails the test when the chip is absent. */
function chip(value: CardValue | null): CardValue {
  if (value === null) {
    throw new Error('The chip is absent');
  }
  return value;
}

describe('buildAbilityCard', () => {
  it('shows Bookwyrm as the game does without any tier', () => {
    const card = buildAbilityCard(BOOKWYRM, BOOKWYRM, 0);

    expect(card.name).toBe('Bookwyrm');
    expect(chip(card.chips.cooldown).amount).toEqual({ value: 33, unit: null });
    expect(chip(card.chips.charges).amount.value).toBe(1);
    expect(chip(card.chips.chargeDelay).amount.value).toBe(7);
    expect(chip(card.chips.radius).amount).toEqual({ value: 4, unit: 'm' });
    expect(chip(card.chips.duration).amount.value).toBe(5);
    // Bookwyrm is cast at the aimed spot: no cast range to show.
    expect(card.chips.castRange).toBeNull();
    const damage = card.important[0]?.values[0];
    expect(damage).toMatchObject({
      property: 'Damage',
      amount: { value: 60, unit: null },
      spiritScale: 1.3,
      damageKind: 'spirit',
      changed: false,
    });
    expect(card.basic[0]).toMatchObject({
      property: 'DragonTravelRange',
      amount: { value: 20, unit: 'm' },
    });
  });

  it('adds the first two tiers together, like the game', () => {
    const card = buildAbilityCard(BOOKWYRM, BOOKWYRM, 2);

    expect(chip(card.chips.cooldown)).toMatchObject({ amount: { value: 21 }, changed: true });
    expect(chip(card.chips.charges)).toMatchObject({ amount: { value: 2 }, changed: true });
    expect(chip(card.chips.radius)).toMatchObject({
      amount: { value: 5, unit: 'm' },
      changed: true,
    });
    const [damage, , trail] = card.important[0]?.values ?? [];
    expect(trail).toMatchObject({ amount: { value: 5 }, changed: true });
    expect(damage).toMatchObject({ amount: { value: 60 }, changed: false });
  });

  it('adds the third tier to the damage and the travel range', () => {
    const card = buildAbilityCard(BOOKWYRM, BOOKWYRM, 3);
    const [damage, dps] = card.important[0]?.values ?? [];

    expect(damage?.amount.value).toBe(160);
    expect(dps?.amount.value).toBe(60);
    expect(card.basic[0]?.amount).toEqual({ value: 32, unit: 'm' });
  });

  it('adds a tier to the spirit scaling when the game says so', () => {
    const base = buildAbilityCard(PLOT_ARMOR, PLOT_ARMOR, 0);
    const card = buildAbilityCard(PLOT_ARMOR, PLOT_ARMOR, 1);
    const fireRate = (view: typeof card) =>
      view.important[0]?.values.find((value) => value.property === 'BonusFireRate');

    expect(fireRate(base)).toMatchObject({ amount: { value: 0 }, spiritScale: null });
    expect(fireRate(card)).toMatchObject({
      amount: { value: 14 },
      spiritScale: 0.16,
      changed: true,
    });
  });

  it("shows the timings the game hides but the wiki gives, such as Captivating Read's delay", () => {
    const card = buildAbilityCard(CAPTIVATING_READ, CAPTIVATING_READ, 0);

    expect(card.hidden).toContainEqual({
      key: 'DetonationDelay',
      amount: { value: 1.25, unit: null },
      changed: false,
    });
    // A timing of 0 is not shown.
    expect(card.hidden.map((value) => value.key)).not.toContain('AbilityChannelTime');
  });

  it("shows Rallying Charge's channel time as a chip, and not again among the wiki timings", () => {
    const rallyingCharge = ability('ability_bookworm_knightcharge');
    const card = buildAbilityCard(rallyingCharge, rallyingCharge, 0);

    expect(chip(card.chips.channelTime).amount).toEqual({ value: 0.7, unit: null });
    expect(chip(card.chips.channelTime).iconUrl).toMatch(/property_cast\.png$/);
    expect(card.hidden.map((value) => value.key)).not.toContain('AbilityChannelTime');
  });

  it('shows the status effect of an important property with its duration and icon', () => {
    const card = buildAbilityCard(CAPTIVATING_READ, CAPTIVATING_READ, 2);
    const immobilize = card.important[0]?.values[1];

    expect(immobilize).toMatchObject({
      property: 'ImmobilizeDuration',
      amount: { value: 2 },
      changed: true,
    });
    expect(immobilize?.statusEffectIconUrl).toMatch(/condition_immobilize\.svg$/);
  });

  it('keeps the English name and takes the values and labels of the UI language', () => {
    const card = buildAbilityCard(BOOKWYRM, ability('ability_bookworm_dragonfire', 'french'), 0);

    expect(card.name).toBe('Bookwyrm');
    expect(card.important[0]?.values[0]?.label).toBe('Dégâts');
    expect(card.description).toContain('dégâts spirituels');
  });
});

describe('tier changes', () => {
  it('lists what each tier changes, for the tiers the game describes with no text', () => {
    const card = buildAbilityCard(CAPTIVATING_READ, CAPTIVATING_READ, 0);

    expect(card.tierChanges[0]).toEqual([
      {
        property: 'AbilityCooldown',
        label: 'Cooldown',
        bonus: { value: -14, unit: null },
        postfix: 's',
      },
    ]);
    expect(card.tierChanges[1]).toEqual([
      {
        property: 'ImmobilizeDuration',
        label: expect.any(String) as unknown,
        bonus: { value: 1, unit: null },
        postfix: 's',
      },
    ]);
  });

  it('leaves out a change to the spirit scaling, which the tier text describes', () => {
    const card = buildAbilityCard(PLOT_ARMOR, PLOT_ARMOR, 0);

    expect(card.tierChanges[0].map((change) => change.property)).toEqual(['BonusFireRate']);
  });
});

describe('nextTierLevel', () => {
  it('activates the tiers up to the one clicked', () => {
    expect(nextTierLevel(0, 3)).toBe(3);
    expect(nextTierLevel(3, 1)).toBe(1);
  });

  it('drops the highest active tier when it is clicked again', () => {
    expect(nextTierLevel(2, 2)).toBe(1);
    expect(nextTierLevel(1, 1)).toBe(0);
  });
});
