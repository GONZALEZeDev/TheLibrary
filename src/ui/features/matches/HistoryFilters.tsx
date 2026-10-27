/**
 * The filters of the match history: the result (all, wins, losses) and the hero (Paige, all heroes).
 *
 * Each one is the segmented control of the app, a native radio group: the keyboard (arrow keys
 * inside a group) and the screen readers work with no code of their own. The filters show the filter
 * they are given and report a pick; the page keeps the filter in the address.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { PAIGE_HERO_ID } from '../../../core/domain/hero';
import type { HistoryFilter } from '../../../services/matches.service';
import { SegmentedControl } from '../../components/SegmentedControl';

/** Props of {@link HistoryFilters}. */
export interface HistoryFiltersProps {
  /** The filter applied now. */
  readonly filter: HistoryFilter;
  /** Called with the whole filter once the player picks one of its parts; the other part is kept. */
  readonly onChange: (filter: HistoryFilter) => void;
}

/**
 * The two filters of the history.
 *
 * @returns The group of filters.
 */
export function HistoryFilters({ filter, onChange }: HistoryFiltersProps) {
  const { t } = useTranslation();

  return (
    <div role="group" aria-label={t('matches.filters.label')} className="mb-4 flex flex-wrap gap-3">
      <SegmentedControl<HistoryFilter['result']>
        legend={t('matches.table.result')}
        segments={[
          { value: 'all', label: t('matches.filters.result.all') },
          { value: 'win', label: t('matches.filters.result.win') },
          { value: 'loss', label: t('matches.filters.result.loss') },
        ]}
        value={filter.result}
        onPick={(result) => {
          onChange({ ...filter, result });
        }}
      />
      {/* Paige or every hero: the app is made for Paige players. Another hero id in the address
          still filters the list, with neither choice checked. */}
      <SegmentedControl<HistoryFilter['hero']>
        legend={t('matches.table.hero')}
        segments={[
          { value: PAIGE_HERO_ID, label: t('matches.filters.hero.paige') },
          { value: 'all', label: t('matches.filters.hero.all') },
        ]}
        value={filter.hero}
        onPick={(hero) => {
          onChange({ ...filter, hero });
        }}
      />
    </div>
  );
}
