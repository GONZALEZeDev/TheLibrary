/**
 * Tests of the validation of one ability or weapon entry (`GET /v1/assets/items/{class_name}`).
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_PAIGE_ABILITIES,
  FIXTURE_PAIGE_WEAPON,
} from '../../adapters/dev/fixtures/paige.fixture';
import { AppError } from '../errors/app-error';
import {
  abilityDetailSchema,
  parseAbilityDetail,
  parseWeaponDetail,
  weaponDetailSchema,
} from './item-detail.schema';

const BOOKWYRM = 'ability_bookworm_dragonfire';
const PLOT_ARMOR = 'ability_bookworm_knightbarrier';
const CAPTIVATING_READ = 'ability_bookworm_aoemagic';
const RALLYING_CHARGE = 'ability_bookworm_knightcharge';

describe('parseAbilityDetail', () => {
  it('reads the name, the properties and their spirit scaling', () => {
    const bookwyrm = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[BOOKWYRM]);

    expect(bookwyrm.className).toBe(BOOKWYRM);
    expect(bookwyrm.name).toBe('Bookwyrm');
    expect(bookwyrm.imageUrl).toMatch(/bookworm_dragon\.webp$/);
    expect(bookwyrm.properties.Damage).toMatchObject({
      value: '60',
      label: 'Damage',
      cssClass: 'tech_damage',
      spiritScale: 1.3,
    });
    expect(bookwyrm.properties.DPS?.spiritScale).toBe(0.3);
    expect(bookwyrm.properties.Radius?.value).toBe('4m');
  });

  it('leaves out the scaling of a property scaled by something else than the spirit power', () => {
    const bookwyrm = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[BOOKWYRM]);
    const plotArmor = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[PLOT_ARMOR]);

    // The cooldown scales with the cooldown reduction, not with the spirit power.
    expect(bookwyrm.properties.AbilityCooldown?.spiritScale).toBeNull();
    // A scale of 0 is no scaling.
    expect(plotArmor.properties.BonusFireRate?.spiritScale).toBeNull();
    // A scale tied to the spirit power by name counts.
    expect(plotArmor.properties.CombatBarrier?.spiritScale).toBe(1.5);
  });

  it('reads the three upgrade tiers, numbers made strings', () => {
    const bookwyrm = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[BOOKWYRM]);
    const plotArmor = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[PLOT_ARMOR]);

    expect(bookwyrm.tiers[0]).toEqual([
      { property: 'AbilityCooldown', bonus: '-12', addsToSpiritScale: false },
    ]);
    expect(bookwyrm.tiers[1]).toContainEqual({
      property: 'AbilityCharges',
      bonus: '1',
      addsToSpiritScale: false,
    });
    expect(plotArmor.tiers[0][1]).toEqual({
      property: 'BonusFireRate',
      bonus: '0.16',
      addsToSpiritScale: true,
    });
  });

  it('reads the important properties by block, with their titles, and the basic ones', () => {
    const bookwyrm = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[BOOKWYRM]);
    const rallyingCharge = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[RALLYING_CHARGE]);

    expect(bookwyrm.important).toEqual([
      {
        title: null,
        properties: [
          { property: 'Damage', statusEffect: null },
          { property: 'DPS', statusEffect: null },
          { property: 'GroundFlameDuration', statusEffect: null },
        ],
      },
    ]);
    expect(bookwyrm.basic).toEqual(['DragonTravelRange']);
    expect(rallyingCharge.important.map((block) => block.title)).toEqual([
      'On Enemy Hit:',
      'On Friendly Hit:',
    ]);
    expect(rallyingCharge.basic).toEqual(['MaxAmp', 'MaxAmpDistance']);
  });

  it('reads the status effect of an important property', () => {
    const captivatingRead = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english[CAPTIVATING_READ]);

    expect(captivatingRead.important[0]?.properties[1]).toEqual({
      property: 'StatusEffectImmobilize',
      statusEffect: {
        valueProperty: 'ImmobilizeDuration',
        iconUrl:
          'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/condition_immobilize.svg',
      },
    });
  });

  it('reads the texts in the language of the answer', () => {
    const bookwyrm = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.french[BOOKWYRM]);

    expect(bookwyrm.properties.Damage?.label).toBe('Dégâts');
    expect(bookwyrm.description).toContain('dégâts spirituels');
    expect(bookwyrm.tierDescriptions[0]).toContain('temps de récupération');
  });

  it('refuses an entry without upgrade tiers', () => {
    const entry = structuredClone(FIXTURE_PAIGE_ABILITIES.english[BOOKWYRM]) as Record<
      string,
      unknown
    >;
    entry.upgrades = [];

    expect(() => parseAbilityDetail(entry)).toThrow(AppError);
  });

  it('gives a value that its own schema accepts, so the cache can check it again', () => {
    const ability = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.french[RALLYING_CHARGE]);

    expect(abilityDetailSchema.parse(JSON.parse(JSON.stringify(ability)))).toEqual(ability);
  });
});

describe('parseWeaponDetail', () => {
  it("reads the numbers of Paige's weapon", () => {
    const weapon = parseWeaponDetail(FIXTURE_PAIGE_WEAPON);

    expect(weapon).toEqual({
      className: 'citadel_weapon_bookworm_set2',
      name: "Chapter's End",
      bulletDamage: 32,
      cycleTime: 0.5,
      clipSize: 14,
      reloadDuration: 2.5,
      bulletSpeed: 1710,
    });
    expect(weaponDetailSchema.parse(weapon)).toEqual(weapon);
  });

  it('refuses an entry without weapon numbers', () => {
    expect(() => parseWeaponDetail({ class_name: 'x', name: 'y' })).toThrow(AppError);
  });
});
