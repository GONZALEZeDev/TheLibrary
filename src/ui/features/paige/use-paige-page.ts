/**
 * TanStack Query hook of the Paige page.
 *
 * It goes through `PaigePageService`, which answers from its cache or downloads the page. The
 * language is part of the query key: the page of each language is its own cache entry, so a change
 * of language reads (or downloads) the page of the new one, and never shows the other.
 *
 * @packageDocumentation
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FALLBACK_LANGUAGE, isLanguage } from '../../../core/settings/language';
import { useServices } from '../../app/ServicesContext';

/**
 * Key prefix of the Paige page in the TanStack Query cache. The page does not depend on the linked
 * account, so an account change leaves it as it is.
 */
export const PAIGE_PAGE_QUERY_KEY = ['paige-page'] as const;

/**
 * The Paige page in the UI language.
 *
 * @returns The TanStack Query result holding the page.
 */
export function usePaigePage() {
  const { paige } = useServices();
  const { i18n } = useTranslation();
  const language = isLanguage(i18n.language) ? i18n.language : FALLBACK_LANGUAGE;
  return useQuery({
    queryKey: [...PAIGE_PAGE_QUERY_KEY, language],
    queryFn: () => paige.getPaigePage(language),
  });
}
