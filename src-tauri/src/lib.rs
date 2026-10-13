//! Tauri shell of TheLibrary: plugin registration and webview hardening.
//!
//! The application logic is written in TypeScript and runs in the webview. This file
//! only wires the native plugins, opens the settings store and adds a navigation guard so the
//! window can never leave the bundled app.

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime, Url, Webview};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
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
        .plugin(settings_store_plugin());

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

/// Cancels every top-level navigation that would leave the app (clicked external links,
/// `window.location` changes, injected redirects). Sub-resources are governed by the CSP, and
/// `window.open`/`target="_blank"` are already denied by Tauri when no new-window handler is set.
/// External links must be opened in the system browser through a dedicated plugin (later milestones).
fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let allowed = is_bundled_frontend_url(url) || is_dev_server_url(webview, url);
            if !allowed {
                // Only the origin and the path are logged: the query string and the fragment can
                // carry tokens (e.g. the parameters of an OpenID sign-in).
                log::warn!(
                    "blocked navigation of webview '{}' to {}{}",
                    webview.label(),
                    url.origin().ascii_serialization(),
                    url.path()
                );
            }
            allowed
        })
        .build()
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
}
