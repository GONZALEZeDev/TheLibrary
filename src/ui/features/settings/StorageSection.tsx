/**
 * The storage section of the settings: how much room the match archives take against the limit the
 * player chose, a select to pick another limit among the presets, about how many matches the limit
 * holds, and a reminder that the archives of the latest matches are never removed.
 *
 * A limit that would remove archives is not saved at once: the section first asks what it would
 * remove, and the player confirms in a dialog. A limit that removes nothing is saved right away.
 *
 * Without a linked account there is nothing stored, so the section is not shown at all.
 *
 * @packageDocumentation
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  bytesToMegabytes,
  STORAGE_CAP_PRESETS_MB,
  type StorageCapMb,
} from '../../../core/storage/storage-rules';
import type { EvictionPreview } from '../../../services/storage.service';
import { Dialog } from '../../components/Dialog';
import { StatusLine } from '../../components/StatusLine';
import { SettingsSection } from './SettingsSection';
import { StorageCapConfirmation } from './StorageCapConfirmation';
import { useChangeStorageCap, usePreviewStorageEviction, useStorageUsage } from './use-settings';

/** Under this many megabytes a size is written with one decimal; above, as a whole number. */
const DECIMAL_SIZE_BELOW_MB = 10;

/** The size formatters already built, by language and number of decimals. */
const SIZE_FORMATS = new Map<string, Intl.NumberFormat>();

/**
 * Write a size in megabytes in the language of the interface ("4.2 MB", "4,2 Mo").
 *
 * The formatter is built once per language and number of decimals: building one is slower than
 * using it.
 *
 * @param megabytes - The size, in decimal megabytes (the unit of the limits).
 * @param language - The language of the interface.
 * @param maximumFractionDigits - How many decimals to keep at most.
 * @returns The size with its unit.
 */
function formatSize(megabytes: number, language: string, maximumFractionDigits: number): string {
  const key = `${language}:${String(maximumFractionDigits)}`;
  let format = SIZE_FORMATS.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(language, {
      style: 'unit',
      unit: 'megabyte',
      maximumFractionDigits,
    });
    SIZE_FORMATS.set(key, format);
  }
  return format.format(megabytes);
}

/**
 * Write the space the archives take: one decimal under {@link DECIMAL_SIZE_BELOW_MB}, none above.
 *
 * @param usedBytes - The size of the archives, in bytes.
 * @param language - The language of the interface.
 * @returns The size with its unit.
 */
function formatUsedSize(usedBytes: number, language: string): string {
  const megabytes = bytesToMegabytes(usedBytes);
  return formatSize(megabytes, language, megabytes < DECIMAL_SIZE_BELOW_MB ? 1 : 0);
}

/** What the confirmation is about: the limit that was picked, and what it would remove. */
interface LoweringConfirmation {
  /** The limit the player picked, not saved yet. */
  readonly capMb: StorageCapMb;
  /** The archives it would remove, and the room they take. */
  readonly preview: EvictionPreview;
}

/**
 * The storage section of the settings.
 *
 * @returns The section, or nothing while the usage is first read and when no account is linked.
 */
