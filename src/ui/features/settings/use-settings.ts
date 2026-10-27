/**
 * TanStack Query hooks for the user settings.
 *
 * {@link useSettings} reads the settings through the settings service and caches them;
 * {@link useChangeLanguage} saves a new language, keeps the cached settings in step with what was
 * saved, then switches the UI language. Saves are queued one after another, so the last pick wins
 * on disk, in the cache and in the UI alike.
 *
 * {@link useStorageUsage} reads what the archives take against the size limit,
 * {@link usePreviewStorageEviction} tells what a lower limit would remove, and
 * {@link useChangeStorageCap} saves a new limit, which the storage service enforces at once.
 *
 * {@link useChangeDebugLogging} saves the detailed log switch and applies it to the logger, and
 * {@link useOpenLogFolder} opens the folder of the log files.
 *
 * @packageDocumentation
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Language } from '../../../core/settings/language';
import type { Settings } from '../../../core/settings/settings.schema';
import type { StorageCapMb } from '../../../core/storage/storage-rules';
import type { AppServices } from '../../../services/app-services';
import { useServices } from '../../app/ServicesContext';
import {
  DETAILS_QUERY_KEY,
  DETAILS_SUMMARY_QUERY_KEY,
  MATCHES_QUERY_KEY,
} from '../matches/use-matches';

/** Key of the settings in the TanStack Query cache. */
export const SETTINGS_QUERY_KEY = ['settings'] as const;

/**
 * Key of the storage usage in the TanStack Query cache.
 *
 * It sits under {@link DETAILS_QUERY_KEY} on purpose: what the archives take changes whenever a
 * synchronisation ends or the detail queue records a match (a download adds an archive, and the
 * limit is enforced inside the run, which evicts some), and those are the very events that
 * invalidate the details. So the usage is read again on every one of them with no subscription of
 * its own, and an account change resets it with the rest of the details.
 */
export const STORAGE_USAGE_QUERY_KEY = [...DETAILS_QUERY_KEY, 'storage'] as const;

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

/**
 * Read what the archives of the linked account take, against the size limit.
 *
 * @returns The TanStack Query result holding the usage, or `null` when no account is linked.
 */
export function useStorageUsage() {
  const { storage } = useServices();
  return useQuery({
    queryKey: STORAGE_USAGE_QUERY_KEY,
    queryFn: () => storage.getUsage(),
  });
}

/**
 * Ask what a size limit would remove, before it is saved: how many archives and how many bytes.
 * Nothing is written. A mutation and not a query: it is asked for once, on a pick, with the limit
 * that was picked, and its result is not worth keeping.
 *
 * @returns The TanStack Query mutation; call `mutate(capMb)`. It resolves with `null` when no
 *   account is linked.
 */
export function usePreviewStorageEviction() {
  const { storage } = useServices();

  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: ['settings', 'storageEvictionPreview'],
    mutationFn: (capMb: StorageCapMb) => storage.previewEviction(capMb),
  });
}

/**
 * Save a new size limit for the archives. The storage service saves it, then evicts the oldest
 * archives at once if they take more than the new limit allows.
 *
 * The saves share the scope of {@link useChangeLanguage}: both rewrite the settings, so they run
 * one after another. The usage and the settings are read again once the mutation ends, whether it
 * worked or not: a failed enforcement leaves the limit saved, and a failed save leaves the old one,
 * and the screen must show what is on disk either way. An eviction also changes the detail status
 * of the matches, which the synchronisation banner counts and the match list shows, so both are
 * read again as well.
 *
 * @returns The TanStack Query mutation; call `mutate(capMb)`.
 */
export function useChangeStorageCap() {
  const { storage } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: ['settings', 'storageCap'],
    scope: { id: 'settings' },
    mutationFn: (capMb: StorageCapMb) => storage.setCap(capMb),
    onSettled: async () => {
      // Returned, so that the mutation stays pending until the screen has the new figures: the
      // select would otherwise fall back to the old limit for a moment.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: DETAILS_SUMMARY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: MATCHES_QUERY_KEY }),
      ]);
    },
  });
}

/**
 * Save the detailed log switch, then apply it to the logger.
 *
 * The switch is saved first and applied only once the save has worked: a switch that could not be
 * saved would be forgotten at the next start, and the screen shows the saved value again after a
 * failure, so the logger must agree with it. The saves share the scope of {@link useChangeLanguage},
 * so the saves of the settings run one after another, never in parallel.
 *
 * @returns The TanStack Query mutation; call `mutate(enabled)`.
 */
export function useChangeDebugLogging() {
  const { settings, diagnostics } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: ['settings', 'debugLogging'],
    scope: { id: 'settings' },
    mutationFn: async (enabled: boolean): Promise<Settings> => {
      const updated = await settings.update({ debugLogging: enabled });

      // The file changed: the cache follows right away, and a read still in flight (it started
      // before the save) must not bring the old document back.
      const { queryKey } = settingsQueryOptions(settings);
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, updated);

      diagnostics.setDebugLogging(updated.debugLogging);
      return updated;
    },
  });
}

/**
 * Open the folder of the log files in the file explorer of the system.
 *
 * @returns The TanStack Query mutation; call `mutate()`. It fails with an `AppError` of kind
 *   `storage` when the folder cannot be opened.
 */
export function useOpenLogFolder() {
  const { diagnostics } = useServices();

  return useMutation({
    // Shows up in the log line written when the mutation fails.
    mutationKey: ['settings', 'openLogFolder'],
    mutationFn: () => diagnostics.openLogFolder(),
  });
}
