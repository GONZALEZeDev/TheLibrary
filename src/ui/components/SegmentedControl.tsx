/**
 * The segmented control of the app: a row of choices of which one is picked, such as the language
 * of the settings or the filters of the match history.
 *
 * It is a native radio group styled as a row of segments, so the keyboard (Tab enters the group on
 * the checked choice, the arrow keys move and pick inside it) and the screen readers work with no
 * code of its own.
 *
 * @packageDocumentation
 */
import { useId } from 'react';

/**
 * The look of a segment: the visible label of a hidden radio, styled from the radio's state. The
 * focus ring is offset because the checked fill has the same colour.
 */
const SEGMENT_CLASSES =
  'cursor-pointer rounded-md px-4 py-1.5 text-sm text-fg-muted has-checked:bg-accent-bright has-checked:font-medium has-checked:text-bg has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-bright';

/** One choice of a {@link SegmentedControl}. */
export interface Segment<T> {
  /** The value the choice stands for. */
  readonly value: T;
  /** Its visible name, already translated. */
  readonly label: string;
}

/** Props of {@link SegmentedControl}. */
export interface SegmentedControlProps<T> {
  /** The name of the group for a screen reader, already translated. */
  readonly legend: string;
  /** The choices, in order. */
  readonly segments: readonly Segment<T>[];
  /** The value checked now: none is checked when it is none of the choices. */
  readonly value: T;
  /** Called with the value of the choice the player picks. */
  readonly onPick: (value: T) => void;
}

/**
 * A radio group drawn as a row of segments.
 *
 * The control is never disabled: disabling the focused radio would drop the keyboard focus. A
 * caller that must refuse a pick (e.g. while a choice is being saved) ignores it in `onPick`.
 *
 * @returns The group, a `fieldset` named by its hidden legend.
 */
export function SegmentedControl<T extends string | number>({
  legend,
  segments,
  value,
  onPick,
}: SegmentedControlProps<T>) {
  // Unique radio-group name, so two controls on one page never interfere.
  const groupName = useId();

  return (
    <fieldset className="inline-flex gap-1 rounded-lg border border-border bg-surface p-1">
      <legend className="sr-only">{legend}</legend>
      {segments.map((segment) => (
        // The radio itself is visually hidden; its label is the visible segment, styled from the
        // radio's state (see SEGMENT_CLASSES).
        <label key={segment.value} className={SEGMENT_CLASSES}>
          <input
            type="radio"
            name={groupName}
            value={segment.value}
            checked={segment.value === value}
            onChange={() => {
              onPick(segment.value);
            }}
            className="sr-only"
          />
          {segment.label}
        </label>
      ))}
    </fieldset>
  );
}
