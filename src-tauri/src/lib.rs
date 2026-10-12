//! Pie's Tauri application: the reach to a machine, its sessions, and the IPC
//! bridge to the React frontend.
//!
//! The `pi_rpc` crate mirrors the `pi --mode rpc` protocol of Pi and stays free of
//! app concerns. Below it, three layers of this app: [`channel`] is one started
//! program's bytes and life, [`host`] is the machine pie reaches and what runs on
//! it, and [`session`] is the pi sessions of that machine. [`commands`] is the
//! boundary the frontend talks to, [`error`] is what it hears when something
//! fails, [`log`] is where every line of the app goes, and [`state`] is what
//! the commands of one run share.

pub mod channel;
pub mod commands;
pub mod error;
pub mod host;
pub mod log;
pub mod session;
pub mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log::init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pie starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app::open_url,
            commands::app::platform,
            commands::app::provider_logo,
            commands::host::connect,
            commands::host::disconnect,
            commands::host::get_connection,
            commands::host::list_dirs,
            commands::host::trust_host_key,
            commands::log::log,
            commands::log::log_levels,
            commands::pick::pick_images,
            commands::pick::pick_private_key,
            commands::session::abort,
            commands::session::abort_bash,
            commands::session::attach_session,
            commands::session::bash,
            commands::session::clear_queue,
            commands::session::compact,
            commands::session::detach_session,
            commands::session::get_available_models,
            commands::session::get_available_thinking_levels,
            commands::session::get_commands,
            commands::session::get_entries,
            commands::session::get_last_assistant_text,
            commands::session::get_session_stats,
            commands::session::get_state,
            commands::session::list_sessions,
            commands::session::prompt,
            commands::session::set_auto_compaction,
            commands::session::set_model,
            commands::session::set_session_name,
            commands::session::set_thinking_level,
            commands::session::switch_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
