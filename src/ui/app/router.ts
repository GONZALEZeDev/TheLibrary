/**
 * Application routes, declared in code (no file-based code generation).
 *
 * Search parameters are validated with Zod: `.default()` keeps them optional in links and
 * `.catch()` replaces an invalid value with the default instead of failing, so any URL is safe.
 * Path parameters are validated too: a match id that is not a positive integer shows the
 * not-found page.
 *
 * @packageDocumentation
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { z } from 'zod';
import { PAIGE_HERO_ID } from '../../core/domain/hero';
import { parseMatchId } from '../../core/domain/match';
import { DEFAULT_PERIOD, PERIODS } from '../../core/domain/period';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { MatchDetailPage } from '../features/match-detail/MatchDetailPage';
import { MatchesPage } from '../features/matches/MatchesPage';
import { ReviewPage } from '../features/review/ReviewPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';
import { RouteErrorFallback } from './RouteErrorFallback';

/** Hero filter shared by the dashboard and the match history: Paige unless the URL says otherwise. */
const heroSearchParam = z.int().positive().default(PAIGE_HERO_ID).catch(PAIGE_HERO_ID);

/** Search parameters of `/dashboard`, e.g. `/dashboard?period=7d&hero=67`. */
export const dashboardSearchSchema = z.object({
  period: z.enum(PERIODS).default(DEFAULT_PERIOD).catch(DEFAULT_PERIOD),
  hero: heroSearchParam,
});

/** Search parameters of `/matches`, e.g. `/matches?hero=67&result=win`. */
export const matchesSearchSchema = z.object({
  hero: heroSearchParam,
  result: z.enum(['all', 'win', 'loss']).default('all').catch('all'),
});

/**
 * The tabs the match route accepts: the `tab` of the URL is one of these ids. The page decides their
 * order and their names (`MatchDetailPage`).
 */
export const MATCH_TABS = ['analysis', 'timeline', 'damage', 'players'] as const;

/** The id of a tab of the match page. */
export type MatchTab = (typeof MATCH_TABS)[number];

/** Search parameters of `/matches/$matchId`, e.g. `/matches/100000001?tab=damage`. */
export const matchDetailSearchSchema = z.object({
  tab: z.enum(MATCH_TABS).default('analysis').catch('analysis'),
});

/**
 * The tabs the review route accepts: the `tab` of the URL is one of these ids. The page decides their
 * order and their names (`ReviewPage`).
 */
export const REVIEW_TABS = ['summary', 'stats', 'deaths', 'damage', 'players'] as const;

/** The id of a tab of the review page. */
export type ReviewTab = (typeof REVIEW_TABS)[number];

/** Search parameters of `/review`, e.g. `/review?tab=deaths`. */
export const reviewSearchSchema = z.object({
  tab: z.enum(REVIEW_TABS).default('summary').catch('summary'),
});

// Root layout: the application shell renders the matched child route in its <Outlet />.
const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // The dashboard is the home screen.
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' });
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  validateSearch: dashboardSearchSchema,
  component: DashboardPage,
});

const matchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/matches',
  validateSearch: matchesSearchSchema,
  component: MatchesPage,
});

const matchDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/matches/$matchId',
  // The page receives a `MatchId`, the branded number `parseMatchId` makes; links pass one too
  // (`params={{ matchId: match.matchId }}`): a plain number does not compile.
  params: {
    parse: ({ matchId }) => {
      const parsed = parseMatchId(matchId);
      if (parsed === null) {
        throw notFound();
      }
      return { matchId: parsed };
    },
    stringify: ({ matchId }) => ({ matchId: String(matchId) }),
  },
  // The open tab lives in the URL; links that do not name one open the analysis.
  validateSearch: matchDetailSearchSchema,
  component: MatchDetailPage,
});

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  // The open tab lives in the URL; links that do not name one open the summary.
  validateSearch: reviewSearchSchema,
  component: ReviewPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  matchesRoute,
  matchDetailRoute,
  reviewRoute,
  settingsRoute,
]);

/**
 * Build the application router.
 *
 * @param history - Navigation history; browser history by default, `createMemoryHistory()` in tests.
 * @returns A router bound to the application route tree.
 */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    // A failing or unknown page renders inside the shell, so the navigation stays usable.
    defaultErrorComponent: RouteErrorFallback,
    defaultNotFoundComponent: NotFoundPage,
  });
}

declare module '@tanstack/react-router' {
  /** Registers the route tree so that links, params and search are type-checked everywhere. */
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