export function StorageSection() {
  const { t, i18n } = useTranslation();
  const usage = useStorageUsage();
  const changeCap = useChangeStorageCap();
  const previewEviction = usePreviewStorageEviction();
  const selectId = useId();
  // The lowering waiting for the player's answer, or `null` while the dialog is closed.
  const [confirmation, setConfirmation] = useState<LoweringConfirmation | null>(null);

  if (usage.data === undefined) {
    // Nothing was read yet: say why when the first read failed (a damaged database…), else wait.
    return usage.isError ? (
      <SettingsSection title={t('settings.storage.title')}>
        <StatusLine kind="error" error={usage.error} />
      </SettingsSection>
    ) : null;
  }
  if (usage.data === null) {
    return null;
  }
  const { usedBytes, capMb, estimatedMatches } = usage.data;
  // A pick being read or saved is shown as selected right away. Then the saved limit wins again:
  // on a failure, or while the dialog asks, the select goes back to it. A read that fails after a
  // good one (the usage is read again at every synchronisation) keeps the last figures, with the
  // error above them.
  let selectedCapMb = capMb;
  if (previewEviction.isPending) {
    selectedCapMb = previewEviction.variables;
  } else if (changeCap.isPending) {
    selectedCapMb = changeCap.variables;
  }

  // The dialog closes when the player gives up or accepts. The browser then gives the focus back to
  // the select, the element that had it when the dialog opened.
  const closeConfirmation = () => {
    setConfirmation(null);
  };

  /** The player accepted: save the limit, which removes the archives. */
  const confirmLowering = () => {
    if (confirmation === null) {
      return;
    }
    changeCap.mutate(confirmation.capMb);
    closeConfirmation();
  };

  /**
   * A limit was picked: save it at once when it goes up or removes nothing, else ask first.
   *
   * @param value - The `value` of the option that was picked.
   */
  const handlePick = (value: string) => {
    // One thing at a time: a pick made while a limit is being read or saved, or while the dialog
    // asks about another one, is ignored.
    if (changeCap.isPending || previewEviction.isPending || confirmation !== null) {
      return;
    }
    const picked = STORAGE_CAP_PRESETS_MB.find((preset) => String(preset) === value);
    if (picked === undefined) {
      return;
    }
    // The failures of the last pick are not repeated over a new one: a raise reads no preview, which
    // would replace the old error by itself.
    changeCap.reset();
    previewEviction.reset();
    if (picked >= capMb) {
      // A higher limit removes nothing: no need to look.
      changeCap.mutate(picked);
      return;
    }
    // A synchronisation can add archives between this reading and the save: the dialog says "about",
    // and that gap is within its precision.
    previewEviction.mutate(picked, {
      onSuccess: (preview) => {
        if (preview === null || preview.evicted === 0) {
          changeCap.mutate(picked);
        } else {
          setConfirmation({ capMb: picked, preview });
        }
      },
    });
  };

  return (
    <SettingsSection
      title={t('settings.storage.title')}
      description={t('settings.storage.description')}
    >
      {usage.isError && <StatusLine kind="error" error={usage.error} className="mb-3" />}
      <p className="text-sm">
        {t('settings.storage.used', {
          used: formatUsedSize(usedBytes, i18n.language),
          cap: formatSize(capMb, i18n.language, 0),
        })}
      </p>
      <div className="mt-4 flex items-center gap-3">
        <label htmlFor={selectId} className="text-sm">
          {t('settings.storage.capLabel')}
        </label>
        <select
          id={selectId}
          value={selectedCapMb}
          // Never disabled: disabling the focused select would drop the keyboard focus.
          onChange={(event) => {
            handlePick(event.target.value);
          }}
          className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm hover:border-accent-bright"
        >
          {STORAGE_CAP_PRESETS_MB.map((preset) => (
            <option key={preset} value={preset}>
              {formatSize(preset, i18n.language, 0)}
            </option>
          ))}
        </select>
        {changeCap.isPending && (
          <span className="text-sm text-fg-muted">{t('settings.storage.saving')}</span>
        )}
      </div>
      {previewEviction.isError && (
        <StatusLine kind="error" error={previewEviction.error} className="mt-3" />
      )}
      {changeCap.isError && <StatusLine kind="error" error={changeCap.error} className="mt-3" />}
      <p className="mt-4 text-sm">{t('settings.storage.capacity', { count: estimatedMatches })}</p>
      <p className="mt-1 text-sm text-fg-muted">{t('settings.storage.protected')}</p>
      <Dialog
        open={confirmation !== null}
        title={t('settings.storage.confirm.title')}
        onClose={closeConfirmation}
      >
        {confirmation !== null && (
          <StorageCapConfirmation
            preview={confirmation.preview}
            size={formatUsedSize(confirmation.preview.freedBytes, i18n.language)}
            onCancel={closeConfirmation}
            onAccept={confirmLowering}
          />
        )}
      </Dialog>
    </SettingsSection>
  );
}
