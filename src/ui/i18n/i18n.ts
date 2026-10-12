/**
 * i18next setup.
 *
 * The catalogues are bundled with the app (no network), typed (see `i18next.d.ts`) and switchable
 * at runtime without a restart. The `<html lang>` attribute follows the active language, which
 * screen readers rely on.
 *
 * @packageDocumentation
 */
import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { FALLBACK_LANGUAGE, type Language } from '../../core/settings/language';
import enCommon from './locales/en/common.json';
import frCommon from './locales/fr/common.json';

/** Namespace used when `t()` / `useTranslation()` receive none. */
export const DEFAULT_NAMESPACE = 'common';

/** Bundled catalogues, keyed by language then namespace. */
export const RESOURCES = {
  en: { common: enCommon },
  fr: { common: frCommon },
} as const;

/**
 * Create and initialise an i18next instance.
 *
 * Every call returns a new instance, which keeps tests isolated; the app creates exactly one at
 * startup and hands it to `<I18nextProvider>`.
 *
 * @param language - Language to display first.
 * @returns The initialised instance.
 */
export async function createI18n(language: Language): Promise<i18n> {
  const instance = i18next.createInstance();
  // Registered before `init`, so the initial language is applied to <html lang> as well.
  instance.on('languageChanged', (activeLanguage) => {
    document.documentElement.lang = activeLanguage;
  });
  await instance.use(initReactI18next).init({
    resources: RESOURCES,
    lng: language,
    fallbackLng: FALLBACK_LANGUAGE,
    ns: [DEFAULT_NAMESPACE],
    defaultNS: DEFAULT_NAMESPACE,
    // React already escapes every rendered value.
    interpolation: { escapeValue: false },
    // The catalogues are bundled, so initialisation can be synchronous: the first render is
    // already translated.
    initAsync: false,
  });
  return instance;
}
