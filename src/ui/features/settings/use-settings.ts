/**
 * TanStack Query hooks for the user settings.
 *
 * {@link useSettings} reads the settings through the settings service and caches them;
 * {@link useChangeLanguage} saves a new language, switches the UI language immediately and
 * refreshes the cached settings.
 *
 * @packageDocumentation
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Language } from '../../../core/settings/language';
import type { Settings } from '../../../core/settings/settings.schema';
import { useServices } from '../../app/ServicesContext';

/** Key of the settings in the TanStack Query cache. */
export const SETTINGS_QUERY_KEY = ['settings'] as const;

/**
 * Read the current settings.
 *
 * @returns The TanStack Query result holding the settings.
 */
export function useSettings() {
  const { settings } = useServices();
  return useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: () => settings.get() });
}

/**
 * Save a new UI language and apply it immediately.
 *
 * @returns The TanStack Query mutation; call `mutate(language)`.
 */
export function useChangeLanguage() {
  const { settings } = useServices();
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();

  return useMutation({
    mutationFn: async (language: Language): Promise<Settings> => {
      // Save first: the UI only switches once the choice is safely persisted.
      const updated = await settings.update({ language });
      await i18n.changeLanguage(language);
      return updated;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, updated);
    },
  });
}
