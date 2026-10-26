/**
 * The button of the app: one of the looks of {@link BUTTON_CLASSES}, with an optional icon that can
 * turn while the button works.
 *
 * @packageDocumentation
 */
import type { LucideIcon } from 'lucide-react';
import type { ComponentPropsWithRef } from 'react';
import { BUTTON_CLASSES, BUTTON_WITH_ICON_CLASS, type ButtonLook } from './button-styles';

/**
 * Props of {@link Button}: the native attributes of a `<button>` (its `ref` included, so that a
 * caller can focus it), plus the look and the icon.
 */
export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** How the button is drawn: the action the player came for, anything else, or a deletion. */
  readonly look: ButtonLook;
  /** Optional icon drawn left of the text (decorative: the text says what the button does). */
  readonly icon?: LucideIcon;
  /** Turns the icon, to show that the action of the button is running. Needs an `icon`. */
  readonly spinning?: boolean;
}

/**
 * A button drawn with one of the shared looks.
 *
 * It is `type="button"` unless the caller says otherwise, so that a button inside a form never
 * submits it by accident. The `className` of the caller is for layout and margins (`mt-4`,
 * `self-start`…): the look owns the colours, the border and the padding.
 *
 * @returns The button element.
 */
export function Button({
  look,
  icon: Icon,
  spinning = false,
  className,
  type = 'button',
  children,
  ...nativeProps
}: ButtonProps) {
  // The look comes first, then the row layout of the icon slot (only when there is an icon), then
  // what the caller adds (a margin, for instance).
  const classes = [BUTTON_CLASSES[look], Icon ? BUTTON_WITH_ICON_CLASS : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...nativeProps} type={type} className={classes}>
      {Icon ? (
        <Icon
          aria-hidden="true"
          // `motion-safe:` keeps the icon still for people who asked their system for less motion.
          className={spinning ? 'size-4 motion-safe:animate-spin' : 'size-4'}
        />
      ) : null}
      {children}
    </button>
  );
}
