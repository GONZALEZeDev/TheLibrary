//! Binary entry point. Kept minimal on purpose: everything lives in `lib.rs`.

// Prevents an additional console window on Windows in release builds. DO NOT REMOVE!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    the_library_lib::run();
}
