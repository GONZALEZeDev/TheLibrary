/**
 * The shape the sections of the settings share: a titled panel holding a muted description and the
 * content of the section.
 *
 * @packageDocumentation
 */
import { useId, type ReactNode } from 'react';
import { Panel } from '../../components/Panel';

/** Props of {@link SettingsSection}. */
export interface SettingsSectionProps {
  /** The title of the section, already translated: it names the panel for screen readers too. */
  readonly title: string;
  /** What the section is about, already translated, in muted text under the title. */
  readonly description?: string;
  /** The content of the section: its status, its controls, its errors. */
  readonly children: ReactNode;
}

/**
 * A titled panel of the settings: the `h2` title, the muted description when there is one, then the
 * content with some room above it. The panel is named by its title, so that it is a landmark region
 * a screen reader can jump to.
 *
 * @returns The panel.
 */
export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  const headingId = useId();

  return (
    <Panel padding="roomy" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-base font-medium">
        {title}
      </h2>
      {description !== undefined && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </Panel>
  );
}
