# TheLibrary

A desktop companion for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/) players who main **Paige**: after every match, see what went well, what to work on, and how you progress over time.

> **Status: beta.** TheLibrary is usable and updates itself; expect rough edges, and please report them in the [issues](https://github.com/GONZALEZeDev/TheLibrary/issues).

TheLibrary is a free, open-source fan project (MIT). It is **not affiliated with or endorsed by Valve**. Deadlock is a trademark of Valve Corporation; all game content belongs to Valve.

## What it does

- **Dashboard** — your latest matches at a glance, with the points the review found.
- **Matches** — your match history and a detailed view of every match: timeline, events, strengths and areas to improve.
- **Review** — your last 20 matches summed up: the weak and strong points that recur, every stat compared with the Paige players of the tier above and with the 20 matches before, your deaths by phase and when you buy your resistance items.
- **Private by design** — your history and analysis stay on your computer; only public match data is downloaded. No TheLibrary account, no telemetry.
- **French and English** interface.

## Installation

TheLibrary runs on Windows 10 and 11 (64-bit).

1. Open the [latest release](https://github.com/GONZALEZeDev/TheLibrary/releases/latest) and download `TheLibrary_<version>_x64-setup.exe`.
2. Run it. It installs for your Windows user only, with no administrator rights, and installs the Microsoft Edge WebView2 runtime if your PC lacks it.
3. Windows SmartScreen may say that it protected your PC from an unknown publisher: the installer is not signed with a code signing certificate yet (it is planned through [SignPath Foundation](https://signpath.org/), see the [code signing policy](CODE_SIGNING_POLICY.md)). Click **More info**, then **Run anyway**. The installer is built from this repository by its public [release workflow](.github/workflows/release.yml).

   If Windows says instead that it cannot access the file, your antivirus is most likely still analysing the freshly downloaded installer (ESET does, without any notice): wait a minute, then run it again. You can check that your download is intact: its SHA-256, shown next to the file on the release page, must match `Get-FileHash <file>` in PowerShell.

4. Start TheLibrary and link your Steam account: you sign in on Steam's own page, in your browser, and TheLibrary never sees your password.

### Updates

At each start, TheLibrary checks whether a newer version is out. If there is one, it shows what changed, in your language, and asks you: **Install now** downloads it, checks its signature, installs it over the current version and restarts the app, keeping your data; **Later** asks again at the next start. You can also check at any time in Settings → About. An update is never installed without your choice.

### Uninstalling

Uninstall TheLibrary from Windows Settings → Apps → Installed apps. The uninstaller offers to delete the application data too; leave that box unticked and your data stays on the PC, so that a reinstall finds it again. To remove it later, delete the folders `%APPDATA%\io.github.gonzalezedev.thelibrary` and `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary`. What the app keeps and contacts is described in [PRIVACY.md](PRIVACY.md).

## Roadmap

The first version was built in six milestones:

1. **M1 Foundations** — tooling, CI, the desktop shell and its screens, the theme, French and English.
2. **M2 Data** — synchronisation of your match history (M2a), then the local archive of your Paige matches (M2b).
3. **M3 Account** — Steam sign-in and onboarding.
4. **M4 Analysis** — metrics compared with your rank and your own history, strengths and weaknesses on the match page (M4a); the rest of the match in tabs, with your damage by source compared with your habits, your final build and the 12 players (M4b); the review of your last 20 matches, compared with the players of the tier above and with the 20 matches before (M4c).
5. **M5 Screens** — dashboard, match history, match detail and settings.
6. **M6 Delivery** — the Windows installer, updates inside the app and the release workflow.

Next: Authenticode signing of the installer, and more analysis.

## Data source

Match data comes from the community-run [deadlock-api.com](https://deadlock-api.com) (MIT). Thanks to its maintainers.

The licences of the software TheLibrary includes are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

Prerequisites (Windows 10/11):

- [Node.js](https://nodejs.org/) 26 and [pnpm](https://pnpm.io/) 12.11.2 (`npm install --global pnpm@12.11.2`)
- [Rust](https://rustup.rs/) stable (1.90 or later) with the MSVC toolchain and the "Desktop development with C++" workload of Visual Studio Build Tools
- The Microsoft Edge WebView2 runtime (preinstalled on Windows 11)

```bash
pnpm install        # install dependencies (dependency install scripts are blocked by default)
pnpm dev            # UI only, in the browser, on synthetic data (http://localhost:1420)
pnpm dev:desktop    # full desktop app, under its own development identifier (see CONTRIBUTING.md)
pnpm check          # type-check + lint + format check + tests
```

The architecture, conventions and workflow are described in [CONTRIBUTING.md](CONTRIBUTING.md); the reasons behind the main technical choices are recorded in [docs/adr](docs/adr).

## Project structure

TheLibrary is a [Tauri](https://tauri.app/) app: a small Rust shell opens a window, and everything you see and everything the app does is written in TypeScript and React and runs inside that window ([en français](docs/project-structure.fr.md)). The main folders:

```text
TheLibrary/
├── src/                    The app itself, in TypeScript
│   ├── main.tsx            Starting point: picks the adapters, builds the services, shows the window
│   ├── core/               Pure logic: game data, the rules of the API, the match analysis
│   ├── ports/              Interfaces for everything that touches the outside world
│   ├── adapters/           Implementations of those interfaces
│   │   ├── tauri/          …in the desktop app (HTTP, database, files, logs, Steam sign-in, updates)
│   │   ├── browser/        …with browser APIs, in every build (the compression worker)
│   │   └── dev/            …for tests and `pnpm dev` (synthetic data, in-memory storage)
│   ├── services/           What the app does: sync, archive, analysis, review, account, updates
│   ├── workers/            Heavy work off the main thread (zstd compression)
│   ├── ui/                 The screens, in React
│   │   ├── app/            Window frame, navigation, error screens
│   │   ├── features/       One folder per screen (dashboard, matches, match detail, review, Paige, settings…)
│   │   ├── components/     Shared building blocks (buttons, panels, tabs…)
│   │   ├── i18n/           English and French texts
│   │   └── theme/          Colours, spacing and fonts
│   └── test/               Shared test helpers and the weekly check of the real API
├── src-tauri/              The Rust desktop shell
│   ├── src/                Native plugins, window hardening, the list of database migrations
│   ├── capabilities/       What the window is allowed to do, kept to the minimum
│   ├── tauri.conf.json     Window, security policy, installer and updater settings
│   └── icons/              App icons in every size Windows and the installer use
├── migrations/             The SQLite database schema, one numbered file per change
├── scripts/                check-dev-code.ts (no development code in a release) and release/ (release tooling)
├── .github/                CI, release and API canary workflows, Renovate settings
├── docs/adr/               Architecture decision records: why each main choice was made
├── assets/                 The source drawing of the app icon
└── types/                  Type declarations for a tool that ships none
```

At the root you also find the build and tooling configuration (`package.json`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`…) and the documents for players and contributors: the changelogs in English and French, [CONTRIBUTING.md](CONTRIBUTING.md), [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), the [code signing policy](CODE_SIGNING_POLICY.md) and the [third-party notices](THIRD_PARTY_NOTICES.md).

### How the pieces fit together

The code under `src/` is split into layers, and each layer only talks to the ones below it (ESLint enforces it):

- **`core/`** knows the game and the rules, and nothing else: it takes data and returns data, with no network, disk or clock.
- **`ports/`** describe what the app needs from the outside world (download a page, run a SQL query, write a file…) without saying how.
- **`adapters/`** do it: with the Tauri plugins in the desktop app, with memory and synthetic data in the tests and in `pnpm dev`. That is why the whole app runs in a plain browser on fake data.
- **`services/`** are the actions of the app (synchronise, archive a match, analyse it, build the review…). They use `core/` for the rules and the ports for the side effects.
- **`ui/`** shows the results and only calls services.

The journey of one match, from deadlock-api to the screen:

1. **Download the history.** At startup, every 13 minutes and on demand, the synchronisation asks [deadlock-api](https://deadlock-api.com) for your recent matches. `core/deadlock-api/` checks and translates the answer, and the matches are saved in the local SQLite database.
2. **Archive the detail.** For each Paige match of the last 90 days, the app downloads the full detail, keeps only what concerns you, compresses it with zstd in a Web Worker so the window never freezes, and saves it as one file per match on your PC ([ADR 0003](docs/adr/0003-user-centric-archive-zstd.md)).
3. **Analyse it.** Right after, the metrics of `core/analysis/` run on each new archive. Their values are stored in the database, so the pages compare matches without reopening the archives.
4. **Show it.** When you open a match, its screen in `ui/features/match-detail/` asks the analysis service for it. The service compares your figures with your own habits and with players of your rank ([ADR 0004](docs/adr/0004-analysis-references.md)), and the screen draws the result.

Each layer has a README that lists its folders and its rules: [core](src/core/README.md), [ports](src/ports/README.md), [adapters](src/adapters/README.md), [services](src/services/README.md), [workers](src/workers/README.md), [ui](src/ui/README.md) and [migrations](migrations/README.md). [CONTRIBUTING.md](CONTRIBUTING.md) explains the conventions and how to release a version.

## License

[MIT](LICENSE). Code signing policy: [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).
