//! Pie's Tauri application: connection lifecycle, process supervision, and the
//! IPC bridge to the React frontend.
//!
//! [`pi_rpc`] mirrors Pi's `pi --mode rpc` protocol and stays free of app
//! concerns; everything policy-shaped lives here, including where logs go
//! ([`logging`]).

pub mod logging;
pub mod pi_rpc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pie starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
