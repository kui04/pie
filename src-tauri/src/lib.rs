//! Pie's Tauri application: the reach to a machine, its sessions, and the IPC
//! bus to the React frontend.
//!

mod bus;
mod channel;
mod commands;
mod error;
mod host;
mod log;
mod session;
mod state;

use commands::app::*;
use commands::filesystem::*;
use commands::host::*;
use commands::log::*;
use commands::session::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log::init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pie starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let bus = bus::Bus::new(app.handle().clone(), 8);
            app.manage(state::AppState::new(bus, app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_answer,
            app_open_url,
            app_platform,
            app_provider_logo,
            app_ready_for_answer,
            filesystem_create_dir_all,
            filesystem_read,
            filesystem_read_metadata,
            filesystem_select_files,
            host_attach_session,
            host_connect,
            host_connection_info,
            host_create_dir_all,
            host_delete_session,
            host_detach_session,
            host_dir_exists,
            host_disconnect,
            host_home_dir,
            host_list_dirs,
            host_list_sessions,
            host_reconnect,
            host_start_new_session,
            host_upload_file,
            log_log,
            log_log_levels,
            session_abort,
            session_abort_bash,
            session_abort_retry,
            session_bash,
            session_clear_queue,
            session_clone_session,
            session_compact,
            session_fork_session,
            session_get_available_models,
            session_get_available_thinking_levels,
            session_get_commands,
            session_get_entries,
            session_get_fork_messages,
            session_get_last_assistant_text,
            session_get_messages,
            session_get_session_stats,
            session_get_state,
            session_get_tree,
            session_prompt,
            session_set_auto_compaction,
            session_set_auto_retry,
            session_set_follow_up_mode,
            session_set_model,
            session_set_session_name,
            session_set_steering_mode,
            session_set_thinking_level,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
