/**
 * TanStack Query hook of the Paige page.
 *
 * It goes through `PaigePageService`, in two steps: the page kept in the cache shows at once,
 * however old (or the downloaded one, when none is kept yet), then the page is downloaded again
 * once per launch of the app, and the tab shows the new values as soon as they are in. A game patch
 * that changes Paige's values shows at the next launch, with no update of the app, and the API is
 * asked once per launch and language at most.
 *
 * The language is part of the query keys: the page of each language is its own cache entry, so a
 * change of language reads (or downloads) the page of the new one, and never shows the other.
 *
 * @packageDocumentation
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FALLBACK_LANGUAGE, isLanguage } from '../../../core/settings/language';
import { useServices } from '../../app/ServicesContext';

/**
 * Key prefix of the Paige page in the TanStack Query cache. The page does not depend on the linked
 * account, so an account change leaves it as it is.
 */
export const PAIGE_PAGE_QUERY_KEY = ['paige-page'] as const;

/**
 * The Paige page in the UI language: the one kept in the cache first, then the one of this launch
 * of the app.
 *
 * @returns The TanStack Query result holding the page.
 */
export function usePaigePage() {
  const { paige } = useServices();
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();
  const language = isLanguage(i18n.language) ? i18n.language : FALLBACK_LANGUAGE;
  const pageKey = [...PAIGE_PAGE_QUERY_KEY, language] as const;
  const page = useQuery({
    queryKey: pageKey,
    queryFn: () => paige.getPaigePage(language),
  });
  // The download of this launch, once the kept page shows: a page downloaded because none was kept
  // is of this launch already, and the service then reads it from the cache instead of asking the
  // API again. The query is never stale and never forgotten, so the tab asks once per launch and
  // language, however often it opens. Its answer replaces the page the tab shows. It does not retry
  // by itself: a failed download keeps the page shown, and the next launch tries again.
  useQuery({
    queryKey: [...pageKey, 'launch'],
    queryFn: async () => {
      const fresh = await paige.refreshPaigePage(language);
      if (fresh !== null) {
        queryClient.setQueryData(pageKey, fresh);
      }
      return fresh !== null;
    },
    enabled: page.isSuccess,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return page;
}
