/**
 * Paige as deadlock-api describes her: her hero entry, her weapon and her four abilities, in English
 * and in French, as the per-entry asset endpoints answered on 2026-11-02.
 *
 * The answers are trimmed to the fields the app reads; the values are the real ones, so that the
 * tests check the stats and the upgrade tiers against the game. One inline icon of the descriptions
 * (the first) is kept whole, the others are stubbed: the description parser is tested on real markup
 * once, and the file stays small.
 *
 * @packageDocumentation
 */
import type { ApiLanguage } from '../../../core/deadlock-api/endpoints';

/** Paige's hero entry (`GET /v1/assets/heroes/67`), per language. */
export const FIXTURE_PAIGE_HERO: Readonly<Record<ApiLanguage, unknown>> = {
  english: {
    id: 67,
    name: 'Paige',
    tags: ['Helpful', 'Protector', 'Booksmart'],
    colors: {
      style_hex: '#258F63',
    },
    images: {
      name_image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/icons/heroes/hero_names/paige.svg',
      background_image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/backgrounds/patience_bg.png',
      background_image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/backgrounds/patience_bg.webp',
      icon_hero_card:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/bookworm_card.png',
      icon_hero_card_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/bookworm_card.webp',
    },
    starting_stats: {
      max_move_speed: {
        value: 6.9,
      },
      sprint_speed: {
        value: 3.5,
      },
      crouch_speed: {
        value: 4.75,
      },
      move_acceleration: {
        value: 4,
      },
      light_melee_damage: {
        value: 42,
      },
      heavy_melee_damage: {
        value: 120,
      },
      max_health: {
        value: 680,
      },
      weapon_power: {
        value: 0,
      },
      reload_speed: {
        value: 1,
      },
      weapon_power_scale: {
        value: 1,
      },
      proc_build_up_rate_scale: {
        value: 1,
      },
      stamina: {
        value: 3,
      },
      base_health_regen: {
        value: 2,
      },
      stamina_regen_per_second: {
        value: 0.222222,
      },
      ability_resource_max: {
        value: 0,
      },
      ability_resource_regen_per_second: {
        value: 0,
      },
      crit_damage_received_scale: {
        value: 1,
      },
      tech_duration: {
        value: 1,
      },
      tech_range: {
        value: 1,
      },
      ground_dash_distance_in_meters: {
        value: 10,
      },
      ground_dash_duration: {
        value: 0.72,
      },
      air_dash_distance_in_meters: {
        value: 8,
      },
      air_dash_duration: {
        value: 0.51,
      },
      ooc_health_regen: {
        value: 0,
      },
    },
    standard_level_up_upgrades: {
      MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL: 0.61,
      MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL_ALT_FIRE: 0,
      MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL: 31,
      MODIFIER_VALUE_BASE_MELEE_DAMAGE_FROM_LEVEL: 1.2,
      MODIFIER_VALUE_BONUS_ATTACK_RANGE: 0,
      MODIFIER_VALUE_BOON_COUNT: 1,
      MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST: 0,
      MODIFIER_VALUE_TECH_RESIST: 0,
      MODIFIER_VALUE_TECH_DAMAGE_MULTIPLIER: 0,
      MODIFIER_VALUE_TECH_POWER: 1.1,
      MODIFIER_VALUE_OUT_OF_COMBAT_HEALTH_REGEN: 0,
    },
    scaling_stats: {
      EHeavyMeleeDamage: {
        scaling_stat: 'ETechPower',
        scale: 0.45,
      },
    },
    items: {
      weapon_primary: 'citadel_weapon_bookworm_set2',
      signature1: 'ability_bookworm_dragonfire',
      signature2: 'ability_bookworm_knightbarrier',
      signature3: 'ability_bookworm_aoemagic',
      signature4: 'ability_bookworm_knightcharge',
    },
    shop_stat_display: {
      weapon_stats_display: {
        weapon_image:
          'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/guns/bookworm_gun.png',
        weapon_image_webp:
          'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/guns/bookworm_gun.webp',
      },
    },
  },
  french: {
    id: 67,
    name: 'Paige',
    tags: ['Utile', 'Protectrice', 'Érudite'],
    colors: {
      style_hex: '#258F63',
    },
    images: {
      name_image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/icons/heroes/hero_names/paige.svg',
      background_image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/backgrounds/patience_bg.png',
      background_image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/backgrounds/patience_bg.webp',
      icon_hero_card:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/bookworm_card.png',
      icon_hero_card_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/bookworm_card.webp',
    },
    starting_stats: {
      max_move_speed: {
        value: 6.9,
      },
      sprint_speed: {
        value: 3.5,
      },
      crouch_speed: {
        value: 4.75,
      },
      move_acceleration: {
        value: 4,
      },
      light_melee_damage: {
        value: 42,
      },
      heavy_melee_damage: {
        value: 120,
      },
      max_health: {
        value: 680,
      },
      weapon_power: {
        value: 0,
      },
      reload_speed: {
        value: 1,
      },
      weapon_power_scale: {
        value: 1,
      },
      proc_build_up_rate_scale: {
        value: 1,
      },
      stamina: {
        value: 3,
      },
      base_health_regen: {
        value: 2,
      },
      stamina_regen_per_second: {
        value: 0.222222,
      },
      ability_resource_max: {
        value: 0,
      },
      ability_resource_regen_per_second: {
        value: 0,
      },
      crit_damage_received_scale: {
        value: 1,
      },
      tech_duration: {
        value: 1,
      },
      tech_range: {
        value: 1,
      },
      ground_dash_distance_in_meters: {
        value: 10,
      },
      ground_dash_duration: {
        value: 0.72,
      },
      air_dash_distance_in_meters: {
        value: 8,
      },
      air_dash_duration: {
        value: 0.51,
      },
      ooc_health_regen: {
        value: 0,
      },
    },
    standard_level_up_upgrades: {
      MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL: 0.61,
      MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL_ALT_FIRE: 0,
      MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL: 31,
      MODIFIER_VALUE_BASE_MELEE_DAMAGE_FROM_LEVEL: 1.2,
      MODIFIER_VALUE_BONUS_ATTACK_RANGE: 0,
      MODIFIER_VALUE_BOON_COUNT: 1,
      MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST: 0,
      MODIFIER_VALUE_TECH_RESIST: 0,
      MODIFIER_VALUE_TECH_DAMAGE_MULTIPLIER: 0,
      MODIFIER_VALUE_TECH_POWER: 1.1,
      MODIFIER_VALUE_OUT_OF_COMBAT_HEALTH_REGEN: 0,
    },
    scaling_stats: {
      EHeavyMeleeDamage: {
        scaling_stat: 'ETechPower',
        scale: 0.45,
      },
    },
    items: {
      weapon_primary: 'citadel_weapon_bookworm_set2',
      signature1: 'ability_bookworm_dragonfire',
      signature2: 'ability_bookworm_knightbarrier',
      signature3: 'ability_bookworm_aoemagic',
      signature4: 'ability_bookworm_knightcharge',
    },
    shop_stat_display: {
      weapon_stats_display: {
        weapon_image:
          'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/guns/bookworm_gun.png',
        weapon_image_webp:
          'https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/guns/bookworm_gun.webp',
      },
    },
  },
};

