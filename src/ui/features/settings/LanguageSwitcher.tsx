/**
 * Language picker of the settings screen.
 *
 * Rendered as the segmented control of the app (a native radio group), so it is keyboard- and
 * screen-reader-accessible for free. Language names are shown in their own language
 * ("Français", "English"), as is customary.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, type Language } from '../../../core/settings/language';
import { SegmentedControl } from '../../components/SegmentedControl';

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

  return (
    <SegmentedControl
      legend={t('settings.language.title')}
      segments={SUPPORTED_LANGUAGES.map((language) => ({
        value: language,
        label: t(`language.${language}`),
      }))}
      value={value}
      onPick={onChange}
    />
  );
}
