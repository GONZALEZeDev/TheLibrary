/**
 * The cell of a damage source: its picture beside its name, and what it is for the weapon, the melee
 * attack and an item. The damage table of the match page and the damage tab of the review both start
 * a row with it, so that a source looks the same wherever the app lists it.
 *
 * - **The picture** is the one of the catalogue, decorative since the name stands beside it. A source
 *   with no picture, or whose picture cannot be loaded (offline, say), keeps a neutral square of the
 *   same size, so that the names of a list stay lined up.
 * - **The kind word** ("Weapon", "Melee", "Item") stands under the name. An ability needs none, and
 *   nor does a source that is none of the four kinds.
 *
 * The classes of the cell are exported ({@link SOURCE_CELL}): a table gives the first caption of its
 * header the same ones, so that the caption stands over the pictures. The other cells of a row are
 * the table's own, as its last columns differ.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { DamageSourceRow, SourceKind } from '../../../core/analysis/damage-breakdown';
import { GamePicture } from '../../components/GamePicture';

/** Props of {@link DamageSourceCell}. */
export type DamageSourceCellProps = Pick<DamageSourceRow, 'name' | 'kind' | 'imageUrl'>;

/**
 * The classes of the cell of a source, at the start of a row: the picture beside the name, with the
 * room around them. A table gives the first caption of its header the same classes.
 */
export const SOURCE_CELL = 'flex items-center gap-2.5 px-3 py-2';

/**
 * The word that says what a source is, beside its name.
 *
 * @param kind - What the source is.
 * @param t - Translation function.
 * @returns The word for the weapon, the melee attack and an item; `null` for an ability, which needs
 *   none, and for any other source.
 */
function kindWordOf(kind: SourceKind, t: TFunction): string | null {
  switch (kind) {
    case 'weapon':
    case 'melee':
    case 'item':
      return t(`damage.kind.${kind}`);
    case 'ability':
    case 'other':
      return null;
  }
}

/**
 * The cell of a damage source.
 *
 * @returns The cell: the picture, then the name with the word of its kind under it.
 */
export function DamageSourceCell({ name, kind, imageUrl }: DamageSourceCellProps) {
  const { t } = useTranslation();
  const kindWord = kindWordOf(kind, t);

  return (
    <div className={SOURCE_CELL}>
      <GamePicture src={imageUrl} size="medium" fit="contain" fallback="square" />
      <div className="min-w-0">
        <p className="text-sm font-medium">{name}</p>
        {kindWord !== null && <p className="text-xs text-fg-muted">{kindWord}</p>}
      </div>
    </div>
  );
}
