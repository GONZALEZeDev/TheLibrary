/**
 * TanStack Query hooks for the user settings.
 *
 * {@link useSettings} reads the settings through the settings service and caches them;
 * {@link useChangeLanguage} saves a new language, keeps the cached settings in step with what was
 * saved, then switches the UI language. Saves are queued one after another, so the last pick wins
 * on disk, in the cache and in the UI alike.
 *
 * @packageDocumentation
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Language } from '../../../core/settings/language';
import type { Settings } from '../../../core/settings/settings.schema';
import type { AppServices } from '../../../services/app-services';
import { useServices } from '../../app/ServicesContext';

/** Key of the settings in the TanStack Query cache. */
export const SETTINGS_QUERY_KEY = ['settings'] as const;

/**
 * Describe the settings query, for the hook that reads it and for the code that updates its cache:
 * `setQueryData` is then checked against the type of the data the query returns, instead of
 * relying on the key and the data type being kept in sync by convention.
 *
 * @param settings - The settings service the query reads through.
 * @returns The query options.
 */
function settingsQueryOptions(settings: AppServices['settings']) {
  return queryOptions({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => settings.get(),
    // The settings are local and only change through this app, which keeps the cache up to date
    // itself after every save: they never go stale by themselves. A refetch (on mount, on
    // reconnect) that started before a save could otherwise land after it and bring back the old
    // document.
    staleTime: Infinity,
  });
}

/**
 * Read the current settings.
 *
 * @returns The TanStack Query result holding the settings.
 */
export function useSettings() {
  const { settings } = useServices();
  return useQuery(settingsQueryOptions(settings));
}

/**
 * Save a new UI language and apply it.
 *
 * The saves of this mutation share one scope, which TanStack Query runs one after another: two
 * picks in quick succession can never be saved out of order, so the last pick always wins. The
 * language is saved first, and the UI only switches once the choice is persisted.
 *
 * @returns The TanStack Query mutation; call `mutate(language)`.
 */
export function useChangeLanguage() {
  const { settings } = useServices();
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();

  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: ['settings', 'language'],
    scope: { id: 'settings' },
    mutationFn: async (language: Language): Promise<Settings> => {
      const updated = await settings.update({ language });

      // The file changed: the cache follows right away, even if switching the UI language fails
      // below, so that it never describes a document that is no longer the saved one. A read still
      // in flight started before the save and would land after it with the old document: cancel it.
      const { queryKey } = settingsQueryOptions(settings);
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, updated);

      await i18n.changeLanguage(language);
      return updated;
    },
  });
}
