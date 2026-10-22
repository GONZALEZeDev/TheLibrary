/**
 * The final build of a match on its page: the items the player ended the match with, grouped by the
 * slot of the shop they belong to.
 *
 * An item has its picture, its name, the time it was bought (as minutes and seconds) and, when it was
 * imbued into an ability, which one. The groups are the slots of the shop in the order the shop lists
 * them (weapon, vitality, spirit), then the items the catalogue puts in no slot or does not know; a
 * group that holds no item is left out. The items are listed in the order they are given (the view
 * of the breakdown puts them in the order the page lists them: by slot, then by tier, then by
 * purchase time), and a match that ended with no item says so.
 *
 * The build is a region of its own, named by its title, a peer of the region of the damage above it
 * (so the title is a level 2 heading and the slots are level 3). Each slot is a list named by its
 * heading, not a region: a page with up to four more landmarks (weapon, vitality, spirit, other)
 * would bury the two that matter.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ITEM_SLOTS, type ItemSlot } from '../../../core/deadlock-api/assets.schema';
import type { BuildItemView } from '../../../services/match-breakdown-view';
import { GamePicture } from '../../components/GamePicture';
import { formatGameTime } from './analysis-format';

/** Props of {@link FinalBuild}. */
export interface FinalBuildProps {
  /** The items the player ended the match with, in the order the page lists them. */
  readonly build: readonly BuildItemView[];
}

/** A group of the build: a slot of the shop, or the items that have none. */
type BuildGroup = ItemSlot | 'other';

/** The groups of the build in the order the page shows them: the slots of the shop, then the rest. */
const BUILD_GROUPS: readonly BuildGroup[] = [...ITEM_SLOTS, 'other'];

/**
 * One item of the build.
 *
 * @param item - The item.
 * @param t - Translation function.
 * @returns The item of the list: its picture (a neutral square when it has none or cannot be loaded),
 *   its name, when it was bought and, if it was imbued, the ability it was imbued into. An item the
 *   catalogue does not know is named by its id.
 */
function renderItem(item: BuildItemView, t: TFunction) {
  return (
    <li
      key={`${String(item.itemId)}-${String(item.boughtAtS)}`}
      className="flex items-center gap-2.5"
    >
      <GamePicture src={item.imageUrl} size="medium" fit="contain" fallback="square" />
      <div className="min-w-0">
        <p className="text-sm font-medium">{item.name ?? `#${String(item.itemId)}`}</p>
        <p className="text-xs text-fg-muted tabular-nums">
          {t('build.boughtAt', { time: formatGameTime(item.boughtAtS) })}
        </p>
        {item.imbuedInto !== null && (
          <p className="text-xs text-fg-muted">{t('build.imbued', { ability: item.imbuedInto })}</p>
        )}
      </div>
    </li>
  );
}

/**
 * The final build of one match.
 *
 * @returns The title and the groups of items by slot (only those that hold an item), or the title and
 *   the sentence of a match that ended with no item.
 */
export function FinalBuild({ build }: FinalBuildProps) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <h2 id={titleId} className="text-base font-semibold">
        {t('build.title')}
      </h2>
      {build.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('build.empty')}</p>
      ) : (
        // The groups sit side by side when the page is wide enough for three, and stack otherwise.
        <div className="@container">
          <div className="grid gap-4 @3xl:grid-cols-3">
            {BUILD_GROUPS.map((group) => {
              // An item without a slot (an item the catalogue does not know, say) is of the last group.
              const items = build.filter((item) => (item.slot ?? 'other') === group);
              const groupTitleId = `${titleId}-${group}`;
              return items.length === 0 ? null : (
                <div key={group} className="rounded-xl border border-border bg-surface p-3">
                  <h3
                    id={groupTitleId}
                    className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase"
                  >
                    {t(`build.slot.${group}`)}
                  </h3>
                  <ul aria-labelledby={groupTitleId} className="space-y-2">
                    {items.map((item) => renderItem(item, t))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
