/**
 * Language picker of the settings screen.
 *
 * Rendered as a native radio group styled as a segmented control, so it is keyboard- and
 * screen-reader-accessible for free. Language names are shown in their own language
 * ("Français", "English"), as is customary.
 *
 * @packageDocumentation
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, type Language } from '../../../core/settings/language';

/** Props of {@link LanguageSwitcher}. */
export interface LanguageSwitcherProps {
  /** Language currently selected. */
  readonly value: Language;
  /** Called with the language the user picks. */
  readonly onChange: (language: Language) => void;
}

/**
 * Segmented control listing the supported languages.
 *
 * The control is never disabled: disabling the focused radio would drop the keyboard focus.
 * A caller that must refuse a pick (e.g. while a choice is being saved) ignores it in `onChange`.
 *
 * @returns The language picker.
 */
export function LanguageSwitcher({ value, onChange }: LanguageSwitcherProps) {
  const { t } = useTranslation();
  // Unique radio-group name, so two switchers on one page never interfere.
  const groupName = useId();

  return (
    <fieldset className="inline-flex gap-1 rounded-lg border border-border bg-surface p-1">
      <legend className="sr-only">{t('settings.language.title')}</legend>
      {SUPPORTED_LANGUAGES.map((language) => (
        // The radio itself is visually hidden; its label is the visible segment, styled from the
        // radio's state. The focus ring is offset because the checked fill has the same colour.
        <label
          key={language}
          className="cursor-pointer rounded-md px-4 py-1.5 text-sm text-fg-muted has-checked:bg-accent-bright has-checked:font-medium has-checked:text-bg has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-bright"
        >
          <input
            type="radio"
            name={groupName}
            value={language}
            checked={value === language}
            onChange={() => {
              onChange(language);
            }}
            className="sr-only"
          />
          {t(`language.${language}`)}
        </label>
      ))}
    </fieldset>
  );
}
