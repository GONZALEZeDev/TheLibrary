# `src/ui` — React user interface

## Structure

| Folder                | Purpose                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `app/`                | App shell, router, providers, query client, route error screen                                              |
| `features/<feature>/` | Screens and components of one feature (account, dashboard, matches, match-detail, settings) and their hooks |
| `components/`         | Shared presentational components, the shared button styles and the focus helper                             |
| `format/`             | Display formatters shared by several features (durations)                                                   |
| `i18n/`               | i18next setup and the `en`/`fr` catalogues                                                                  |
| `theme/`              | `theme.css` only (design tokens); Inter comes from `@fontsource-variable/inter`                             |

## Rules

- May import `services/` (through hooks and `useServices()`), types and pure helpers from `core/`, and other `ui/` modules — never a port, never an adapter, never `@tauri-apps/*` (enforced by ESLint).
- Components are PascalCase, one per file; hooks are `use-<name>.ts`.
- No hard-coded user-facing text: use `t('…')` with typed keys; add every key to **both** catalogues.
- Colours and fonts come from the tokens of `theme/theme.css` (Tailwind utilities such as `bg-surface`, `text-fg-muted`); never hard-code a colour. Spacing uses Tailwind's default scale.
- Accessibility: semantic elements, labels on controls, visible focus, win/loss never conveyed by colour alone.
- Data comes from TanStack Query hooks wrapping services; components never call a service directly in render.
