/**
 * The set of services available to the UI.
 *
 * `create-app-services.ts` builds this object from the adapters of the current environment; the UI
 * receives it through React context (`ui/app/ServicesContext.tsx`) and never builds services or
 * adapters itself. Every service the UI needs is a member of this object.
 *
 * @packageDocumentation
 */
import type { Logger } from '../ports/logger.port';
import type { AccountService } from './account.service';
import type { AnalysisService } from './analysis.service';
import type { HeroCatalogService } from './hero-catalog.service';
import type { MatchBreakdownService } from './match-breakdown.service';
import type { MatchDetailService } from './match-detail.service';
import type { MatchesService } from './matches.service';
import type { SettingsService } from './settings.service';
import type { SyncService } from './sync.service';

/** Services available to the UI. */
export interface AppServices {
  /** User settings (language…). */
  readonly settings: SettingsService;
  /** Structured logger. */
  readonly logger: Logger;
  /** Match history of the linked account. */
  readonly matches: MatchesService;
  /** Hero names. */
  readonly heroes: HeroCatalogService;
  /** Detail of the Paige matches: download, archive, and what the match page shows of it. */
  readonly details: MatchDetailService;
  /** Synchronisation of the match history with deadlock-api. */
  readonly sync: SyncService;
  /** The linked Steam account: link, switch, unlink, and the upkeep of the link. */
  readonly account: AccountService;
  /** Analysis of the Paige matches: the comparison with the community and with the player's habits. */
  readonly analysis: AnalysisService;
  /** Breakdown of the Paige matches: the damage by source with its build, read from the archive. */
  readonly breakdown: MatchBreakdownService;
}
