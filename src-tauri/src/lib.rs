//! Tauri shell of TheLibrary: plugin registration and webview hardening.
//!
//! The application logic is written in TypeScript and runs in the webview. This file
//! only wires the native plugins, opens the settings store, lists the database migrations and
//! adds a navigation guard so the window can never leave the bundled app.

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime, Url, Webview};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use tauri_plugin_sql::{Migration, MigrationKind, PluginConfig as SqlPluginConfig};
use tauri_plugin_store::StoreExt;

/// Label of the only application window (`app.windows[0].label` in `tauri.conf.json`).
#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";

/// The active log file is rotated once it would grow past 2 MiB.
const LOG_MAX_FILE_SIZE_BYTES: u128 = 2 * 1024 * 1024;

/// Number of rotated log files kept next to the active one (`TheLibrary.log`).
/// Never set it to 0: the plugin computes `keep_count - 1`, which would underflow.
const LOG_ROTATED_FILES_KEPT: usize = 5;

/// File of the settings store, relative to the app data folder.
///
/// Must stay equal to `SETTINGS_FILE_NAME` in `src/adapters/tauri/tauri-settings-store.adapter.ts`:
/// the webview finds the store opened here by this name.
const SETTINGS_STORE_FILE: &str = "settings.json";

/// Connection string of the application database: `thelibrary.db` in the app config folder,
/// i.e. `%APPDATA%\io.github.gonzalezedev.thelibrary\thelibrary.db` on Windows.
///
/// Must stay equal to `plugins.sql.preload` in `tauri.conf.json` (checked by a test below) and to
/// `DATABASE_URL` in `src/adapters/tauri/tauri-database.adapter.ts`: the plugin finds the
/// migrations and the open connection by this exact string.
const DATABASE_URL: &str = "sqlite:thelibrary.db";

/// Scheme and host serving the bundled frontend (`build.frontendDist`) in production builds.
///
/// Windows and Android expose Tauri's `tauri` custom protocol as `http://tauri.localhost`
/// (`https://tauri.localhost` if `app.windows[].useHttpsScheme` is ever enabled: update this
/// constant together with that setting). macOS, Linux and iOS use `tauri://localhost`.
#[cfg(any(windows, target_os = "android"))]
const BUNDLED_FRONTEND_ORIGIN: (&str, &str) = ("http", "tauri.localhost");
#[cfg(not(any(windows, target_os = "android")))]
const BUNDLED_FRONTEND_ORIGIN: (&str, &str) = ("tauri", "localhost");

/// Builds and runs the Tauri application.
///
/// # Panics
///
/// Panics if the application cannot start, e.g. when the main window cannot be created.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Single instance MUST be registered first. Plugins are set up in registration order and
    // this plugin makes a second process exit from inside its own `setup` hook. Registered
    // later, that second process would first run the setup hook of every plugin registered
    // before it (opening, possibly rotating, the log file shared with the running instance;
    // reading the window-state file; ...) and only then exit.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        log::info!("second instance launched, focusing the existing window");
        focus_main_window(app);
    }));

    // Logging comes right after, so that everything set up afterwards can log.
    let builder = builder
        .plugin(log_plugin())
        .plugin(tauri_plugin_store::Builder::new().build())
        // Must come after the store plugin, whose state it needs. Plugin setup hooks run in
        // registration order, before the windows declared in `tauri.conf.json` are created: the
        // settings store is therefore open before the webview can ask for it.
        .plugin(settings_store_plugin())
        // HTTP requests of the webview, limited to the hosts allowed in `capabilities/default.json`.
        .plugin(tauri_plugin_http::init())
        // Opens the database and applies its pending migrations, also before any window exists.
        .plugin(sql_plugin());

    // Restores the size/position/maximized state of the windows on startup and saves it on exit.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::new().build());

    builder
        .plugin(navigation_guard())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Logs to stdout (visible in `tauri dev`) and to `{app_log_dir}/TheLibrary.log`,
