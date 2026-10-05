//! Pie's Tauri application: the connection lifecycle, the supervision of
//! processes, and the IPC bridge to the React frontend.
//!
//! [`pi_rpc`] mirrors the `pi --mode rpc` protocol of Pi and stays free of app
//! concerns. Everything policy-shaped lives here: where logs go ([`logging`]),
//! what a connected host is ([`connection`]), and what the frontend can ask for
//! ([`commands`]).

pub mod commands;
pub mod connection;
pub mod error;
pub mod logging;
pub mod pi_rpc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pie starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::connect::connect,
            commands::connect::disconnect,
            commands::connect::trust_host_key,
            commands::files::list_dirs,
            commands::files::list_sessions,
            commands::keys::pick_private_key,
            commands::platform::platform
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
