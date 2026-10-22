/**
 * Title block at the top of every screen.
 *
 * @packageDocumentation
 */
import type { ReactNode } from 'react';

/** Props of {@link PageHeader}. */
export interface PageHeaderProps {
  /** Page title, rendered as the page's only `<h1>`. */
  readonly title: string;
  /** Optional short description under the title. */
  readonly description?: string;
  /**
   * Optional content that describes the page and belongs to its title (the facts of a match, say),
   * rendered under the title and the description. The space the header leaves below is then between
   * the whole block and what follows it, so the content is not closer to what follows than to the
   * title it describes.
   */
  readonly children?: ReactNode;
}

/**
 * Title block of a screen.
 *
 * @returns The page header.
 */
export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description !== undefined && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      {/* A falsy child (`cond && <Facts />`) must not leave an empty, margin-only wrapper. */}
      {children ? <div className="mt-2">{children}</div> : null}
    </header>
  );
}
