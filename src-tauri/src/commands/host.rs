//! The connections: reaching a machine, its sessions, and its files.

use std::collections::hash_map::Entry;
use std::sync::{Arc, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use typed_path::{Utf8TypedPath, Utf8TypedPathBuf};

use crate::commands::host_at;
use crate::error::PieError;
use crate::host::executor::OsFamily;
use crate::host::fs::{UploadReceipt, UploadSource, check_type, require_absolute};
use crate::host::{Executor, FileSystem, HostConnection, HostTarget, connect};
use crate::session::SessionInfo;
use crate::state::{AppState, HostId};

/// How often an upload reports the bytes it has written.
const UPLOAD_TICK: Duration = Duration::from_millis(100);

/// Start pi on an existing conversation.
#[tauri::command(rename = "attach_session")]
pub async fn host_attach_session(
    state: State<'_, AppState>,
    id: HostId,
    session: Utf8TypedPathBuf,
) -> Result<SessionInfo, PieError> {
    let host = host_at(&state, &id)?;
    let session = host.attach_session(session, state.bus()).await?;
    Ok(session.info())
}

/// What the frontend hears about one connection.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: HostId,
    /// The sessions that run now.
    pub sessions: Vec<SessionInfo>,
    /// Whether the reach to the machine is still open.
    pub open: bool,
}

/// Reach a machine, and register the connection under `id`.
#[tauri::command(rename = "connect")]
pub async fn host_connect(
    state: State<'_, AppState>,
    id: HostId,
    target: HostTarget,
) -> Result<ConnectionInfo, PieError> {
    if state
        .hosts
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains_key(&id)
    {
        return Err(PieError::AlreadyConnected {
            connection: id.as_str().to_owned(),
        });
    }

    let connection = Arc::new(connect(id.clone(), target, state.bus(), state.dirs()).await?);

    // The guard is released before any await: a `std` guard across an await would
    // make the command future `!Send`.
    let registered = {
        let mut hosts = state.hosts.lock().unwrap_or_else(PoisonError::into_inner);
        match hosts.entry(id.clone()) {
            Entry::Occupied(_) => Err(Arc::clone(&connection)),
            Entry::Vacant(slot) => {
                slot.insert(Arc::clone(&connection));
                Ok(())
            }
        }
    };

    match registered {
        Ok(()) => connection_info(&state, &id),
        Err(extra) => {
            let _ = extra.disconnect().await;
            Err(PieError::AlreadyConnected {
                connection: id.as_str().to_owned(),
            })
        }
    }
}

/// Make a directory on the machine, with parents as needed.
#[tauri::command(rename = "create_dir_all")]
pub async fn host_create_dir_all(
    state: State<'_, AppState>,
    id: HostId,
    path: String,
) -> Result<(), PieError> {
    let host = host_at(&state, &id)?;
    let path = host_path(&path, host.host().family().await)?;
    host.host().create_dir_all(path.to_path()).await?;
    Ok(())
}

/// Delete one conversation file of the machine.
#[tauri::command(rename = "delete_session")]
pub async fn host_delete_session(
    state: State<'_, AppState>,
    id: HostId,
    session: Utf8TypedPathBuf,
) -> Result<(), PieError> {
    host_at(&state, &id)?.delete_session(&session).await?;
    Ok(())
}

/// End one pi. The conversation file stays.
#[tauri::command(rename = "detach_session")]
pub async fn host_detach_session(
    state: State<'_, AppState>,
    id: HostId,
    session: Utf8TypedPathBuf,
) -> Result<(), PieError> {
    host_at(&state, &id)?.detach_session(&session).await?;
    Ok(())
}

/// Whether a path names a directory on the machine.
#[tauri::command(rename = "dir_exists")]
pub async fn host_dir_exists(
    state: State<'_, AppState>,
    id: HostId,
    path: String,
) -> Result<bool, PieError> {
    let host = host_at(&state, &id)?;
    let path = host_path(&path, host.host().family().await)?;

    Ok(host.host().is_dir(path.to_path()).await?)
}

/// End the connection, and every session on it.
#[tauri::command(rename = "disconnect")]
pub async fn host_disconnect(state: State<'_, AppState>, id: HostId) -> Result<(), PieError> {
    let connection = state
        .hosts
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id)
        .ok_or_else(|| PieError::NotConnected {
            doing: format!("reaching host `{id}`"),
        })?;

    connection.disconnect().await?;
    Ok(())
}

/// The login home of the machine.
#[tauri::command(rename = "home_dir")]
pub async fn host_home_dir(
    state: State<'_, AppState>,
    id: HostId,
) -> Result<Option<Utf8TypedPathBuf>, PieError> {
    let host = host_at(&state, &id)?;

    // A machine reports a missing home as this one failure, so `None` is its answer.
    match host.host().home_dir().await {
        Ok(home) => Ok(Some(home)),
        Err(error) => {
            tracing::debug!(%error, host = %id, "this machine reports no home directory");
            Ok(None)
        }
    }
}

/// One row of the directory picker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: Utf8TypedPathBuf,
    pub is_dir: bool,
}

/// One directory level of the machine.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub directory: Utf8TypedPathBuf,
    pub entries: Vec<DirEntry>,
}

