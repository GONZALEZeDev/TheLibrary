# Changelog

All notable changes to TheLibrary are listed here, newest first. The French version is
[CHANGELOG.fr.md](CHANGELOG.fr.md); the app shows the summary of a new version in its own language
when it offers the update.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/). Each version may have the sections Added, Changed,
Fixed and Removed.

## [Unreleased]

### Added

- The match replay shows the 12 players in a strip above the map, with their health or the seconds left before they respawn.
- A live feed of the last five events (deaths with their killer, objectives lost, the Mid Boss and who took the Rejuvenator), a fixed history of the objectives destroyed with the colour of their lane, and a reminder of the game's timings.
- A legend under the replay's tracks. Each kind of event has one icon (the objective's own, the Mid Boss, a skull for deaths) whose colour tells the team, and the map shows the objectives as icons in their team's colour and the official Mid Boss icon.

### Changed

- The replay uses the game's teams, Hidden King and Archmother, with their colours and logos, on the map and everywhere around it.
- The time bar and its tracks sit right under the two teams, so the replay can be driven without scrolling; the teams are centred.
- The events under the time bar are split into three titled tracks (objectives, Mid Boss, deaths), separated by a thin line and no longer overlapping their titles.

### Removed

- The replay's "At mm:ss" panel, replaced by the live feed and the players strip.
- The "Game schedule" row under the time bar; its timings are now in the rules reminder.

## [0.1.3] - 2026-11-13

### Added

- A replay of the match on the map, in the Timeline tab: the 12 heroes move second by second with the objectives, under a playback bar, next to an "At mm:ss" panel that lists the objectives destroyed and the dead players, and the events of the match.

### Changed

- The review summary sets your weak and strong points side by side when the window is wide.
- The match list alternates the background of its rows, so each match reads as one line.
- Opening a match or the review shows a short "Analysing…" step before the page, even when the data is already there; going back to a page skips it, so the page returns where you left it.
- While a sync runs, a match still waiting for its detail cannot be opened: its row says "In progress…" until the sync has archived it.

### Removed

- Street Brawl matches: the app no longer downloads them, and removes the ones it had stored.

## [0.1.2] - 2026-11-02

### Added

- A Paige page: her artwork, her keywords, all her stats with what each level adds, her weapon, and her four abilities. Click an ability to see its details and switch its upgrade tiers (1, 2 and 5 points) on and off to see what they change, including the timings the game does not show.

### Changed

- The interface uses the Alegreya fonts, closer to the game's look.

## [0.1.1] - 2026-10-28

### Changed

- Settings → Storage: while the app checks what a lower limit would remove, a "Checking…" line shows next to the limit.

## [0.1.0] - 2026-10-28

First public beta.

### Added

- Link your Steam account in your browser; TheLibrary never sees your password.
- Your Deadlock match history, synchronised from deadlock-api.com at startup, every 13 minutes and on demand.
- The detail of your Paige matches of the last 90 days, kept on your PC.
- A match page with your strengths and weaknesses compared with Paige players of your rank and with your own habits, your damage by source, your final build, the 12 players and the timeline of the match.
- A review of your last 20 matches: the weak and strong points that recur, your deaths by phase and when you buy your resistance items.
- A dashboard on your latest matches and a match history with filters.
- Settings: account, synchronisation, storage limit, language, diagnostics.
- French and English interface.
- Updates inside the app: TheLibrary tells you at startup when a new version is out, and installs it when you choose to.
