//! The private key a person pastes or chooses.
//!
//! Both halves of this used to be the dialog and filesystem plugins' own
//! JavaScript, called from `src/lib/bridge/pick.ts`. They are a command now
//! because the frontend may not reach a plugin itself, and because the failure
//! is worth naming: a file the person chose is `PieError::Io`, not pie's own
//! mistake, and only Rust knows that.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use crate::error::PieError;

/// Asks the person for a private key and brings back what is inside it.
///
/// The text rather than the location, because the two platforms answer the
/// picker differently - a path on desktop, a `content://` URI on Android - and
/// only one of those names something a plain read is guaranteed to open.
///
/// `None` means the picker was closed, which is not a failure. A file that
/// cannot be read is [`PieError::Io`], so the toast says which file failed
/// rather than blaming pie.
///
/// # Errors
///
/// Whatever reading the chosen file reports. Opening the picker itself cannot
/// fail as far as the plugin reports: a picker it cannot put up answers as if it
/// had been closed.
#[tauri::command]
pub async fn pick_private_key(app: AppHandle) -> Result<Option<String>, PieError> {
    picked_private_key(&app)
}

/// The whole command, without the async shell around it.
///
/// `async` on [`pick_private_key`] is what puts this off the main thread, which
/// is the only place a blocking dialog may be opened from: the dialog needs the
/// event loop to keep running, and the event loop is the main thread's.
fn picked_private_key(app: &AppHandle) -> Result<Option<String>, PieError> {
    let Some(chosen) = app.dialog().file().blocking_pick_file() else {
        return Ok(None);
    };
    // The plugin's filesystem rather than `tokio::fs`: on Android the picker
    // answers with a `content://` URI, and only the plugin can open one.
    app.fs().read_to_string(chosen).map(Some).map_err(PieError::file)
}