/// One directory level of the machine, for the picker.
#[tauri::command(rename = "list_dirs")]
pub async fn host_list_dirs(
    state: State<'_, AppState>,
    id: HostId,
    path: String,
) -> Result<Listing, PieError> {
    let host = host_at(&state, &id)?;
    let path = host_path(&path, host.host().family().await)?;

    let entries = host
        .host()
        .read_dir(path.to_path())
        .await?
        .into_iter()
        .filter(|row| row.is_dir)
        .map(|row| DirEntry {
            name: row
                .path
                .to_path()
                .file_name()
                .unwrap_or_default()
                .to_owned(),
            path: row.path,
            is_dir: true,
        })
        .collect();

    Ok(Listing {
        directory: path,
        entries,
    })
}

/// Every conversation of the machine, newest first.
#[tauri::command(rename = "list_sessions")]
pub async fn host_list_sessions(
    state: State<'_, AppState>,
    id: HostId,
) -> Result<Vec<SessionInfo>, PieError> {
    Ok(host_at(&state, &id)?.list_sessions().await?)
}

/// Dial the same machine again, with the credential pie holds.
#[tauri::command(rename = "reconnect")]
pub async fn host_reconnect(
    state: State<'_, AppState>,
    id: HostId,
) -> Result<ConnectionInfo, PieError> {
    let previous = host_at(&state, &id)?;
    if previous.is_open() {
        return connection_info(&state, &id);
    }

    let target = previous.target().clone();
    let fresh = Arc::new(connect(id.clone(), target, state.bus(), state.dirs()).await?);

    let displaced = state
        .hosts
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id.clone(), fresh);
    if let Some(displaced) = displaced {
        let _ = displaced.disconnect().await;
    }

    connection_info(&state, &id)
}

/// Start pi on a new conversation in `cwd`. pi chooses the conversation file.
#[tauri::command(rename = "start_new_session")]
pub async fn host_start_new_session(
    state: State<'_, AppState>,
    id: HostId,
    cwd: String,
) -> Result<SessionInfo, PieError> {
    let host = host_at(&state, &id)?;
    let cwd = host_path(&cwd, host.host().family().await)?;
    let session = host.start_new_session(cwd.to_path(), state.bus()).await?;
    Ok(session.info())
}

/// How far one upload has gone.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    /// Bytes written to the machine so far.
    pub bytes: u64,
    /// Bytes of the whole file.
    pub total: u64,
}

/// Stage one file where pi on the machine can read it.
#[tauri::command(rename = "upload_file")]
pub async fn host_upload_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: HostId,
    upload_id: String,
    source: UploadSource,
) -> Result<UploadReceipt, PieError> {
    let host = host_at(&state, &id)?;
    let total = source_length(&source).await;
    let (progress, mut reports) = tokio::sync::watch::channel(0u64);

    let event_name = format!("pi://upload/{upload_id}");
    let reporter = tokio::spawn(async move {
        let mut tick = tokio::time::interval(UPLOAD_TICK);
        tick.tick().await;
        loop {
            tokio::select! {
                changed = reports.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                _ = tick.tick() => {
                    let bytes = *reports.borrow();
                    if let Err(error) = app.emit(&event_name, UploadProgress { bytes, total }) {
                        tracing::warn!(%error, event = %event_name, "an upload report did not leave");
                    }
                }
            }
        }
    });

    let receipt = host.upload_file(source, progress).await;
    reporter.abort();
    Ok(receipt?)
}

/// The path `text` names on a machine of `family`, or why it names none.
fn host_path(text: &str, family: OsFamily) -> Result<Utf8TypedPathBuf, PieError> {
    let path = Utf8TypedPath::derive(text);
    let path = require_absolute(path).map_err(bad_argument)?;
    check_type(path, family).map_err(bad_argument)?;
    Ok(path.to_path_buf())
}

/// A refusal from the filesystem layer, as the failure of an argument.
fn bad_argument(error: anyhow::Error) -> PieError {
    PieError::BadArgument {
        reason: format!("{error:#}"),
    }
}

/// The whole length of `source`, when this side can tell it before the upload.
async fn source_length(source: &UploadSource) -> u64 {
    match source {
        UploadSource::Local { path } => tokio::fs::metadata(path.as_std_path())
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        UploadSource::InMemory { content, .. } => content.len() as u64,
    }
}

/// What the frontend hears about the connection under `id`, or `not_connected`.
fn connection_info(state: &AppState, id: &HostId) -> Result<ConnectionInfo, PieError> {
    let host: Arc<HostConnection> = host_at(state, id)?;
    Ok(ConnectionInfo {
        // The connection names itself, so the name the frontend keys its events on is
        // the one the pump puts on them.
        id: host.id().clone(),
        sessions: host.attached_sessions(),
        open: host.is_open(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_of_the_wrong_shape_is_a_bad_argument() {
        assert!(host_path("/work/one", OsFamily::Unix).is_ok());

        for text in ["work/one", "", "C:\\work"] {
            let error = host_path(text, OsFamily::Unix).expect_err("no path of this machine");
            assert!(
                matches!(error, PieError::BadArgument { .. }),
                "`{text}`: {error}"
            );
        }
    }
}
