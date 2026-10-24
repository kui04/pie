//! SFTP file operations for a machine pie reaches over SSH.

use std::sync::Arc;

use anyhow::Context as _;
use russh_sftp::client::{SftpSession, error::Error as SftpError};
use typed_path::Utf8TypedPath;

use super::SshHost;
use crate::host::files::{AsyncReadSeek, FileEntry};

/// Whether an sftp entry is a directory that a picker can walk, with links.
///
/// sftp reports what the link is, not where it points. The picker needs the
/// target. Therefore pie asks about a link on its own: one round trip for the
/// links, and no round trip for everything else.
pub(super) async fn entry_is_dir(sftp: &SftpSession, entry: &russh_sftp::client::fs::DirEntry) -> bool {
    if !entry.file_type().is_symlink() {
        return entry.file_type().is_dir();
    }
    match sftp.metadata(entry.path()).await {
        Ok(target) => target.is_dir(),
        Err(error) => {
            tracing::warn!(path = %entry.path(), %error, "a link pie cannot follow");
            false
        }
    }
}

/// Whether a path names a directory over an sftp channel.
///
/// # Errors
///
/// A sentence when the answer cannot be told.
pub(super) async fn is_dir(sftp: &SftpSession, path: &str) -> anyhow::Result<bool> {
    match sftp.metadata(path).await {
        Ok(target) => Ok(target.is_dir()),
        Err(error) if is_no_such_file(&error) => Ok(false),
        Err(error) => Err(error).with_context(|| format!("cannot read {path}")),
    }
}

/// Makes a directory over an sftp channel, one level at a time.
///
/// sftp makes one level per call, so pie walks the levels itself and leaves
/// what exists alone.
///
/// # Errors
///
/// A sentence when a level cannot be made.
pub(super) async fn create_dir_all(sftp: &SftpSession, path: &str) -> anyhow::Result<()> {
    for level in levels_of(path) {
        match sftp.metadata(&level).await {
            Ok(_) => {}
            Err(error) if is_no_such_file(&error) => {
                if let Err(err) = sftp.create_dir(&level).await {
                    if sftp.metadata(&level).await.is_ok() {
                        tracing::debug!(level = %level, "directory level concurrently created by another task");
                    } else {
                        return Err(err).with_context(|| format!("cannot make {path}"));
                    }
                }
            }
            Err(error) => return Err(error).with_context(|| format!("cannot read {level}")),
        }
    }
    Ok(())
}

/// Removes one file over an sftp channel.
pub(super) async fn remove_file(sftp: &SftpSession, path: &str) -> anyhow::Result<()> {
    sftp.remove_file(path)
        .await
        .with_context(|| format!("cannot remove {path}"))
}

/// Reads directory entries of a directory over an sftp channel.
pub(super) async fn read_dir(sftp: &SftpSession, path: &str) -> anyhow::Result<Vec<FileEntry>> {
    let items = sftp
        .read_dir(path)
        .await
        .with_context(|| format!("cannot read {path}"))?;
    let mut entries = Vec::new();
    for item in items {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = item.metadata();
        let is_directory = entry_is_dir(sftp, &item).await;
        let size = meta.size;
        let modified = meta.modified().ok();
        entries.push(FileEntry {
            name,
            path: item.path(),
            is_dir: is_directory,
            size,
            modified,
        });
    }
    Ok(entries)
}

/// Opens a file over an sftp channel for seekable asynchronous reading.
pub(super) async fn open(sftp: &SftpSession, path: &str) -> anyhow::Result<Box<dyn AsyncReadSeek>> {
    let file = sftp
        .open_with_flags(path, russh_sftp::protocol::OpenFlags::READ)
        .await
        .with_context(|| format!("cannot open {path}"))?;
    Ok(Box::new(file))
}

/// Every level of a host path from the top down, in the spelling the host uses.
///
/// The root keeps its own shape: `/`, `C:\`, or `\\host\share`.
fn levels_of(path: &str) -> Vec<String> {
    let mut levels: Vec<String> = Utf8TypedPath::derive(path)
        .ancestors()
        .filter(|level| level.parent().is_some())
        .map(|level| level.as_str().to_string())
        .collect();
    levels.reverse();
    levels
}

/// The file channel of a host pie reaches over SSH.
///
/// The open happens at the first use: a host whose sshd serves no `sftp`
/// subsystem still runs pi correctly, and only the file listing is lost.
///
/// # Errors
///
/// A sentence when the host refuses the subsystem, and one when the handshake
/// over it goes quiet.
pub(super) async fn sftp(host: &SshHost) -> anyhow::Result<Arc<SftpSession>> {
    let session = host.active_session()?;
    if let Some(sftp) = host.cached_sftp(&session) {
        return Ok(sftp);
    }
    let _guard = host.sftp_lock.lock().await;
    if let Some(sftp) = host.cached_sftp(&session) {
        return Ok(sftp);
    }
    let stream = session.subsystem("sftp").await?;
    let opened = SftpSession::new(stream)
        .await
        .with_context(|| format!("the sftp subsystem on {} did not answer", host.endpoint()))?;
    let opened = Arc::new(opened);
    // A failed open leaves the slot empty. Therefore the next listing tries
    // again. A host can also serve no sftp yet.
    host.keep_sftp(&session, &opened);
    Ok(opened)
}

/// Whether an sftp failure is only "there is no such path".
pub(super) fn is_no_such_file(error: &SftpError) -> bool {
    use russh_sftp::protocol::StatusCode;
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_levels_of_a_path_run_from_the_top_down() {
        assert_eq!(levels_of("/a/b"), ["/a", "/a/b"]);
        assert_eq!(levels_of("/a"), ["/a"]);
        assert!(levels_of("/").is_empty(), "the root itself needs no making");
        assert_eq!(levels_of("C:\\a\\b"), ["C:\\a", "C:\\a\\b"]);
    }
}
