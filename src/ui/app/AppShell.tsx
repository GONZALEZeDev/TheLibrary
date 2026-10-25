/**
 * Application frame: a fixed sidebar with the dashboard, the match history and the review, the
 * settings and the linked Steam account, and the area where the active page renders.
 *
 * @packageDocumentation
 */
import { Link, Outlet } from '@tanstack/react-router';
import { BookOpen, ClipboardList, History, LayoutDashboard, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SidebarAccount } from '../features/account/SidebarAccount';

/**
 * Look of the sidebar links, spread on each `<Link>`. Colours are set only in the active and
 * inactive props, never in the shared class: two colour utilities on one element resolve by their
 * order in the generated CSS, not by their order in `className`.
 */
const NAV_LINK_PROPS = {
  className: 'flex items-center gap-3 rounded-md border-l-2 px-3 py-2 text-sm',
  inactiveProps: {
    className: 'border-transparent text-fg-muted hover:bg-surface-raised hover:text-fg',
  },
  // The current page also gets an accent bar, a cue that does not rely on the text colour
  // (TanStack Router sets `aria-current="page"` for assistive technologies).
  activeProps: { className: 'border-accent-bright bg-surface-raised font-medium text-fg' },
};

/**
 * Sidebar navigation and page area.
 *
 * @returns The application shell.
 */
export function AppShell() {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface p-4">
        <div className="mb-8 flex items-center gap-2 px-3 text-lg font-semibold">
          <BookOpen aria-hidden="true" className="size-5 text-accent-bright" />
          {t('app.name')}
        </div>
        <nav aria-label={t('nav.label')} className="flex flex-1 flex-col gap-1">
          <Link to="/dashboard" {...NAV_LINK_PROPS}>
            <LayoutDashboard aria-hidden="true" className="size-4" />
            {t('nav.dashboard')}
          </Link>
          <Link to="/matches" {...NAV_LINK_PROPS}>
            <History aria-hidden="true" className="size-4" />
            {t('nav.matches')}
          </Link>
          <Link to="/review" {...NAV_LINK_PROPS}>
            <ClipboardList aria-hidden="true" className="size-4" />
            {t('nav.review')}
          </Link>
          {/* Settings sit at the bottom of the sidebar. */}
          <Link
            to="/settings"
            {...NAV_LINK_PROPS}
            className={`${NAV_LINK_PROPS.className} mt-auto`}
          >
            <Settings aria-hidden="true" className="size-4" />
            {t('nav.settings')}
          </Link>
        </nav>
        {/* The account closes the sidebar, under the navigation whose last link is the settings. */}
        <SidebarAccount />
      </aside>
      <main className="flex-1 overflow-y-auto px-10 py-8">
        <Outlet />
      </main>
    </div>
  );
}
