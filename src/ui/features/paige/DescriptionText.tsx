/**
 * The description of an ability, or the text of one of its upgrade tiers, rendered from the safe
 * nodes of `description-markup.ts`: never as HTML.
 *
 * The highlighted numbers are bold in the accent colour; the keywords the game colours (spirit
 * damage, healing…) take a colour of the app, and spirit damage its icon, as in the game.
 *
 * @packageDocumentation
 */
import { Fragment, useMemo } from 'react';
import { ASSET_IMAGE_ORIGIN } from '../../../core/deadlock-api/assets.schema';
import { parseDescription } from '../../../core/hero-page/description-markup';

/** The icon of spirit damage, the one keyword the game illustrates in Paige's descriptions. */
export const SPIRIT_DAMAGE_ICON = `${ASSET_IMAGE_ORIGIN}assets-api-res/icons/icons/properties/damage_magic_color.svg`;

/** The classes of the keywords the app colours; any other keyword is bold in the text colour. */
const KEYWORD_CLASSES: Readonly<Record<string, string>> = {
  SpiritDamage: 'font-bold text-stat-spirit',
  Healing: 'font-bold text-stat-vitality',
};

/** Props of {@link DescriptionText}. */
export interface DescriptionTextProps {
  /** The markup, as deadlock-api gives it. */
  readonly markup: string;
}

/**
 * A description, rendered from its safe nodes.
 *
 * @returns The texts, line breaks, highlights and keywords of the description, in order.
 */
export function DescriptionText({ markup }: DescriptionTextProps) {
  const nodes = useMemo(() => parseDescription(markup), [markup]);
  return (
    <>
      {nodes.map((node, index) => {
        // The nodes never change order for a given markup: their index is a stable key.
        const key = String(index);
        switch (node.kind) {
          case 'text':
            return <Fragment key={key}>{node.text}</Fragment>;
          case 'break':
            return <br key={key} />;
          case 'highlight':
            return (
              <strong key={key} className="text-accent-bright">
                {node.text}
              </strong>
            );
          case 'keyword':
            return (
              <span key={key} className={KEYWORD_CLASSES[node.keyword] ?? 'font-bold text-fg'}>
                {node.keyword === 'SpiritDamage' && (
                  <img
                    src={SPIRIT_DAMAGE_ICON}
                    alt=""
                    className="mr-0.5 inline-block size-4 align-[-0.15em]"
                  />
                )}
                {node.text}
              </span>
            );
        }
      })}
    </>
  );
}
