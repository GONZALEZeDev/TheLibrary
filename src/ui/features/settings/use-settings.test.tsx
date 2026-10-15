/**
 * Tests of the settings hooks, rendered with the real providers and the development adapters.
 *
 * @packageDocumentation
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LocalStorageSettingsStore } from '../../../adapters/dev/local-storage-settings-store.adapter';
import { parseSettings } from '../../../core/settings/settings.schema';
import type { AppServices } from '../../../services/app-services';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { useChangeLanguage, useSettings } from './use-settings';

/**
 * Render both settings hooks with the real providers, in English.
 *
 * @param services - The services the hooks read and save the settings through.
 * @param i18n - The i18next instance of the app. It is created by the test, and not here, because
 *   `useTranslation` hands out a copy of it made while rendering: a spy must be set up before.
 * @returns The hooks' result and the query client, to inspect them.
 */
function renderSettingsHooks(services: AppServices, i18n: I18n) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProviders services={services} queryClient={queryClient} i18n={i18n}>
      {children}
    </AppProviders>
  );
  const { result } = renderHook(
    () => ({ settings: useSettings(), changeLanguage: useChangeLanguage() }),
    { wrapper },
  );
  return { result, queryClient };
}

/**
 * Create a settings store whose saves of French are slow, as a busy disk could make them. Without
 * any ordering, a French pick followed by an English one would land after it.
 *
 * @returns A store holding its document in Web Storage.
 */
function createSlowFrenchStore() {
  const store = new LocalStorageSettingsStore(localStorage);
  return {
    read: () => store.read(),
    write: async (document: unknown) => {
      if (parseSettings(document).language === 'fr') {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await store.write(document);
    },
  };
}

/**
 * Create a settings store whose first read is slow: it returns the document as it was when the
 * read started, but late, like a read that began before a save and ends after it.
 *
 * @returns A store holding its document in Web Storage.
 */
function createSlowFirstReadStore() {
  const store = new LocalStorageSettingsStore(localStorage);
  let reads = 0;
  return {
    read: async () => {
      reads += 1;
      const isFirstRead = reads === 1;
      const document = await store.read();
      if (isFirstRead) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return document;
    },
    write: (document: unknown) => store.write(document),
  };
}

describe('settings hooks', () => {
  it('read the settings, then save a new language and switch the UI to it', async () => {
    const { services } = createTestServices();
    const i18n = await createI18n('en');
    const { result } = renderSettingsHooks(services, i18n);

    // First launch: no language chosen yet.
    await waitFor(() => {
      expect(result.current.settings.data).toEqual({ schemaVersion: 1, language: null });
    });

    act(() => {
      result.current.changeLanguage.mutate('fr');
    });

    await waitFor(() => {
      expect(result.current.settings.data?.language).toBe('fr');
    });
    expect(i18n.language).toBe('fr');
    await expect(services.settings.get()).resolves.toEqual({ schemaVersion: 1, language: 'fr' });
  });

  it('keep the cached settings in step with the file when switching the UI language fails', async () => {
    const { services } = createTestServices();
    const i18n = await createI18n('en');
    vi.spyOn(i18n, 'changeLanguage').mockRejectedValue(new Error('catalogue unavailable'));
    const { result } = renderSettingsHooks(services, i18n);
    await waitFor(() => {
      expect(result.current.settings.data).toBeDefined();
    });

    act(() => {
      result.current.changeLanguage.mutate('fr');
    });
    await waitFor(() => {
      expect(result.current.changeLanguage.isError).toBe(true);
    });

    // The language was saved before the switch failed: the cache must not still say otherwise.
    await expect(services.settings.get()).resolves.toEqual({ schemaVersion: 1, language: 'fr' });
    expect(result.current.settings.data?.language).toBe('fr');
    expect(i18n.language).toBe('en');
  });

  it('ignore a read that was already in flight when a language is saved', async () => {
    const { services } = createTestServices({ settingsStore: createSlowFirstReadStore() });
    const i18n = await createI18n('en');
    // Mounting starts the first, slow, read of the settings (still without any language).
    const { result } = renderSettingsHooks(services, i18n);

    act(() => {
      result.current.changeLanguage.mutate('fr');
    });
    await waitFor(() => {
      expect(result.current.changeLanguage.isSuccess).toBe(true);
    });
    // Let the slow read end: its outdated document must not replace the saved one in the cache.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(result.current.settings.data?.language).toBe('fr');
  });

  it('end on the last pick everywhere when picks follow each other quickly', async () => {
    const { services } = createTestServices({ settingsStore: createSlowFrenchStore() });
    const i18n = await createI18n('en');
    const { result, queryClient } = renderSettingsHooks(services, i18n);
    await waitFor(() => {
      expect(result.current.settings.data).toBeDefined();
    });

    // Two picks in the same tick: French, whose save is slow, then English.
    act(() => {
      result.current.changeLanguage.mutate('fr');
      result.current.changeLanguage.mutate('en');
    });
    await waitFor(() => {
      expect(result.current.changeLanguage.isSuccess).toBe(true);
      // The hook only follows the last mutation: wait for the first one as well.
      expect(queryClient.isMutating()).toBe(0);
    });

    // The file, the cache and the displayed language all agree on the last pick.
    await expect(services.settings.get()).resolves.toEqual({ schemaVersion: 1, language: 'en' });
    expect(result.current.settings.data?.language).toBe('en');
    expect(i18n.language).toBe('en');
  });
});
