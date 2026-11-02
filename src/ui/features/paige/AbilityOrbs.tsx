/**
 * The four abilities of the Paige page: one sphere each, in Paige's colour, holding the ability's
 * icon, with its English name centred under it. A sphere is a button that opens the ability's
 * window.
 *
 * @packageDocumentation
 */
import type { CSSProperties } from 'react';
import type { AbilityPair } from '../../../services/paige-page.service';

/**
 * The sphere: a radial gradient of Paige's colour (the accent), lit from the top left, with a soft
 * glow. Set through the DOM by React, which the Content Security Policy allows.
 */
export const SPHERE_STYLE: CSSProperties = {
  background:
    'radial-gradient(circle at 35% 30%, var(--color-accent-bright) 0%, var(--color-accent) 45%, color-mix(in srgb, var(--color-accent) 35%, black) 100%)',
  boxShadow:
    '0 0 18px color-mix(in srgb, var(--color-accent) 50%, transparent), inset 0 -6px 12px rgb(0 0 0 / 0.4)',
};

/** Props of {@link AbilityOrbs}. */
export interface AbilityOrbsProps {
  /** The four abilities, in slot order. */
  readonly abilities: readonly AbilityPair[];
  /** Opens the window of the ability at this index. */
  readonly onSelect: (index: number) => void;
}

/**
 * The row of the four spheres, centred.
 *
 * @returns The spheres, as buttons named after their abilities.
 */
export function AbilityOrbs({ abilities, onSelect }: AbilityOrbsProps) {
  return (
    <ul className="flex justify-center gap-8">
      {abilities.map((ability, index) => (
        <li key={ability.english.className}>
          <button
            type="button"
            onClick={() => {
              onSelect(index);
            }}
            className="group flex w-32 flex-col items-center gap-1.5 rounded-lg"
          >
            <span
              aria-hidden="true"
              className="grid size-[4.625rem] place-items-center rounded-full transition-transform group-hover:scale-105"
              style={SPHERE_STYLE}
            >
              {ability.english.imageUrl !== null && (
                <img src={ability.english.imageUrl} alt="" className="size-11" />
              )}
            </span>
            {/* Ability names are never translated. */}
            <span lang="en" className="text-center text-sm font-bold">
              {ability.english.name}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
