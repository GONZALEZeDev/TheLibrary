/**
 * Tests of the validation of one hero entry (`GET /v1/assets/heroes/{hero_id}`).
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_PAIGE_HERO } from '../../adapters/dev/fixtures/paige.fixture';
import { AppError } from '../errors/app-error';
import { heroDetailSchema, parseHeroDetail } from './hero-detail.schema';

/** A copy of Paige's English entry that a test may change freely. */
function englishPaige(): Record<string, unknown> {
  return structuredClone(FIXTURE_PAIGE_HERO.english) as Record<string, unknown>;
}

describe('parseHeroDetail', () => {
  it("reads Paige's keywords in the language of the answer", () => {
    expect(parseHeroDetail(FIXTURE_PAIGE_HERO.french).tags).toEqual([
      'Utile',
      'Protectrice',
      'Érudite',
    ]);
    expect(parseHeroDetail(FIXTURE_PAIGE_HERO.english).tags).toEqual([
      'Helpful',
      'Protector',
      'Booksmart',
    ]);
  });

  it('reads her colour, base stats, gains per level and spirit scaling', () => {
    const hero = parseHeroDetail(FIXTURE_PAIGE_HERO.english);

    expect(hero.id).toBe(67);
    expect(hero.name).toBe('Paige');
    expect(hero.styleColor).toBe('#258F63');
    expect(hero.startingStats.max_health).toBe(680);
    expect(hero.startingStats.stamina_regen_per_second).toBeCloseTo(0.222222, 6);
    expect(hero.levelUpgrades.MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL).toBe(31);
    expect(hero.levelUpgrades.MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL).toBe(0.61);
    expect(hero.spiritScaling).toEqual({ EHeavyMeleeDamage: 0.45 });
  });

  it('reads her weapon and her four abilities by class name, in slot order', () => {
    const hero = parseHeroDetail(FIXTURE_PAIGE_HERO.english);

    expect(hero.weaponClass).toBe('citadel_weapon_bookworm_set2');
    expect(hero.abilityClasses).toEqual([
      'ability_bookworm_dragonfire',
      'ability_bookworm_knightbarrier',
      'ability_bookworm_aoemagic',
      'ability_bookworm_knightcharge',
    ]);
  });

  it('keeps the pictures that are on the asset bucket, WebP first', () => {
    const hero = parseHeroDetail(FIXTURE_PAIGE_HERO.english);

    expect(hero.nameImageUrl).toBe(
      'https://assets-bucket.deadlock-api.com/assets-api-res/icons/heroes/hero_names/paige.svg',
    );
    expect(hero.backgroundImageUrl).toMatch(/patience_bg\.webp$/);
    expect(hero.cardImageUrl).toMatch(/bookworm_card\.webp$/);
    expect(hero.weaponImageUrl).toMatch(/bookworm_gun\.webp$/);
  });

  it('drops a picture that points outside the asset bucket', () => {
    const entry = englishPaige();
    entry.images = { name_image: 'https://example.net/paige.svg' };

    const hero = parseHeroDetail(entry);

    expect(hero.nameImageUrl).toBeNull();
    expect(hero.backgroundImageUrl).toBeNull();
  });

  it('refuses a hero without its fourth ability', () => {
    const entry = englishPaige();
    const items = { ...(entry.items as Record<string, unknown>) };
    delete items.signature4;
    entry.items = items;

    expect(() => parseHeroDetail(entry)).toThrow(AppError);
    try {
      parseHeroDetail(entry);
    } catch (error) {
      expect((error as AppError).kind).toBe('invalid_payload');
    }
  });

  it('gives a value that its own schema accepts, so the cache can check it again', () => {
    const hero = parseHeroDetail(FIXTURE_PAIGE_HERO.french);

    expect(heroDetailSchema.parse(JSON.parse(JSON.stringify(hero)))).toEqual(hero);
  });
});
