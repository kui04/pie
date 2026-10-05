//! What is on the host.
//!
//! Both listings run on a shared hand rather than on the connection slot: a
//! listing of a large remote directory runs for seconds, and holding the slot
//! that long would put `disconnect` in a queue it deliberately avoids.
//!
//! Neither command wraps what the connection layer said: an empty connection
//! slot is [`connection::Error::NotConnected`], and every failure a listing
//! reports is the connection's own, so `PieError` is what reaches the frontend
//! with the name underneath it intact.

use tauri::State;

use crate::connection::{self, DirEntryInfo, SessionSummary};
use crate::error::PieError;

use super::state::AppState;

/// Every session pi has written on the connected host.
///
/// # Errors
///
/// [`connection::Error::NotConnected`] when there is no host to list, and
/// whatever the host reports when its sessions directory cannot be read.
#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, PieError> {
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| connection::Error::NotConnected {
        doing: "listing its sessions".to_string(),
    })?;
    connection.list_sessions().await
}

/// One directory level on the connected host, for the directory picker.
///
/// `path` is the home directory when absent, and otherwise an absolute path
/// on the host: pie resolves no relative path against its own directory, and
/// the rows carry their whole paths so the picker never builds one.
///
/// # Errors
///
/// [`connection::Error::NotConnected`] when there is no host to read,
/// [`connection::Error::NotAbsolute`] for a relative path (the frontend's
/// mistake), and whatever the host reports when the path cannot be read.
#[tauri::command]
pub async fn list_dirs(state: State<'_, AppState>, path: Option<String>) -> Result<Vec<DirEntryInfo>, PieError> {
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| connection::Error::NotConnected {
        doing: "browsing its directories".to_string(),
    })?;
    connection.list_dirs(path.as_deref()).await
}
