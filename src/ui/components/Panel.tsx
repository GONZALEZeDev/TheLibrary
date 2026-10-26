/**
 * The panel of the app: the bordered box on the surface colour that holds a block of a screen.
 *
 * @packageDocumentation
 */
import type { ComponentPropsWithRef, Ref } from 'react';

/** How much room a panel leaves between its border and its content. */
export type PanelPadding = 'tight' | 'normal' | 'roomy';

/**
 * The classes of a panel, exported for the few places that draw a panel without the component (a
 * native `<dialog>` content box, a list box that scrolls): they take the same look from here.
 */
export const PANEL_CLASSES = {
  /** The box itself: rounded, bordered, on the surface colour. */
  base: 'rounded-xl border border-border bg-surface',
  /** The padding of each {@link PanelPadding}. */
  padding: {
    tight: 'p-1',
    normal: 'p-4',
    roomy: 'p-6',
  },
} as const satisfies { base: string; padding: Record<PanelPadding, string> };

/**
 * Props of {@link Panel}: the native attributes of the element (`aria-labelledby`…, and its `ref`),
 * plus these.
 */
export interface PanelProps extends ComponentPropsWithRef<'section'> {
  /** The element to render: a `section` (default) for a block with a title, a `div` otherwise. */
  readonly as?: 'section' | 'div';
  /** The room between the border and the content. */
  readonly padding: PanelPadding;
}

/**
 * A bordered box on the surface colour.
 *
 * The `className` of the caller is for layout and margins (`mt-6`, `flex flex-col`…): the panel
 * owns the colours, the border and the padding.
 *
 * @returns The panel element.
 */
export function Panel({
  as: Tag = 'section',
  padding,
  className,
  children,
  ref,
  ...nativeProps
}: PanelProps) {
  // The shared look and padding first, then what the caller adds (a margin, a layout…).
  const classes = [PANEL_CLASSES.base, PANEL_CLASSES.padding[padding], className]
    .filter(Boolean)
    .join(' ');

  return (
    // The cast asserts `HTMLDivElement` for an element that may be a `section`. It is safe because
    // the ref of the caller is typed `Ref<HTMLElement>` and either tag is an `HTMLElement`; only
    // the strict typing of ref objects refuses the `section | div` union.
    <Tag {...nativeProps} ref={ref as Ref<HTMLDivElement> | undefined} className={classes}>
      {children}
    </Tag>
  );
}
