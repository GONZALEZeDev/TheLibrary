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

## License

[MIT](LICENSE). Code signing policy: [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).