/// i.e. `%LOCALAPPDATA%\io.github.gonzalezedev.thelibrary\logs\TheLibrary.log` on Windows.
fn log_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        // `targets` replaces the default target list, spelled out here on purpose.
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: None }),
        ])
        // The plugin defaults to `Trace`, which floods the file with tao/wry internals.
        .level(log::LevelFilter::Info)
        .max_file_size(LOG_MAX_FILE_SIZE_BYTES)
        // Keeps the active file plus at most N rotated `TheLibrary_<date>.log` files.
        .rotation_strategy(RotationStrategy::KeepSome(LOG_ROTATED_FILES_KEPT))
        .build()
}

/// Opens the settings store so the webview never has to.
///
/// The store plugin's `load` command accepts any path (absolute paths and `..` included), ignores
/// read/parse errors and saves every loaded store when the app exits: a script running in the
/// webview could use it to overwrite any file the user can write. The webview is therefore not
/// granted `load` (see `capabilities/default.json`) and only looks up, with `get_store`, the
/// store opened here.
///
/// Auto-save is disabled because the TypeScript adapter saves explicitly after every write (the
/// store plugin still saves once more when the app exits).
fn settings_store_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("settings-store")
        .setup(|app, _api| {
            // A failure aborts the startup instead of leaving the app without settings.
            app.store_builder(SETTINGS_STORE_FILE)
                .disable_auto_save()
                .build()?;
            Ok(())
        })
        .build()
}

/// The SQL plugin, with the migrations of the application database.
///
/// The database listed in `plugins.sql.preload` (`tauri.conf.json`) is opened at startup, which
/// applies its pending migrations, each in its own transaction; a failure stops the startup. The
/// webview is not granted the plugin's `load` command, whose path is not restricted (an absolute
/// path would escape the app folder), so it cannot open another connection. The plugin has no
/// finer permission than `execute`, though: SQL such as `ATTACH` could still reach another file,
/// which is one more reason why no foreign code may run in the webview (CSP `script-src 'self'`).
fn sql_plugin<R: Runtime>() -> TauriPlugin<R, Option<SqlPluginConfig>> {
    tauri_plugin_sql::Builder::new()
        .add_migrations(DATABASE_URL, migrations())
        .build()
}

/// The migrations of the application database, oldest first (`migrations/*.sql` at the root of
/// the repository).
///
/// The plugin stores a checksum of every applied migration and refuses to open a database whose
/// applied migration changed, even by a whitespace. A released migration is therefore never
/// edited: a change always goes in a new file, with the next version number.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "matches, api cache and sync state",
        sql: include_str!("../../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

/// Cancels every top-level navigation that would leave the app (clicked external links,
/// `window.location` changes, injected redirects). Sub-resources are governed by the CSP, and
/// `window.open`/`target="_blank"` are already denied by Tauri when no new-window handler is set.
/// External links must be opened in the system browser through a dedicated plugin (later milestones).
fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let allowed = is_bundled_frontend_url(url) || is_dev_server_url(webview, url);
            if !allowed {
                log::warn!(
                    "blocked navigation of webview '{}' to {}",
                    webview.label(),
                    loggable_url(url)
                );
            }
            allowed
        })
        .build()
}

/// The part of a blocked URL that is safe to write to the log file.
///
/// Only the origin and the path are kept: the query string and the fragment can carry tokens
/// (e.g. the parameters of an OpenID sign-in). A URL with an opaque origin (`data:`,
/// `javascript:`, `file:`…) has no host, and its "path" is the payload itself: only its scheme is
/// kept, as `data:`.
fn loggable_url(url: &Url) -> String {
    let origin = url.origin();
    if origin.is_tuple() {
        format!("{}{}", origin.ascii_serialization(), url.path())
    } else {
        format!("{}:", url.scheme())
    }
}

/// Whether `url` points to the frontend embedded in the binary (production builds).
fn is_bundled_frontend_url(url: &Url) -> bool {
    let (scheme, host) = BUNDLED_FRONTEND_ORIGIN;
    url.scheme() == scheme && url.host_str() == Some(host) && url.port().is_none()
}

/// Whether `url` points to the Vite dev server (`build.devUrl`). Only honoured in dev builds:
/// a release build must never render whatever happens to listen on that local port.
fn is_dev_server_url<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    tauri::is_dev()
        && webview
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev_url| dev_url.origin() == url.origin())
}

