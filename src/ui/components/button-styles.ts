/**
 * The looks of the buttons of the app, as Tailwind class lists, so that every button that uses them
 * is drawn the same way.
 *
 * They live in one place because a copy of a class list drifts: the first copy that gets a fix is the
 * only one that has it. A disabled button of any look is dimmed and does not react to the pointer,
 * which is why the hover looks apply to enabled buttons only (`hover:enabled:`), not to every button.
 *
 * @packageDocumentation
 */

/**
 * The classes of each look of a button. `primary` is the action the player came for (a filled
 * button), `subtle` is anything else (a bordered one), and `destructive` is the one that deletes
 * (bordered, in the colour of a loss).
 *
 * The `destructive` list is a list of its own and not the `subtle` one with the loss colours added:
 * two border colours on one element are decided by the order of the generated CSS, not by the order
 * of the classes.
 */
export const BUTTON_CLASSES = {
  primary:
    'rounded-md bg-accent-bright px-4 py-2 text-sm font-medium text-bg hover:enabled:brightness-110 disabled:cursor-not-allowed disabled:opacity-60',
  subtle:
    'rounded-md border border-border bg-surface-raised px-4 py-2 text-sm font-medium hover:enabled:border-accent-bright disabled:cursor-not-allowed disabled:opacity-60',
  destructive:
    'rounded-md border border-loss bg-surface-raised px-4 py-2 text-sm font-medium text-loss hover:enabled:brightness-110 disabled:cursor-not-allowed disabled:opacity-60',
} as const;

/** The name of a look of {@link BUTTON_CLASSES}. */
export type ButtonLook = keyof typeof BUTTON_CLASSES;

/**
 * Lays a button out as a row, so that its icon sits left of its text. Applied only to a button that
 * has an icon: a text-only button keeps the plain layout it always had.
 */
export const BUTTON_WITH_ICON_CLASS = 'inline-flex items-center justify-center gap-2';

/** Where the buttons of a dialog sit: on the right, under its text. */
export const DIALOG_ACTIONS_CLASS = 'mt-6 flex justify-end gap-3';
