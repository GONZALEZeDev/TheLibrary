# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

> **Status:** TheLibrary has applied to SignPath Foundation. Until the project is accepted, the installers are not signed with a code signing certificate (versions 0.1.0 and 0.1.1 are not). Once it is, every release is signed as described below, and Windows shows "SignPath Foundation" as the publisher.

## What is signed

- Only the Windows installer of TheLibrary (`TheLibrary_<version>_x64-setup.exe`), attached to the [GitHub releases](https://github.com/GONZALEZeDev/TheLibrary/releases) of this repository.
- It is built only from the source code of this repository, by its public [release workflow](.github/workflows/release.yml) on GitHub-hosted runners, from a version tag of the `main` branch. No installer built on a personal computer is ever signed.
- Third-party libraries included in the app keep their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)); no upstream binary is signed under this policy.

Independently of the Authenticode signature, every update the app installs is verified against the public key of the Tauri updater built into the app ([ADR 0007](docs/adr/0007-updates-through-github-releases.md)).

## Team roles

TheLibrary is maintained by one person today. Every role is held by the members listed here, who use multi-factor authentication on GitHub and SignPath.

| Role      | Members                                         | What they do                                                               |
| --------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Authors   | [GONZALEZeDev](https://github.com/GONZALEZeDev) | Change the source code of this repository                                  |
| Reviewers | [GONZALEZeDev](https://github.com/GONZALEZeDev) | Review every contribution from outside the team before it is merged        |
| Approvers | [GONZALEZeDev](https://github.com/GONZALEZeDev) | Approve each signing request, after trying the draft release it belongs to |

Contributions from outside the team arrive as pull requests and are merged only after review. Release tags (`v*`) can be created by the repository administrators only.

## Privacy

TheLibrary sends no telemetry and has no account on the project's side. It contacts only the services it needs, each listed in [PRIVACY.md](PRIVACY.md): deadlock-api.com for match data and images, Steam to link the player's account, and GitHub to look for and download updates. Nothing is sent to any other networked system.

## Reporting a problem

If you believe a signed TheLibrary binary does something this policy or the README does not describe, please report it as described in [SECURITY.md](SECURITY.md).
