//! Build script: generates the Tauri context (config, capabilities, embedded assets) and
//! validates `tauri.conf.json` and every permission identifier of `capabilities/*.json`.

fn main() {
    tauri_build::build();
}
