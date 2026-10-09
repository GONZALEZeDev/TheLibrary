/**
 * Supported UI languages and the rule that picks the language at startup.
 *
 * French and English are supported. On first launch the system language is used when it is French
 * or English, otherwise English. Once the user picks a language, it is saved and always wins.
 *
 * @packageDocumentation
 */

/** Languages the UI is translated into, in display order. */
export const SUPPORTED_LANGUAGES = ['fr', 'en'] as const;

/** A language the UI can be displayed in. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Language used when neither the saved choice nor a system language is supported. */
export const FALLBACK_LANGUAGE: Language = 'en';

/**
 * Tell whether a value is a supported {@link Language}.
 *
 * @param value - Any value, e.g. read from storage.
 * @returns `true` when `value` is a supported language code.
 */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Pick the language to display at startup.
 *
 * Precedence: the language saved by the user, then the first system language whose primary
 * subtag is supported (`fr-CA` → `fr`), then {@link FALLBACK_LANGUAGE}.
 *
 * @param saved - Language saved in the settings, or `null` if the user never picked one.
 * @param systemLanguages - BCP 47 tags in order of preference, e.g. `navigator.languages`.
 * @returns The language to display.
 */
export function resolveInitialLanguage(
  saved: Language | null,
  systemLanguages: readonly string[],
): Language {
  if (saved !== null) {
    return saved;
  }
  for (const tag of systemLanguages) {
    // Only the primary subtag matters: "fr-FR", "fr-BE" and "fr" all mean French.
    const primarySubtag = tag.split('-')[0]?.toLowerCase();
    if (isLanguage(primarySubtag)) {
      return primarySubtag;
    }
  }
  return FALLBACK_LANGUAGE;
}
