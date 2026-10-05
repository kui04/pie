//! What is on the host.
//!
//! Both listings run on a shared hand, not on the connection slot. A listing of
//! a large remote directory can run for seconds. The slot must stay free for
//! `disconnect`.
//!
//! Neither command wraps the failure of the connection layer. An empty
//! connection slot is [`connection::Error::NotConnected`]. Every failure of a
//! listing is the failure of the connection. Therefore `PieError` reaches the
//! frontend with the name below it intact.

use tauri::State;

use crate::connection::{self, DirEntryInfo, SessionSummary};
use crate::error::PieError;

use super::state::AppState;

/// Every session that pi wrote on the connected host.
///
/// # Errors
///
/// [`connection::Error::NotConnected`] if there is no host to list, and the
/// failure of the host if pie cannot read the sessions directory.
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
/// `path` is the home directory if absent. If present, `path` is an absolute
/// path on the host. Pie resolves no relative path against its own directory.
/// The rows carry their full paths, so the picker never builds a path.
///
/// # Errors
///
/// [`connection::Error::NotConnected`] if there is no host to read,
/// [`connection::Error::NotAbsolute`] for a relative path (a mistake of the
/// frontend), and the failure of the host if pie cannot read the path.
#[tauri::command]
pub async fn list_dirs(state: State<'_, AppState>, path: Option<String>) -> Result<Vec<DirEntryInfo>, PieError> {
    let connection = state.connection.lock().await.clone();
    let connection = connection.ok_or_else(|| connection::Error::NotConnected {
        doing: "browsing its directories".to_string(),
    })?;
    connection.list_dirs(path.as_deref()).await
}
