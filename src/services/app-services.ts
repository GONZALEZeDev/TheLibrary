/**
 * The set of services available to the UI.
 *
 * The composition root (`src/main.tsx`) builds this object with the adapters of the current
 * environment; the UI receives it through React context (`ui/app/ServicesContext.tsx`) and never
 * builds services or adapters itself. It grows milestone by milestone (sync, matches, analysis…).
 *
 * @packageDocumentation
 */
import type { Logger } from '../ports/logger.port';
import type { SettingsService } from './settings.service';

/** Services available to the UI. */
export interface AppServices {
  /** User settings (language…). */
  readonly settings: SettingsService;
  /** Structured logger. */
  readonly logger: Logger;
}
