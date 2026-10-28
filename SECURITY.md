# Security policy

## Supported versions

Only the latest release of TheLibrary receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and click **Report a vulnerability**. Include the affected version, the steps to reproduce and the impact you observed.

You should receive an acknowledgement within 7 days. Once the issue is confirmed, a fix is prepared privately and released as soon as possible, and you are credited in the release notes unless you prefer otherwise.

## Scope

In scope: the TheLibrary desktop application and its build/release pipeline. Out of scope: vulnerabilities of third-party services it talks to (deadlock-api.com, Steam) — please report those to their maintainers.

## Design principles

Least-privilege Tauri capabilities (`src-tauri/capabilities/`), a strict Content Security Policy and a navigation guard that keep the window on the bundled app (`src-tauri/`), a hardened dependency supply chain (exact npm versions, dependency install scripts blocked, npm versions younger than one day refused, `pnpm audit` and `cargo audit` in CI, CI actions pinned by commit SHA), no secrets in the code and no telemetry. Releases are built only by the public release workflow, and every update is verified by the app against the public key of the updater before it runs ([ADR 0007](docs/adr/0007-updates-through-github-releases.md)); Authenticode signing of the installer is planned.
