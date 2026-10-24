//! Staging an attachment where pi can read it: on this device, or on the host.

use std::sync::PoisonError;

use base64::Engine as _;
use camino::{Utf8Path, Utf8PathBuf};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager as _, State};

use crate::{
    commands::files::{detect_mime, read_head},
    error::PieError,
    host::{Files, Host, spool},
    state::AppState,
};

/// Resolves the local cache directory for staging attachment files.
pub fn attachment_cache(app: &AppHandle) -> Result<Utf8PathBuf, PieError> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| PieError::Failed(anyhow::anyhow!("cannot resolve app cache directory: {e}")))?;
    let utf8_base = Utf8PathBuf::from_path_buf(base).map_err(|p| {
        PieError::Failed(anyhow::anyhow!(
            "app cache directory is not valid UTF-8: {}",
            p.display()
        ))
    })?;
    Ok(utf8_base.join("attachments"))
}

/// The result of staging a file attachment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAttachment {
    /// The path on the target host (local path or remote `/tmp/...`).
    pub path: String,
    /// Final byte size.
    pub size: u64,
    /// Final MIME type.
    pub mime_type: String,
}

/// Progress event emitted while uploading a file to a remote host.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UploadEvent {
    /// Byte transfer progress.
    Progress {
        /// Number of bytes transferred so far.
        transferred: u64,
        /// Total file size in bytes.
        total: u64,
    },
}

/// Stages a file attachment on the active host.
///
/// - On a local session with an existing file, retains the original path without copying.
/// - On a local session with an in-memory blob, writes to local temp.
/// - On a remote session (SSH), streams upload to the remote host temp directory via SFTP with progress events emitted to `pi://upload/{upload_id}`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(app, state, bytes_base64), err)]
pub async fn stage_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    upload_id: String,
    name: String,
    local_path: Option<String>,
    bytes_base64: Option<String>,
) -> Result<StagedAttachment, PieError> {
    let ext_hint = Utf8Path::new(&name).extension().unwrap_or_default();

    let runtime = state.hosts.lock().unwrap_or_else(PoisonError::into_inner).active();
    let fallback;
    let files: &dyn Files = match runtime.as_ref() {
        Some(runtime) => runtime.host().files(),
        None => {
            let cache = app
                .path()
                .app_cache_dir()
                .ok()
                .and_then(|c| Utf8PathBuf::from_path_buf(c).ok());
            fallback = Host::local_with_cache(None, cache);
            fallback.files()
        }
    };

    let upload_event_name = format!("pi://upload/{upload_id}");
    let app_clone = app.clone();
    let progress = Box::new(move |transferred, total| {
        let _ = app_clone.emit(&upload_event_name, UploadEvent::Progress { transferred, total });
    });

    if let Some(b64) = bytes_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .map_err(|e| PieError::BadArgument {
                reason: format!("invalid base64 payload: {e}"),
            })?;
        let (mime_type, ext) = detect_mime(&bytes, ext_hint);
        let size = bytes.len() as u64;
        let cache_dir = attachment_cache(&app)?;
        let spooled = spool(&cache_dir, &name, &ext, &bytes).await?;
        let path = files.stage_file(&name, &ext, &spooled, progress).await?;
        tracing::info!(upload_id = %upload_id, name = %name, size, mime_type = %mime_type, staged_path = %path, "attachment staged from in-memory payload");
        return Ok(StagedAttachment { path, size, mime_type });
    }

    if let Some(ref lp) = local_path {
        let path = Utf8Path::new(lp);
        let metadata = tokio::fs::metadata(path).await?;
        let size = metadata.len();
        // Bounded, not assumed: a read that comes short is a fact of a FUSE mount.
        let mut file = tokio::fs::File::open(path).await?;
        let head = read_head(&mut file).await?;
        let (mime_type, ext) = detect_mime(&head, ext_hint);
        let staged = files.stage_file(&name, &ext, path, progress).await?;
        tracing::info!(upload_id = %upload_id, name = %name, size, mime_type = %mime_type, staged_path = %staged, "attachment staged from local file");
        return Ok(StagedAttachment {
            path: staged,
            size,
            mime_type,
        });
    }

    Err(PieError::BadArgument {
        reason: "attachment has neither local path nor binary content".to_string(),
    })
}
