/**
 * Tests of the settings hooks, rendered with the real providers and the development adapters.
 *
 * @packageDocumentation
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { useChangeLanguage, useSettings } from './use-settings';

describe('settings hooks', () => {
  it('read the settings, then save a new language and switch the UI to it', async () => {
    const { services } = createTestServices();
    const i18n = await createI18n('en');
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
});
