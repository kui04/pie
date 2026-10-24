//! SFTP file operations for a machine pie reaches over SSH.

use std::sync::Arc;

use anyhow::Context as _;
use russh_sftp::client::{SftpSession, error::Error as SftpError};
use typed_path::Utf8TypedPath;

use super::SshHost;
use crate::host::files::{AsyncReadSeek, FileEntry};

/// How long a progress report may be held back. One report in a hundred milliseconds is
/// as smooth as a bar can be read.
const REPORT_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

/// How much of a file may be written before a report, when the clock does not ask for one.
const REPORT_SHARE: u64 = 20;

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
                sftp.create_dir(&level)
                    .await
                    .with_context(|| format!("cannot make {path}"))?;
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

/// Writes a binary payload to a file via SFTP, reporting progress while it goes.
///
/// A report is an IPC message and a render of the strip, so one per chunk is not a reason.
/// The two bounds answer two different problems: the clock holds the rate to ten a second,
/// and the share holds a fast write to one report in twenty. The last byte always closes the
/// bar. A write of 50 MB in 64 KB chunks is 800 chunks and, when the link keeps up, about 20
/// reports instead of 800.
///
/// # Errors
///
/// A sentence when opening or writing the file fails.
pub(super) async fn write_file(
    sftp: &SftpSession,
    path: &str,
    data: &[u8],
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> anyhow::Result<()> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    let mut file = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
        .await
        .with_context(|| format!("cannot make {path}"))?;

    let chunk_size = 65536;
    let total = data.len() as u64;
    let share = (total / REPORT_SHARE).max(1);
    let mut transferred = 0u64;
    let mut reported = 0u64;
    let mut reported_at = std::time::Instant::now();

    // The bar starts at zero, and then hears only what it can show.
    on_progress(0, total);

    for chunk in data.chunks(chunk_size) {
        file.write_all(chunk)
            .await
            .with_context(|| format!("cannot write {path}"))?;
        transferred += chunk.len() as u64;
        if transferred == total || reported_at.elapsed() >= REPORT_EVERY || transferred - reported >= share {
            on_progress(transferred, total);
            reported = transferred;
            reported_at = std::time::Instant::now();
        }
    }

    file.flush().await.with_context(|| format!("cannot write {path}"))?;

    Ok(())
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