/** Paige's weapon (`GET /v1/assets/items/citadel_weapon_bookworm_set2`), in English. */
export const FIXTURE_PAIGE_WEAPON: unknown = {
  class_name: 'citadel_weapon_bookworm_set2',
  name: "Chapter's End",
  weapon_info: {
    bullet_damage: 32,
    cycle_time: 0.5,
    clip_size: 14,
    reload_duration: 2.5,
    bullet_speed: 1710,
  },
};

/** Paige's four abilities (`GET /v1/assets/items/{class_name}`), per language and class name. */
export const FIXTURE_PAIGE_ABILITIES: Readonly<
  Record<ApiLanguage, Readonly<Record<string, unknown>>>
> = {
  english: {
    ability_bookworm_dragonfire: {
      class_name: 'ability_bookworm_dragonfire',
      name: 'Bookwyrm',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_dragon.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_dragon.webp',
      description: {
        desc: 'Conjure a dragon that appears at the target location before flying forward, dealing <svg width="128" height="128" viewBox="0 0 128 128" fill="white" xmlns="http://www.w3.org/2000/svg">\n<path d="M53.7875 20.0238C48.6533 13.3022 40.8042 9 32.0027 9C16.5345 9 4 22.2789 4 38.6558C4 38.7707 4.00052 38.8854 4.00155 39H91.8416L94.7229 33.1618C97.2906 27.9591 104.71 27.9591 107.277 33.1618L110.159 39H115.998C115.999 38.8854 116 38.7707 116 38.6558C116 22.2789 103.466 9 87.9973 9C79.1958 9 71.3467 13.3022 66.2125 20.0238C65.7565 20.6214 65.336 21.1783 64.9462 21.6946C62.4734 24.9699 61.2367 26.6078 59.9993 26.6084C58.7614 26.609 57.5227 24.9711 55.0449 21.6946C54.6545 21.1783 54.2333 20.6214 53.7766 20.0238H53.7875Z" fill="white"/>\n<path d="M79.7015 79L79.5588 79.8323C78.7516 84.5386 82.6742 88.3253 86.9508 88.0132C86.8571 88.1111 86.7634 88.209 86.6696 88.3069C78.1991 97.1552 69.4174 106.328 62.6218 116.742C61.1111 119.051 58.8889 119.051 57.3782 116.742C50.5788 106.325 41.7966 97.1509 33.3264 88.303C30.3317 85.1748 27.3761 82.0873 24.5608 79H79.7015Z" fill="white"/>\n<path fill-rule="evenodd" clip-rule="evenodd" d="M101.901 35.5496C101.512 34.8168 100.488 34.8168 100.099 35.5497L93.0406 48.845C92.8929 49.123 92.6315 49.3183 92.3283 49.3766L77.8385 52.1641C77.0398 52.3178 76.7233 53.3185 77.2815 53.9252L87.4091 64.9295C87.6209 65.1597 87.7208 65.4756 87.6812 65.7898L85.7842 80.8078C85.6796 81.6357 86.5083 82.2542 87.2424 81.8963L100.56 75.402C100.838 75.2662 101.162 75.2662 101.44 75.402L114.758 81.8963C115.492 82.2542 116.32 81.6357 116.216 80.8078L114.319 65.7898C114.279 65.4756 114.379 65.1597 114.591 64.9295L124.718 53.9252C125.277 53.3185 124.96 52.3178 124.161 52.1641L109.672 49.3766C109.369 49.3183 109.107 49.123 108.959 48.845L101.901 35.5496ZM100.036 43.0789C100.366 42.1579 101.634 42.1579 101.964 43.0789L105.019 51.6179C105.01 51.6983 105.017 51.7822 105.041 51.8662L107.687 61.1634C107.817 61.6217 108.371 61.7807 108.714 61.4584L111.336 58.9947C111.498 58.8428 111.571 58.6153 111.528 58.3944L110.687 53.9877H117.422C118.389 53.9877 118.82 55.2373 118.067 55.8622L110.702 61.9792C110.601 61.9949 110.502 62.0365 110.413 62.1066L102.948 68.0247C102.581 68.3164 102.638 68.9036 103.055 69.1143L106.244 70.7259C106.44 70.8252 106.673 70.8121 106.858 70.6913L110.254 68.4723L112.085 75.0776C112.35 76.0329 111.299 76.8003 110.508 76.2296L101.591 69.8003C101.471 69.7136 101.337 69.6563 101.199 69.6285L95.0376 65.3393C94.6474 65.0677 94.116 65.3179 94.0614 65.7987L93.6534 69.3978C93.6281 69.6213 93.718 69.8423 93.8907 69.9808L96.868 72.3692L91.5448 76.2279C90.7554 76.8001 89.7037 76.0372 89.9645 75.0816L92.6557 65.2197C92.6717 65.1902 92.6845 65.1581 92.6935 65.1237L95.058 56.0862C95.1347 55.7934 94.8946 55.5156 94.6024 55.5592L90.6768 56.1448C90.5236 56.1678 90.3959 56.2773 90.3466 56.428L89.0988 60.2424L83.9931 56.1163C83.2355 55.5041 83.6428 54.2537 84.6065 54.2331L94.8405 54.0152C94.8711 54.0191 94.9023 54.0206 94.934 54.0198L103.141 53.8011C103.588 53.7892 103.88 53.3157 103.7 52.8958L102.212 49.4285C102.111 49.1944 101.886 49.0435 101.637 49.0435H97.9024L100.036 43.0789Z" fill="white"/>\n<path d="M67 57C68.1046 57 69 57.8954 69 59C69 60.1046 68.1046 61 67 61H7C5.89543 61 5 60.1046 5 59C5 57.8954 5.89543 57 7 57H67Z" fill="white"/>\n</svg>\n<span class="inline-attribute-label SpiritDamage">spirit damage</span> and leaving a burning path in its trail.',
        t1_desc: '<span class="highlight">-12s</span> Cooldown',
        t2_desc:
          '<span class="highlight">+1.0</span> Charge<br><span class="highlight">+2s</span> Trail Duration <br><span class="highlight">+1m</span> Radius<br>',
        t3_desc:
          '<span class="highlight">+12m</span> Travel Range<br><span class="highlight">+100.0</span> Damage <br><span class="highlight">+30.0</span> DPS',
      },
      properties: {
        AbilityCooldown: {
          value: '33',
          label: 'Cooldown',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '5',
          label: 'Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '0',
          label: 'Cast Range',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0.1',
          label: 'Cast Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0',
          label: 'Channel Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0',
        },
        AbilityCharges: {
          value: '1',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '7',
          label: 'Charge Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '-1',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Spirit Power',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Weapon Damage',
          postfix: '%',
        },
        DPS: {
          value: '30',
          label: 'Damage Per Second',
          postfix: '',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 0.3,
          },
        },
        TickRate: {
          value: '0.3',
        },
        StartupDelay: {
          value: '0.3',
        },
        TechArmorDamageReduction: {
          value: '0',
          label: 'Spirit Resist',
          postfix: '%',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_spirit_color.svg',
          css_class: 'tech_armor_down',
        },
        DebuffDuration: {
          value: '1.5',
          label: 'Slow Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        DragonSearchRadius: {
          value: '8.5m',
        },
        DragonConeRange: {
          value: '5m',
        },
        DragonUpwardSpeed: {
          value: '400',
        },
        GroundFlameDuration: {
          value: '3.0',
          label: 'Trail Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        Damage: {
          value: '60',
          label: 'Damage',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 1.3,
          },
        },
        Radius: {
          value: '4m',
          label: 'Radius',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
        DragonSearchTickRate: {
          value: '0.1',
        },
        GroundAuraSpacing: {
          value: '2m',
        },
        AuraLingerDuration: {
          value: '0.1',
        },
        DragonTravelRange: {
          value: '20m',
          label: 'Dragon Travel Range',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
        DragonRangePerSecond: {
          value: '500',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'AbilityCooldown',
              bonus: '-12',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'GroundFlameDuration',
              bonus: '2',
            },
            {
              name: 'Radius',
              bonus: '1m',
            },
            {
              name: 'AbilityCharges',
              bonus: 1,
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'Damage',
              bonus: 100,
            },
            {
              name: 'DPS',
              bonus: 30,
            },
            {
              name: 'DragonTravelRange',
              bonus: '12m',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {
            properties_block: [
              {
                properties: [
                  {
                    important_property: 'Damage',
                  },
                  {
                    important_property: 'DPS',
                  },
                  {
                    important_property: 'GroundFlameDuration',
                  },
                ],
              },
            ],
            basic_properties: ['DragonTravelRange'],
          },
        ],
      },
    },
    ability_bookworm_knightbarrier: {
      class_name: 'ability_bookworm_knightbarrier',
      name: 'Plot Armor',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_defendandfight.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_defendandfight.webp',
      description: {
        desc: 'Grant an ally a <img src="https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_bullet_armor.png" class="inline-attribute CombatBarrier" alt="barrier"/><span class="inline-attribute-label CombatBarrier" style="color: #FFEFD7;">barrier</span>. While the barrier holds, they gain <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label BonusWeaponDamage">bonus weapon damage</span>.',
        t1_desc: 'On Barrier: <span class="highlight">+14%</span> Fire Rate',
        t2_desc:
          '<span class="highlight">+100</span> Barrier and <span class="highlight">+2s</span> Duration',
        t3_desc:
          'Affects up to <span class="highlight">2</span> additional allies.<br>Increases barrier scaling.',
      },
      properties: {
        AbilityCooldown: {
          value: 28,
          label: 'Cooldown',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '5',
          label: 'Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '35m',
          label: 'Cast Range',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0.1',
          label: 'Cast Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0',
          label: 'Channel Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0.2',
        },
        AbilityCharges: {
          value: '0',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '0',
          label: 'Charge Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '-1',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Spirit Power',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Weapon Damage',
          postfix: '%',
        },
        CombatBarrier: {
          value: '125',
          label: 'Barrier',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_bullet_color.svg',
          css_class: 'bullet_armor_up',
          scale_function: {
            stat_scale: 1.5,
            specific_stat_scale_type: 'ETechPower',
          },
        },
        BulletResist: {
          value: '0',
          label: 'Bullet Resist',
          postfix: '%',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_bullet_color.svg',
          css_class: 'bullet_armor_up',
        },
        BonusFireRate: {
          value: '0',
          label: 'Fire Rate',
          postfix: '%',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/fire_rate.svg',
          css_class: 'fire_rate',
          scale_function: {
            stat_scale: 0,
            specific_stat_scale_type: 'ETechPower',
          },
        },
        PushForce: {
          value: '900',
        },
        Damage: {
          value: '0',
          label: 'Damage',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
        },
        DebuffDuration: {
          value: '0',
          label: 'Debuff Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        BaseAttackDamagePercent: {
          value: '25',
          label: 'Weapon Damage',
          postfix: '%',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_bullet_color.svg',
          css_class: 'bullet_damage',
          scale_function: {
            stat_scale: 0.3,
          },
        },
        ShoveRadius: {
          value: '6m',
          label: 'Shove Radius',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
        BonusTargets: {
          value: '0',
        },
        BonusTargetRadius: {
          value: '30m',
        },
        BonusTargetsBarrierPercentage: {
          value: '0',
        },
        BonusSpiritDamagePercent: {
          value: '15',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'BonusFireRate',
              bonus: '14',
            },
            {
              name: 'BonusFireRate',
              bonus: 0.16,
              scale_stat_filter: 'ETechPower',
              upgrade_type: 'EAddToScale',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'CombatBarrier',
              bonus: '100',
            },
            {
              name: 'AbilityDuration',
              bonus: '2',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'CombatBarrier',
              bonus: 0.5,
              scale_stat_filter: 'ETechPower',
              upgrade_type: 'EAddToScale',
            },
            {
              name: 'BonusTargets',
              bonus: '2',
            },
            {
              name: 'BonusTargetsBarrierPercentage',
              bonus: '100',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {
            properties_block: [
              {
                properties: [
                  {
                    important_property: 'CombatBarrier',
                  },
                  {
                    important_property: 'BaseAttackDamagePercent',
                  },
                  {
                    important_property: 'BonusFireRate',
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    ability_bookworm_aoemagic: {
      class_name: 'ability_bookworm_aoemagic',
      name: 'Captivating Read',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_blindinglight.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_blindinglight.webp',
      description: {
        desc: 'Target an area with latent magic, applying <img src="https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_slow_large.png" class="inline-attribute Slow" alt="slow"/><span class="inline-attribute-label Slow">slow</span>. <br><br>The magic detonates after a delay, dealing <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label SpiritDamage">spirit damage</span> and applying <img src="https://assets-bucket.deadlock-api.com/assets-api-res/images/hud/modifiers/immobilize.png" class="inline-attribute Immobilize" alt="immobilize"/><span class="inline-attribute-label Immobilize" style="color: #FFEFD7;">immobilize</span>.',
        t3_desc:
          '<span class="highlight">+2m</span> Radius<br>On Hit: Reduce Spirit Resist by <span class="highlight">-18%</span> for <span class="highlight">6s</span>',
      },
      properties: {
        AbilityCooldown: {
          value: '30',
          label: 'Cooldown',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '0',
          label: 'Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '30m',
          label: 'Cast Range',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0.15',
          label: 'Cast Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0',
          label: 'Channel Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0',
        },
        AbilityCharges: {
          value: '0',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '-1.0',
          label: 'Charge Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '-1',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Spirit Power',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Weapon Damage',
          postfix: '%',
        },
        Damage: {
          value: '90',
          label: 'Damage',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 1.3,
          },
        },
        Radius: {
          value: '7.5m',
          label: 'Radius',
          postfix: 'm',
        },
        DetonationDelay: {
          value: '1.25',
        },
        ImmobilizeDuration: {
          value: '1.0',
          label: 'Immobilize Duration',
          postfix: 's',
        },
        SlowDuration: {
          value: '0.5',
          label: 'Slow Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        SlowPercent: {
          value: '36',
          label: 'Move Speed',
          postfix: '%',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/condition_slow.svg',
          css_class: 'slow',
        },
        Height: {
          value: '8m',
        },
        DebuffDuration: {
          value: '0',
          label: 'Debuff Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        TechArmorDamageReduction: {
          value: '0',
          label: 'Spirit Resist',
          postfix: '%',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_spirit_color.svg',
          css_class: 'tech_armor_down',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'AbilityCooldown',
              bonus: '-14',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'ImmobilizeDuration',
              bonus: '1',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'TechArmorDamageReduction',
              bonus: '-18',
            },
            {
              name: 'DebuffDuration',
              bonus: '6',
            },
            {
              name: 'Radius',
              bonus: '2m',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {
            properties_block: [
              {
                loc_string: 'On Hit:',
                properties: [
                  {
                    important_property: 'Damage',
                  },
                  {
                    important_property: 'StatusEffectImmobilize',
                    status_effect_value: 'ImmobilizeDuration',
                    important_property_icon:
                      'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/condition_immobilize.svg',
                  },
                  {
                    important_property: 'TechArmorDamageReduction',
                  },
                ],
              },
            ],
            basic_properties: ['SlowPercent', 'SlowDuration'],
          },
        ],
      },
    },
    ability_bookworm_knightcharge: {
      class_name: 'ability_bookworm_knightcharge',
      name: 'Rallying Charge',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_charge.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_charge.webp',
      description: {
        desc: 'Release a wave of spectral knights and steeds that charge across the <span class="highlight">entire city</span>, <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label Healing" style="color: #0F9;">healing</span> allies and dealing <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label SpiritDamage">spirit damage</span> to enemies. <br><br>The strength of the <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label Heal" style="color: #0F9;">heal</span> and <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label SpiritDamage">spirit damage</span> is amplified as the knights travel further.',
        t2_desc:
          'Increase width by <span class="highlight">+4 Steeds</span><br><span class="highlight">-45</span> Cooldown',
        t3_desc:
          '<span class="highlight">+160.0</span> Damage <br><span class="highlight">+0.5s</span> Stun Duration<br><span class="highlight">+70%</span> Max Amp',
      },
      properties: {
        AbilityCooldown: {
          value: '210',
          label: 'Cooldown',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '13',
          label: 'Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '600m',
          label: 'Cast Range',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0',
          label: 'Cast Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0.7',
          label: 'Channel Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0',
        },
        AbilityCharges: {
          value: '0',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '-1.0',
          label: 'Charge Delay',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '1.3m',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Spirit Power',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Weapon Damage',
          postfix: '%',
        },
        Damage: {
          value: '125',
          label: 'Damage',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 1,
          },
        },
        GroundStickHeight: {
          value: '0.05m',
        },
        TossUpSpeed: {
          value: '600',
        },
        KnightChargeWidth: {
          value: '1.7m',
        },
        SlowDuration: {
          value: '0',
          label: 'Slow Duration',
          postfix: 's',
        },
        DebuffDuration: {
          value: '0',
          label: 'Debuff Duration',
          postfix: 's',
        },
        KnightCount: {
          value: '5',
          label: 'Knights & Steeds Released',
        },
        KnightPositionSpread: {
          value: '1.8m',
          label: 'Knight Spread',
          postfix: 'm',
        },
        BonusMoveSpeed: {
          value: '5m',
          label: 'Move Speed',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        CombatBarrier: {
          value: '0',
          label: 'Barrier',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_bullet_color.svg',
          css_class: 'bullet_armor_up',
        },
        BuffDuration: {
          value: '9',
          label: 'Buff Duration',
          postfix: 's',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        AllyRadius: {
          value: '4m',
        },
        AllyHeight: {
          value: '10m',
        },
        KnightWhiskerLength: {
          value: '300',
        },
        KnightWhiskerSide: {
          value: '50',
        },
        KnightWhiskerStrength: {
          value: '0.2',
        },
        TossBackSpeed: {
          value: '100',
        },
        KnightPositionStagger: {
          value: '-4m',
        },
        StunDuration: {
          value: '1.0',
          label: 'Stun Duration',
          postfix: 's',
        },
        HealAmount: {
          value: '125',
          label: 'Heal Amount',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/heal.svg',
          css_class: 'healing',
          scale_function: {
            stat_scale: 1.6,
          },
        },
        KnightNavSearchDistance: {
          value: '10m',
        },
        KnightDistanceAboveGround: {
          value: '0m',
        },
        KnightChargeHeight: {
          value: '6m',
        },
        GravityAcceleration: {
          value: '-1900',
        },
        KnightMaxJumpHeight: {
          value: '30m',
        },
        KnightMaxFallHeight: {
          value: '-35m',
        },
        KnightNavForwardDistance: {
          value: '8m',
        },
        KnightJumpSpeed: {
          value: '900',
        },
        AirDrag: {
          value: '0.8',
        },
        FallSpeedMax: {
          value: '20',
        },
        WaveCount: {
          value: '2',
        },
        WavePositionStagger: {
          value: '-15m',
        },
        KnightBonusPerWave: {
          value: '-99',
        },
        KnightCountInFirstWave: {
          value: '5',
        },
        CancelCooldownRefundPercentage: {
          value: '50',
        },
        TargetFindingDelay: {
          value: '0.04',
        },
        MaxAmp: {
          value: '100',
          label: 'Max Amp',
          postfix: '%',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_crit.svg',
          css_class: 'damage',
        },
        MaxAmpDistance: {
          value: '250m',
          label: 'Distance for Max Amp',
          postfix: 'm',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'HealAmount',
              bonus: '150',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'KnightCount',
              bonus: '4',
            },
            {
              name: 'KnightCountInFirstWave',
              bonus: '4',
            },
            {
              name: 'AbilityCooldown',
              bonus: '-45',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'Damage',
              bonus: 160,
            },
            {
              name: 'StunDuration',
              bonus: '0.5',
            },
            {
              name: 'MaxAmp',
              bonus: '70',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {},
          {
            properties_block: [
              {
                loc_string: 'On Enemy Hit:',
                properties: [
                  {
                    important_property: 'Damage',
                  },
                  {
                    important_property: 'StatusEffectStun',
                    status_effect_value: 'StunDuration',
                    important_property_icon:
                      'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/condition_stun.svg',
                  },
                ],
              },
            ],
          },
          {
            properties_block: [
              {
                loc_string: 'On Friendly Hit:',
                properties: [
                  {
                    important_property: 'HealAmount',
                  },
                  {
                    important_property: 'BonusMoveSpeed',
                  },
                ],
              },
            ],
            basic_properties: ['MaxAmp', 'MaxAmpDistance'],
          },
        ],
      },
    },
  },
  french: {
    ability_bookworm_dragonfire: {
      class_name: 'ability_bookworm_dragonfire',
      name: 'Vouivre savante',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_dragon.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_dragon.webp',
      description: {
        desc: 'Paige invoque un dragon qui apparait à l\'endroit ciblé et qui s\'envole vers l\'avant en infligeant des <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label SpiritDamage">dégâts spirituels</span> et en laissant derrière lui une trainée de flammes.',
        t1_desc: '<span class="highlight">-12 s</span> de temps de récupération',
        t2_desc:
          '<span class="highlight">+1.0</span> charge<br><span class="highlight">+2 s</span> de durée de la trainée<br><span class="highlight">+1 m</span> de rayon',
        t3_desc:
          '<span class="highlight">+12 m</span> de portée<br><span class="highlight">+100.0</span> de dégâts <br><span class="highlight">+30.0</span> de DPS',
      },
      properties: {
        AbilityCooldown: {
          value: '33',
          label: 'Temps de récupération',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '5',
          label: 'Durée',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '0',
          label: "Portée d'incantation",
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0.1',
          label: "Délai d'incantation",
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0',
          label: 'Durée de canalisation',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0',
        },
        AbilityCharges: {
          value: '1',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '7',
          label: 'Délai entre les charges',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '-1',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Pouvoir spirituel',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Dégâts des armes',
          postfix: ' %',
        },
        DPS: {
          value: '30',
          label: 'DPS',
          postfix: '',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 0.3,
          },
        },
        TickRate: {
          value: '0.3',
        },
        StartupDelay: {
          value: '0.3',
        },
        TechArmorDamageReduction: {
          value: '0',
          label: 'Résistance spirituelle',
          postfix: ' %',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_spirit_color.svg',
          css_class: 'tech_armor_down',
        },
        DebuffDuration: {
          value: '1.5',
          label: 'Durée de ralentissement',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        DragonSearchRadius: {
          value: '8.5m',
        },
        DragonConeRange: {
          value: '5m',
        },
        DragonUpwardSpeed: {
          value: '400',
        },
        GroundFlameDuration: {
          value: '3.0',
          label: 'Durée de la trainée',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        Damage: {
          value: '60',
          label: 'Dégâts',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 1.3,
          },
        },
        Radius: {
          value: '4m',
          label: 'Rayon',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
        DragonSearchTickRate: {
          value: '0.1',
        },
        GroundAuraSpacing: {
          value: '2m',
        },
        AuraLingerDuration: {
          value: '0.1',
        },
        DragonTravelRange: {
          value: '20m',
          label: 'Distance de déplacement du dragon',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
        DragonRangePerSecond: {
          value: '500',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'AbilityCooldown',
              bonus: '-12',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'GroundFlameDuration',
              bonus: '2',
            },
            {
              name: 'Radius',
              bonus: '1m',
            },
            {
              name: 'AbilityCharges',
              bonus: 1,
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'Damage',
              bonus: 100,
            },
            {
              name: 'DPS',
              bonus: 30,
            },
            {
              name: 'DragonTravelRange',
              bonus: '12m',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {
            properties_block: [
              {
                properties: [
                  {
                    important_property: 'Damage',
                  },
                  {
                    important_property: 'DPS',
                  },
                  {
                    important_property: 'GroundFlameDuration',
                  },
                ],
              },
            ],
            basic_properties: ['DragonTravelRange'],
          },
        ],
      },
    },
    ability_bookworm_knightbarrier: {
      class_name: 'ability_bookworm_knightbarrier',
      name: 'Immunité narrative',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_defendandfight.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_defendandfight.webp',
      description: {
        desc: 'Paige confère une <img src="https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_bullet_armor.png" class="inline-attribute CombatBarrier" alt="protection"/><span class="inline-attribute-label CombatBarrier" style="color: #FFEFD7;">protection</span> à une unité alliée. Tant que la protection est active, l\'occultiste inflige des <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label BonusWeaponDamage">dégâts des armes bonus</span>.',
        t1_desc: 'Pendant la protection : <span class="highlight">+14 %</span> de cadence de tir',
        t2_desc:
          '<span class="highlight">+100</span> de protection et <span class="highlight">+2 s</span> de durée',
        t3_desc:
          'Affecte jusqu\'à <span class="highlight">2</span> unités alliées supplémentaires<br>Augmente le multiplicateur de protection',
      },
      properties: {
        AbilityCooldown: {
          value: 28,
          label: 'Temps de récupération',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '5',
          label: 'Durée',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '35m',
          label: "Portée d'incantation",
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0.1',
          label: "Délai d'incantation",
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0',
          label: 'Durée de canalisation',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0.2',
        },
        AbilityCharges: {
          value: '0',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '0',
          label: 'Délai entre les charges',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '-1',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Pouvoir spirituel',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Dégâts des armes',
          postfix: ' %',
        },
        CombatBarrier: {
          value: '125',
          label: 'Protection',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_bullet_color.svg',
          css_class: 'bullet_armor_up',
          scale_function: {
            stat_scale: 1.5,
            specific_stat_scale_type: 'ETechPower',
          },
        },
        BulletResist: {
          value: '0',
          label: 'Résistance aux balles',
          postfix: ' %',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_bullet_color.svg',
          css_class: 'bullet_armor_up',
        },
        BonusFireRate: {
          value: '0',
          label: 'Cadence de tir',
          postfix: ' %',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/fire_rate.svg',
          css_class: 'fire_rate',
          scale_function: {
            stat_scale: 0,
            specific_stat_scale_type: 'ETechPower',
          },
        },
        PushForce: {
          value: '900',
        },
        Damage: {
          value: '0',
          label: 'Dégâts',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
        },
        DebuffDuration: {
          value: '0',
          label: "Durée de l'effet négatif",
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        BaseAttackDamagePercent: {
          value: '25',
          label: 'Dégâts des armes',
          postfix: ' %',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_bullet_color.svg',
          css_class: 'bullet_damage',
          scale_function: {
            stat_scale: 0.3,
          },
        },
        ShoveRadius: {
          value: '6m',
          label: 'Rayon de la poussée',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
        BonusTargets: {
          value: '0',
        },
        BonusTargetRadius: {
          value: '30m',
        },
        BonusTargetsBarrierPercentage: {
          value: '0',
        },
        BonusSpiritDamagePercent: {
          value: '15',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'BonusFireRate',
              bonus: '14',
            },
            {
              name: 'BonusFireRate',
              bonus: 0.16,
              scale_stat_filter: 'ETechPower',
              upgrade_type: 'EAddToScale',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'CombatBarrier',
              bonus: '100',
            },
            {
              name: 'AbilityDuration',
              bonus: '2',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'CombatBarrier',
              bonus: 0.5,
              scale_stat_filter: 'ETechPower',
              upgrade_type: 'EAddToScale',
            },
            {
              name: 'BonusTargets',
              bonus: '2',
            },
            {
              name: 'BonusTargetsBarrierPercentage',
              bonus: '100',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {
            properties_block: [
              {
                properties: [
                  {
                    important_property: 'CombatBarrier',
                  },
                  {
                    important_property: 'BaseAttackDamagePercent',
                  },
                  {
                    important_property: 'BonusFireRate',
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    ability_bookworm_aoemagic: {
      class_name: 'ability_bookworm_aoemagic',
      name: 'Récit captivant',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_blindinglight.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_blindinglight.webp',
      description: {
        desc: 'Paige ensorcelle une zone, infligeant un <img src="https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_slow_large.png" class="inline-attribute Slow" alt="ralentissement"/><span class="inline-attribute-label Slow">ralentissement</span>. <br><br>Les particules de magie explosent après un certain temps, ce qui inflige des <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label SpiritDamage">dégâts spirituels</span> et une <img src="https://assets-bucket.deadlock-api.com/assets-api-res/images/hud/modifiers/immobilize.png" class="inline-attribute Immobilize" alt="immobilisation"/><span class="inline-attribute-label Immobilize" style="color: #FFEFD7;">immobilisation</span>.',
        t3_desc:
          '<span class="highlight">+2 m</span> de rayon<br>À l\'impact : réduit la résistance spirituelle de <span class="highlight">-18 %</span> pendant <span class="highlight">6 s</span>',
      },
      properties: {
        AbilityCooldown: {
          value: '30',
          label: 'Temps de récupération',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '0',
          label: 'Durée',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '30m',
          label: "Portée d'incantation",
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0.15',
          label: "Délai d'incantation",
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0',
          label: 'Durée de canalisation',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0',
        },
        AbilityCharges: {
          value: '0',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '-1.0',
          label: 'Délai entre les charges',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '-1',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Pouvoir spirituel',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Dégâts des armes',
          postfix: ' %',
        },
        Damage: {
          value: '90',
          label: 'Dégâts',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 1.3,
          },
        },
        Radius: {
          value: '7.5m',
          label: 'Rayon',
          postfix: ' m',
        },
        DetonationDelay: {
          value: '1.25',
        },
        ImmobilizeDuration: {
          value: '1.0',
          label: "Durée d'immobilisation",
          postfix: ' s',
        },
        SlowDuration: {
          value: '0.5',
          label: 'Durée de ralentissement',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        SlowPercent: {
          value: '36',
          label: 'Vit. de déplacement',
          postfix: ' %',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/condition_slow.svg',
          css_class: 'slow',
        },
        Height: {
          value: '8m',
        },
        DebuffDuration: {
          value: '0',
          label: "Durée de l'effet négatif",
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        TechArmorDamageReduction: {
          value: '0',
          label: 'Résistance spirituelle',
          postfix: ' %',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_spirit_color.svg',
          css_class: 'tech_armor_down',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'AbilityCooldown',
              bonus: '-14',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'ImmobilizeDuration',
              bonus: '1',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'TechArmorDamageReduction',
              bonus: '-18',
            },
            {
              name: 'DebuffDuration',
              bonus: '6',
            },
            {
              name: 'Radius',
              bonus: '2m',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {
            properties_block: [
              {
                loc_string: "À l'impact :",
                properties: [
                  {
                    important_property: 'Damage',
                  },
                  {
                    important_property: 'StatusEffectImmobilize',
                    status_effect_value: 'ImmobilizeDuration',
                    important_property_icon:
                      'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/condition_immobilize.svg',
                  },
                  {
                    important_property: 'TechArmorDamageReduction',
                  },
                ],
              },
            ],
            basic_properties: ['SlowPercent', 'SlowDuration'],
          },
        ],
      },
    },
    ability_bookworm_knightcharge: {
      class_name: 'ability_bookworm_knightcharge',
      name: 'Charge de ralliement',
      image:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_charge.png',
      image_webp:
        'https://assets-bucket.deadlock-api.com/assets-api-res/images/abilities/bookworm/bookworm_charge.webp',
      description: {
        desc: 'Paige libère une vague de chevaliers spectraux qui chargent sur <span class="highlight">l\'ensemble de la carte</span>. La capacité <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label Healing" style="color: #0F9;">soigne</span> les unités alliées et inflige des <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label SpiritDamage">dégâts spirituels</span> aux adversaires. <br><br>L\'efficacité des <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label Heal" style="color: #0F9;">soins</span> et des <svg width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h1"/></svg>\n<span class="inline-attribute-label SpiritDamage">dégâts spirituels</span> augmente en fonction de la distance parcourue par les spectres.',
        t2_desc:
          'Ajoute <span class="highlight">+4 chevaliers spectraux</span><br><span class="highlight">-45</span> de temps de récupération',
        t3_desc:
          '<span class="highlight">+160.0</span> de dégâts <br><span class="highlight">+0.5 s</span> de durée d\'étourdissement<br><span class="highlight">+70 %</span> d\'amplification max.',
      },
      properties: {
        AbilityCooldown: {
          value: '210',
          label: 'Temps de récupération',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/cooldown.svg',
          css_class: 'cooldown',
          scale_function: {
            specific_stat_scale_type: 'ETechCooldown',
          },
        },
        AbilityDuration: {
          value: '13',
          label: 'Durée',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
          scale_function: {
            specific_stat_scale_type: 'ETechDuration',
          },
        },
        AbilityCastRange: {
          value: '600m',
          label: "Portée d'incantation",
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/upgrades/property_range.svg',
          css_class: 'range',
          scale_function: {
            specific_stat_scale_type: 'ETechRange',
          },
        },
        AbilityUnitTargetLimit: {
          value: '1',
        },
        AbilityCastDelay: {
          value: '0',
          label: "Délai d'incantation",
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityChannelTime: {
          value: '0.7',
          label: 'Durée de canalisation',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityPostCastDuration: {
          value: '0',
        },
        AbilityCharges: {
          value: '0',
          label: 'Charges',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        AbilityCooldownBetweenCharge: {
          value: '-1.0',
          label: 'Délai entre les charges',
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/recharge.svg',
          css_class: 'charge_cooldown',
        },
        ChannelMoveSpeed: {
          value: '1.3m',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        AbilityResourceCost: {
          value: '0',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/images/upgrades/property_cast.png',
          css_class: 'cast',
        },
        TechPower: {
          value: '0',
          label: 'Pouvoir spirituel',
          postfix: '',
        },
        WeaponPower: {
          value: '0',
          label: 'Dégâts des armes',
          postfix: ' %',
        },
        Damage: {
          value: '125',
          label: 'Dégâts',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_magic_color.svg',
          css_class: 'tech_damage',
          scale_function: {
            stat_scale: 1,
          },
        },
        GroundStickHeight: {
          value: '0.05m',
        },
        TossUpSpeed: {
          value: '600',
        },
        KnightChargeWidth: {
          value: '1.7m',
        },
        SlowDuration: {
          value: '0',
          label: 'Durée de ralentissement',
          postfix: ' s',
        },
        DebuffDuration: {
          value: '0',
          label: "Durée de l'effet négatif",
          postfix: ' s',
        },
        KnightCount: {
          value: '5',
          label: 'Chevaliers et leurs montures invoqués',
        },
        KnightPositionSpread: {
          value: '1.8m',
          label: 'Zone du chevalier',
          postfix: ' m',
        },
        BonusMoveSpeed: {
          value: '5m',
          label: 'Vitesse de déplacement',
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/move_speed.svg',
          css_class: 'move_speed',
        },
        CombatBarrier: {
          value: '0',
          label: 'Protection',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/armor_bullet_color.svg',
          css_class: 'bullet_armor_up',
        },
        BuffDuration: {
          value: '9',
          label: "Durée de l'effet positif",
          postfix: ' s',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/duration.svg',
          css_class: 'duration',
        },
        AllyRadius: {
          value: '4m',
        },
        AllyHeight: {
          value: '10m',
        },
        KnightWhiskerLength: {
          value: '300',
        },
        KnightWhiskerSide: {
          value: '50',
        },
        KnightWhiskerStrength: {
          value: '0.2',
        },
        TossBackSpeed: {
          value: '100',
        },
        KnightPositionStagger: {
          value: '-4m',
        },
        StunDuration: {
          value: '1.0',
          label: "Durée d'étourdissement",
          postfix: ' s',
        },
        HealAmount: {
          value: '125',
          label: 'Soins',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/heal.svg',
          css_class: 'healing',
          scale_function: {
            stat_scale: 1.6,
          },
        },
        KnightNavSearchDistance: {
          value: '10m',
        },
        KnightDistanceAboveGround: {
          value: '0m',
        },
        KnightChargeHeight: {
          value: '6m',
        },
        GravityAcceleration: {
          value: '-1900',
        },
        KnightMaxJumpHeight: {
          value: '30m',
        },
        KnightMaxFallHeight: {
          value: '-35m',
        },
        KnightNavForwardDistance: {
          value: '8m',
        },
        KnightJumpSpeed: {
          value: '900',
        },
        AirDrag: {
          value: '0.8',
        },
        FallSpeedMax: {
          value: '20',
        },
        WaveCount: {
          value: '2',
        },
        WavePositionStagger: {
          value: '-15m',
        },
        KnightBonusPerWave: {
          value: '-99',
        },
        KnightCountInFirstWave: {
          value: '5',
        },
        CancelCooldownRefundPercentage: {
          value: '50',
        },
        TargetFindingDelay: {
          value: '0.04',
        },
        MaxAmp: {
          value: '100',
          label: 'Amplification max.',
          postfix: ' %',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/damage_crit.svg',
          css_class: 'damage',
        },
        MaxAmpDistance: {
          value: '250m',
          label: "Distance pour l'amplification max.",
          postfix: ' m',
          icon: 'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/range.svg',
          css_class: 'distance',
        },
      },
      upgrades: [
        {
          property_upgrades: [
            {
              name: 'HealAmount',
              bonus: '150',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'KnightCount',
              bonus: '4',
            },
            {
              name: 'KnightCountInFirstWave',
              bonus: '4',
            },
            {
              name: 'AbilityCooldown',
              bonus: '-45',
            },
          ],
        },
        {
          property_upgrades: [
            {
              name: 'Damage',
              bonus: 160,
            },
            {
              name: 'StunDuration',
              bonus: '0.5',
            },
            {
              name: 'MaxAmp',
              bonus: '70',
            },
          ],
        },
      ],
      tooltip_details: {
        info_sections: [
          {},
          {
            properties_block: [
              {
                loc_string: "À l'impact (adversaire) :",
                properties: [
                  {
                    important_property: 'Damage',
                  },
                  {
                    important_property: 'StatusEffectStun',
                    status_effect_value: 'StunDuration',
                    important_property_icon:
                      'https://assets-bucket.deadlock-api.com/assets-api-res/icons/icons/properties/condition_stun.svg',
                  },
                ],
              },
            ],
          },
          {
            properties_block: [
              {
                loc_string: "À l'impact (unité alliée) :",
                properties: [
                  {
                    important_property: 'HealAmount',
                  },
                  {
                    important_property: 'BonusMoveSpeed',
                  },
                ],
              },
            ],
            basic_properties: ['MaxAmp', 'MaxAmpDistance'],
          },
        ],
      },
    },
  },
};
