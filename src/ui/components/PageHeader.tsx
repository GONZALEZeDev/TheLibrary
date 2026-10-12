/**
 * Title block at the top of every screen.
 *
 * @packageDocumentation
 */

/** Props of {@link PageHeader}. */
export interface PageHeaderProps {
  /** Page title, rendered as the page's only `<h1>`. */
  readonly title: string;
  /** Optional short description under the title. */
  readonly description?: string;
}

/**
 * Title block of a screen.
 *
 * @returns The page header.
 */
export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description !== undefined && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
    </header>
  );
}
