/**
 * Placeholder shown when a view has nothing to display yet (every data view handles
 * its empty state).
 *
 * @packageDocumentation
 */
import type { LucideIcon } from 'lucide-react';

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  /** Decorative icon illustrating the situation (hidden from assistive technologies). */
  readonly icon: LucideIcon;
  /** Short headline, rendered as an `<h2>`. */
  readonly title: string;
  /** One or two sentences explaining what will appear here, or what to do. */
  readonly description: string;
}

/**
 * Friendly placeholder for an empty view.
 *
 * @returns The empty-state block.
 */
export function EmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-surface px-8 py-16 text-center">
      <Icon aria-hidden="true" className="mb-4 size-10 text-accent-bright" />
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-fg-muted">{description}</p>
    </div>
  );
}