/// Brings the existing main window back to the foreground.
#[cfg(desktop)]
fn focus_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("window '{MAIN_WINDOW_LABEL}' not found, cannot focus it");
        return;
    };
    // Focusing a minimized window does not restore it on Windows: unminimize first.
    let result = window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus());
    if let Err(error) = result {
        log::warn!("failed to focus window '{MAIN_WINDOW_LABEL}': {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parses a URL written by a test; a typo in the test itself fails loudly.
    fn parse(value: &str) -> Url {
        Url::parse(value).expect("test URL must be valid")
    }

    /// Builds a URL on the bundled frontend host, e.g. `http://tauri.localhost<suffix>` on
    /// Windows. The scheme and the host come from `BUNDLED_FRONTEND_ORIGIN`, so the tests hold on
    /// every platform.
    fn bundled_url(suffix: &str) -> Url {
        let (scheme, host) = BUNDLED_FRONTEND_ORIGIN;
        parse(&format!("{scheme}://{host}{suffix}"))
    }

    #[test]
    fn migrations_are_numbered_from_one_without_gaps() {
        let versions: Vec<i64> = migrations()
            .iter()
            .map(|migration| migration.version)
            .collect();
        let expected: Vec<i64> = (1..).take(versions.len()).collect();
        assert_eq!(versions, expected);
    }

    #[test]
    fn migrations_are_up_migrations_with_sql() {
        for migration in migrations() {
            assert!(matches!(migration.kind, MigrationKind::Up));
            assert!(!migration.sql.trim().is_empty());
        }
    }

    /// The `migrations/` folder at the root of the repository.
    const MIGRATIONS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../migrations");

    /// The `capabilities/` folder of the Tauri project.
    const CAPABILITIES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities");

    /// Names of the entries of a folder, sorted (the order of zero-padded migration names).
    fn entry_names(folder: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .unwrap_or_else(|error| panic!("cannot read the folder {folder}: {error}"))
            .map(|entry| {
                let entry = entry.expect("a folder entry must be readable");
                entry.file_name().to_string_lossy().into_owned()
            })
            .collect();
        names.sort();
        names
    }

    /// The version of a migration file: the number before the first `_` of its name
    /// (`0001_init.sql` is version 1).
    fn migration_version(file_name: &str) -> i64 {
        let digits = file_name
            .split_once('_')
            .map(|(prefix, _)| prefix)
            .filter(|prefix| prefix.bytes().all(|byte| byte.is_ascii_digit()));
        let version = digits.and_then(|prefix| prefix.parse().ok());
        version.unwrap_or_else(|| {
            panic!(
                "migrations/{file_name} must be named NNNN_description.sql, \
                 e.g. 0002_add_notes.sql"
            )
        })
    }

    #[test]
    fn migrations_list_every_file_of_the_migrations_folder() {
        // The sql.js tests apply every file of the folder, the desktop app only the entries of
        // `migrations()`: a file without an entry would pass the tests and never reach a user.
        let files: Vec<String> = entry_names(MIGRATIONS_DIR)
            .into_iter()
            .filter(|name| name.ends_with(".sql"))
            .collect();
        // Checked first: a badly named file has no version, so no entry could ever match it.
        let versions: Vec<i64> = files.iter().map(|name| migration_version(name)).collect();
        let listed = migrations();

        // The files whose version no entry has, wherever they sit in the folder (the missing
        // entry is not always the last one).
        let unlisted: Vec<&String> = files
            .iter()
            .zip(&versions)
            .filter(|(_, version)| {
                !listed
                    .iter()
                    .any(|migration| migration.version == **version)
            })
            .map(|(file_name, _)| file_name)
            .collect();
        assert!(
            unlisted.is_empty(),
            "migrations() has no entry for {unlisted:?}: add one per file, in file name order, \
             with the version of the file name and the text of the file (`include_str!`)"
        );
        assert_eq!(
            listed.len(),
            files.len(),
            "migrations() lists {} entries but migrations/ holds only {} .sql files ({files:?}): \
             remove the entry that has no .sql file in migrations/",
            listed.len(),
            files.len()
        );
        for (position, ((file_name, version), migration)) in
            files.iter().zip(&versions).zip(&listed).enumerate()
        {
            let position = position + 1;
            assert_eq!(
                migration.version, *version,
                "entry {position} of migrations() is for {file_name}: \
                 its version must be the number of the file name"
            );
            let text = std::fs::read_to_string(format!("{MIGRATIONS_DIR}/{file_name}"))
                .unwrap_or_else(|error| panic!("cannot read migrations/{file_name}: {error}"));
            assert!(
                migration.sql == text,
                "entry {position} of migrations() is for {file_name}: \
                 its sql must be `include_str!` of that file (the text differs)"
            );
        }
    }

    /// Parses a configuration file embedded by a test; a malformed file fails loudly.
    fn parse_json(source: &str, file_name: &str) -> serde_json::Value {
        serde_json::from_str(source)
            .unwrap_or_else(|error| panic!("{file_name} must be valid JSON: {error}"))
    }

    /// `tauri.conf.json`, the release configuration.
    fn release_config() -> serde_json::Value {
        parse_json(include_str!("../tauri.conf.json"), "tauri.conf.json")
    }

    /// `capabilities/default.json`, the permissions of the main window.
    fn default_capability() -> serde_json::Value {
        parse_json(
            include_str!("../capabilities/default.json"),
            "capabilities/default.json",
        )
    }

    #[test]
    fn database_url_is_the_preloaded_database() {
        // A preload entry that differs from DATABASE_URL would open another, unmigrated database.
        assert_eq!(
            release_config()["plugins"]["sql"]["preload"],
            serde_json::json!([DATABASE_URL])
        );
    }

    #[test]
    fn main_window_is_the_only_window_granted_permissions() {
        // Another window label would hand the webview permissions to a window nobody reviewed.
        assert_eq!(default_capability()["windows"], serde_json::json!(["main"]));
    }

    #[test]
    fn default_capability_has_only_the_reviewed_keys() {
        // A new key (`webviews`, `remote`, `local`, `platforms`…) changes who gets the
        // permissions, which the pins on `windows` and `permissions` alone would not show.
        let capability = default_capability();
        let mut keys: Vec<&str> = capability
            .as_object()
            .expect("capabilities/default.json must be an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "$schema",
                "description",
                "identifier",
                "permissions",
                "windows"
            ]
        );
    }

    #[test]
    fn main_window_permissions_are_the_reviewed_ones() {
        // Any added permission, or a wider `allow` URL, gives the webview a power that was never
        // reviewed: review it, then update this list on purpose.
        assert_eq!(
            default_capability()["permissions"],
            serde_json::json!([
                "log:default",
                "store:allow-get-store",
                "store:allow-get",
                "store:allow-set",
                "store:allow-save",
                {
                    "identifier": "http:default",
                    "allow": [{ "url": "https://api.deadlock-api.com/*" }]
                },
                "sql:allow-select",
                "sql:allow-execute"
            ])
        );
    }

    #[test]
    fn main_window_cannot_open_another_database() {
        // `sql:allow-load` (also part of `sql:default`) lets the webview open any path, an
        // absolute one included: the database is opened by the shell only (see `sql_plugin`).
        let capability = default_capability();
        let permissions = capability["permissions"]
            .as_array()
            .expect("permissions must be a list");
        for permission in permissions {
            let identifier = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .expect("a permission must be a string or an object with an identifier");
            if identifier.starts_with("sql:") {
                assert!(
                    ["sql:allow-select", "sql:allow-execute"].contains(&identifier),
                    "{identifier} must not be granted: `sql:allow-load` and `sql:default` (which \
                     includes load) would let the webview open any database file"
                );
            }
        }
    }

    #[test]
    fn capabilities_folder_holds_only_default_json() {
        // Tauri grants every capability file of the folder to the windows it names: a new file
        // would add permissions without touching `default.json`.
        assert_eq!(entry_names(CAPABILITIES_DIR), ["default.json"]);
    }

    #[test]
    fn http_redirects_stay_inside_the_allowed_scope() {
        // Without `scopeRedirects`, an allowed host could redirect a request to a host that is not.
        assert_eq!(
            release_config()["plugins"]["http"]["scopeRedirects"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn webview_security_is_the_reviewed_one() {
        // A looser policy (`unsafe-inline`, another script or connect host…) lets foreign code run
        // in the webview; any other key (an inline `capabilities` list, `assetProtocol`,
        // `devCsp`, `pattern`…) changes what the webview may do or load without touching the files
        // above, so it must be reviewed too.
        assert_eq!(
            release_config()["app"]["security"],
            serde_json::json!({
                "csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
                        worker-src 'self'; style-src 'self'; \
                        img-src 'self' data: https://assets-bucket.deadlock-api.com; \
                        font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; \
                        object-src 'none'; base-uri 'none'; form-action 'none'; \
                        frame-ancestors 'none'"
            })
        );
    }

    #[test]
    fn dev_app_never_shares_the_data_folders_of_the_release() {
        // Same identifier or product name: the dev build would read and migrate the database
        // and the settings of an installed release.
        let release = release_config();
        let dev = parse_json(
            include_str!("../tauri.dev.conf.json"),
            "tauri.dev.conf.json",
        );
        let release_identifier = release["identifier"]
            .as_str()
            .expect("tauri.conf.json must have an identifier");
        assert_eq!(
            dev["identifier"],
            serde_json::json!(format!("{release_identifier}.dev"))
        );
        // Read as strings: a dev file without `productName` would inherit the release one.
        let release_name = release["productName"]
            .as_str()
            .expect("tauri.conf.json must set productName");
        let dev_name = dev["productName"].as_str().expect(
            "tauri.dev.conf.json must set its own productName, or it inherits the release one",
        );
        assert_ne!(
            dev_name, release_name,
            "the dev app must not use the product name of the release"
        );
    }

    #[test]
    fn bundled_frontend_url_accepts_the_origin_root() {
        assert!(is_bundled_frontend_url(&bundled_url("/")));
    }

    #[test]
    fn bundled_frontend_url_accepts_a_path_and_a_query() {
        assert!(is_bundled_frontend_url(&bundled_url(
            "/library/paige?tab=builds#top"
        )));
    }

    #[test]
    fn bundled_frontend_url_rejects_a_host_that_only_starts_with_the_bundled_host() {
        // A prefix check on the host would let this look-alike through.
        assert!(!is_bundled_frontend_url(&bundled_url(".evil.com/")));
    }

    #[test]
    fn bundled_frontend_url_rejects_an_explicit_port() {
        // 1420 is the dev server port: it is never a default port, so `Url` keeps it.
        assert!(!is_bundled_frontend_url(&bundled_url(":1420/")));
    }

    #[test]
    fn bundled_frontend_url_rejects_another_scheme_on_the_bundled_host() {
        let (scheme, host) = BUNDLED_FRONTEND_ORIGIN;
        let other_scheme = if scheme == "https" { "http" } else { "https" };
        assert!(!is_bundled_frontend_url(&parse(&format!(
            "{other_scheme}://{host}/"
        ))));
    }

    #[test]
    fn bundled_frontend_url_rejects_another_host() {
        assert!(!is_bundled_frontend_url(&parse("https://example.com/")));
    }

    #[test]
    fn loggable_url_keeps_the_origin_and_the_path() {
        assert_eq!(
            loggable_url(&parse("https://example.com/a?b=c")),
            "https://example.com/a"
        );
    }

    #[test]
    fn loggable_url_drops_the_query_and_the_fragment() {
        assert_eq!(
            loggable_url(&parse(
                "https://example.com/callback?code=secret#access_token=secret"
            )),
            "https://example.com/callback"
        );
    }

    #[test]
    fn loggable_url_keeps_only_the_scheme_of_an_opaque_origin() {
        // The payload of a `data:` URL is its path: it must not reach the log file.
        assert_eq!(
            loggable_url(&parse("data:text/html,<p>secret</p>")),
            "data:"
        );
        assert_eq!(loggable_url(&parse("javascript:alert(1)")), "javascript:");
        assert_eq!(
            loggable_url(&parse("file:///C:/Users/me/page.html")),
            "file:"
        );
    }
}
