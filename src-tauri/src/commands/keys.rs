//! The private key that a person pastes or selects.
//!
//! Both parts used to be the JavaScript of the dialog and filesystem plugins,
//! called from `src/lib/bridge/pick.ts`. They are a command now. The frontend
//! must not call a plugin itself. Also, the failure needs a name: a file that
//! the person selected is `PieError::Io`, not a mistake of pie. Only Rust knows
//! this.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use crate::error::PieError;

/// Asks the person for a private key. Returns the text of the key.
///
/// The function returns the text, not the location. The two platforms answer
/// the picker differently: a path on desktop, a `content://` URI on Android.
/// A plain read can open only one of these.
///
/// `None` means that the person closed the picker. A closed picker is not a
/// failure. A file that cannot be read is [`PieError::Io`]. Therefore the toast
/// blames the selected file, not pie.
///
/// # Errors
///
/// The failure of the read of the selected file. The plugin reports no failure
/// for the picker itself: a picker that it cannot show answers as a closed
/// picker.
#[tauri::command]
pub async fn pick_private_key(app: AppHandle) -> Result<Option<String>, PieError> {
    picked_private_key(&app)
}

/// The command without the async shell.
///
/// `async` on [`pick_private_key`] moves this work off the main thread. The
/// blocking dialog must not operate on the main thread: the dialog needs the
/// event loop, and the event loop belongs to the main thread.
fn picked_private_key(app: &AppHandle) -> Result<Option<String>, PieError> {
    let Some(chosen) = app.dialog().file().blocking_pick_file() else {
        return Ok(None);
    };
    // The filesystem of the plugin, not `tokio::fs`: on Android the picker
    // answers with a `content://` URI. Only the plugin can open that URI.
    app.fs().read_to_string(chosen).map(Some).map_err(PieError::file)
}
