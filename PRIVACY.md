# Privacy

TheLibrary is a desktop app that runs on your PC. It has no server of its own, no user account on the project's side, no telemetry, no analytics and no advertising. Nothing you do in the app is sent to the project.

## What the app keeps on your PC

- **Your Steam account id and public profile** (name and avatar), once you link your account. The app never sees your Steam password: you sign in on Steam's own page, in your browser.
- **Your match history and the detail of your Paige matches**, downloaded from deadlock-api.com, with the analysis the app computes from them.
- **Your settings** (language, storage limit, detailed log switch) and **log files**, which help understand a problem. The logs never contain a password or a secret; they may contain your account id and match ids.

These files live in your Windows user folders only:

- `%APPDATA%\io.github.gonzalezedev.thelibrary` — settings and database;
- `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary` — match archives, logs and the data of the app's window.

Unlinking your account in the settings deletes its matches, archives and history from the PC. When you uninstall the app, the uninstaller offers to delete these folders; left in place, they let a reinstall find your data again.

## What the app contacts

| Host                                            | Why                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `api.deadlock-api.com`                          | Your public match history and match details, the game catalogues and the community statistics.  |
| `assets-bucket.deadlock-api.com`                | Images of heroes, items and abilities.                                                          |
| `steamcommunity.com`, `avatars.steamstatic.com` | Linking your Steam account (in your browser), confirming the sign-in, and your avatar.          |
| `github.com` and its download hosts             | At each start, the update file of the latest release; when you choose to update, the installer. |

Like any web request, these send your IP address to the host, and the requests to deadlock-api carry the version of the app in their User-Agent. Each host handles them under its own privacy policy. Only public match data is downloaded: deadlock-api.com publishes it from Valve's public match records.

## Sharing logs

The log files stay on your PC. If you send them with a bug report (Settings → Diagnostics → open the log folder), know that they may contain your account id and match ids.

## Contact

Questions about privacy: open an issue on the [GitHub repository](https://github.com/GONZALEZeDev/TheLibrary). For a security problem, follow [SECURITY.md](SECURITY.md) instead.
