# TheLibrary

A desktop companion for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/) players who main **Paige**: after every match, see what went well, what to work on, and how you progress over time.

> **Status: early development.** The application foundation is being built; TheLibrary is not usable yet.

TheLibrary is a free, open-source fan project (MIT). It is **not affiliated with or endorsed by Valve**. Deadlock is a trademark of Valve Corporation; all game content belongs to Valve.

## What it will do

- **Dashboard** — your average stats over 7, 30 or 90 days, compared with Paige players of your rank and with your own history.
- **Matches** — your match history and a detailed view of every match: timeline, events, strengths and areas to improve.
- **Private by design** — your history and analysis stay on your computer; only public match data is downloaded. No TheLibrary account, no telemetry.
- **French and English** interface.

## Roadmap

The first version is built in six milestones:

1. **M1 Foundations** — tooling, CI, the desktop shell and its screens, the theme, French and English.
2. **M2 Data** — synchronisation of your match history (M2a), then the local archive of your Paige matches (M2b).
3. **M3 Account** — Steam sign-in and onboarding.
4. **M4 Analysis** — metrics compared with your rank and your own history, strengths and weaknesses: on the match page (M4a), then more of the match — items, players, damage by source (M4b) — and summaries over 7, 30 and 90 days (M4c).
5. **M5 Screens** — dashboard, match history, match detail and settings.
6. **M6 Delivery** — signed installer, automatic updates and the release workflow.

## Data source

Match data comes from the community-run [deadlock-api.com](https://deadlock-api.com) (MIT). Thanks to its maintainers.

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

## License

[MIT](LICENSE)
