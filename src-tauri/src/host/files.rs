//! The files of a machine: the directory picker, the path rules, and the
//! machine's file channel.
//!
//! Pi keeps its sessions as files on the machine that runs it, so pie reads
//! files on two kinds of machine: this one, straight through the filesystem, and
//! a host it reaches over SSH, through the `sftp` subsystem of the session that
//! already runs pi. The choice is made once, in [`Host`](super::Host), and the
//! two paths are written down here and nowhere else.
//!
//! The channel over SSH is opened at the first use and kept. A host whose sshd
//! serves no `sftp` still runs pi correctly, and only the file listing is lost;
//! a channel that died under a live connection is dropped again by the read that
//! found it dead ([`SshHost::forget_sftp`]), so the next read opens a fresh one.
//!
//! Which of the two machines a path belongs to is not visible in the path: both
//! are absolute paths of a POSIX or a Windows host. Pie resolves no path against
//! its own directory - on a phone that directory is not the home of a person -
//! and [`is_absolute_on_the_host`] is what says so.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpError;
use serde::Serialize;

use super::Error;
use super::ssh::SshHost;

/// One row of a directory listing, for the directory picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// The last part of the path, as the host writes it.
    pub name: String,
    /// The whole path, as the host writes it.
    pub path: String,
    /// Whether the picker can walk into this row.
    pub is_dir: bool,
}

/// One directory level of this machine.
///
/// The paths are absolute and belong to the machine. `path` is `None` for the
/// home directory of the connection, which the caller resolved long before this
/// point.
///
/// # Errors
///
/// [`Error::NoHomeDirectory`] when `path` is `None` and this machine has no home
/// directory, [`Error::NotAbsolute`] for a relative path, and
/// [`Error::UnreadableLocal`] when the directory cannot be read.
pub(crate) async fn dirs_local(home: Option<&Path>, path: Option<&str>) -> Result<Vec<DirEntry>, Error> {
    let path = match path {
        None => home.map(Path::to_path_buf).ok_or(Error::NoHomeDirectory)?,
        Some(path) => {
            if !Path::new(path).is_absolute() {
                return Err(not_absolute(path));
            }
            PathBuf::from(path)
        }
    };
    let shown = path.display().to_string();
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| unreadable(&shown, error))?;
    let mut rows = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|error| unreadable(&shown, error))? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        // The free `metadata` follows links. The `metadata` of a `DirEntry` does
        // not. A picker that cannot walk into a linked directory loses half of
        // some home directories. A link with no target is still a row. It is only
        // not a directory.
        let is_dir = match tokio::fs::metadata(entry.path()).await {
            Ok(target) => target.is_dir(),
            Err(error) => {
                tracing::warn!(path = %entry.path().display(), %error, "an entry pie cannot follow");
                false
            }
        };
        rows.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    sort_dirs_first(&mut rows);
    Ok(rows)
}

/// The same directory level over an sftp channel. `None` asks for the login home,
/// which is the start of an sftp session.
///
/// # Errors
///
/// [`Error::NotAbsolute`] for a relative path, and [`Error::UnreadableRemote`]
/// when the directory cannot be read.
pub(crate) async fn dirs_remote(sftp: &SftpSession, path: Option<&str>) -> Result<Vec<DirEntry>, Error> {
    let base = match path {
        None => sftp
            .canonicalize(".")
            .await
            .map_err(|error| unreadable_there("the login home", error))?,
        Some(path) => {
            if !is_absolute_on_the_host(path) {
                // These are the paths of the host, not the paths of this machine.
                // Over sftp they are as the host writes them, POSIX or Windows.
                // Neither is the directory of pie.
                return Err(not_absolute(path));
            }
            path.to_string()
        }
    };
    let entries = sftp
        .read_dir(&base)
        .await
        .map_err(|error| unreadable_there(&base, error))?;
    let mut rows = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        rows.push(DirEntry {
            is_dir: sftp_is_dir(sftp, &entry).await,
            name,
            path: entry.path(),
        });
    }
    sort_dirs_first(&mut rows);
    Ok(rows)
}

/// Whether an sftp entry is a directory that a picker can walk, with links.
///
/// sftp reports what the link is, not where it points. The picker needs the
/// target. Therefore pie asks about a link on its own: one round trip for the
/// links, and no round trip for everything else.
pub(crate) async fn sftp_is_dir(sftp: &SftpSession, entry: &russh_sftp::client::fs::DirEntry) -> bool {
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

/// Directories first, then by name. The order of the picker, on both machines.
fn sort_dirs_first(rows: &mut [DirEntry]) {
    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
}

/// The file channel of a host pie reaches over SSH.
///
/// The open happens at the first use: a host whose sshd serves no `sftp`
/// subsystem still runs pi correctly, and only the file listing is lost.
///
/// # Errors
///
/// [`Error::Subsystem`] when the host refuses the subsystem, and
/// [`Error::SftpUnanswered`] when the handshake over it goes quiet.
pub(crate) async fn sftp(host: &SshHost) -> Result<Arc<SftpSession>, Error> {
    let cached = host.cached_sftp();
    if let Some(sftp) = cached {
        return Ok(sftp);
    }
    let stream = host.session().subsystem("sftp").await?;
    let opened = SftpSession::new(stream).await.map_err(|source| Error::SftpUnanswered {
        endpoint: host.endpoint().to_string(),
        source,
    })?;
    let opened = Arc::new(opened);
    // A failed open leaves the slot empty. Therefore the next listing tries
    // again. A host can also serve no sftp yet.
    host.keep_sftp(&opened);
    Ok(opened)
}

/// A path on this machine that pie cannot read appears as any other failure of
/// the reach. The frontend offers the same retry, and the message names the path
/// at fault.
pub(crate) fn unreadable(path: &str, source: std::io::Error) -> Error {
    Error::UnreadableLocal {
        path: path.to_string(),
        source,
    }
}

/// The same for a path on the host, over sftp.
pub(crate) fn unreadable_there(path: &str, source: SftpError) -> Error {
    Error::UnreadableRemote {
        path: path.to_string(),
        source,
    }
}

/// A relative path is a mistake of the frontend, not a failure of the host.
///
/// The function has a name so that a caller can reject such a path before the
/// handshake of a channel.
pub(crate) fn not_absolute(path: &str) -> Error {
    Error::NotAbsolute { path: path.to_string() }
}

/// Whether `path` is absolute on the host that it names: POSIX or Windows style.
///
/// These conventions belong to the host, not to this machine. Pie operates on one
/// machine and reads the other, so both spellings belong to the host.
pub(crate) fn is_absolute_on_the_host(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with("\\\\")
        || matches!(
            path.as_bytes(),
            [drive, b':', sep, ..] if drive.is_ascii_alphabetic() && matches!(sep, b'\\' | b'/')
        )
}

/// Whether an sftp failure is only "there is no such path".
pub(crate) fn is_no_such_file(error: &SftpError) -> bool {
    use russh_sftp::protocol::StatusCode;
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_of_a_host_is_absolute_in_either_spelling() {
        for absolute in ["/home/pi", "\\\\host\\share", "C:\\Users\\pi", "c:/users"] {
            assert!(is_absolute_on_the_host(absolute), "`{absolute}` is absolute");
        }
        for relative in ["", "pi", ".pi/agent", "./x", "C:", "1:\\x"] {
            assert!(!is_absolute_on_the_host(relative), "`{relative}` is not absolute");
        }
    }

    #[test]
    fn a_relative_path_names_itself_in_the_refusal() {
        let error = not_absolute(".pi/agent/sessions");

        assert_eq!(
            error.to_string(),
            "`.pi/agent/sessions` is not absolute; pie resolves no path against its own directory"
        );
    }

    #[test]
    fn the_picker_shows_the_directories_first() {
        let row = |name: &str, is_dir: bool| DirEntry {
            name: name.to_string(),
            path: format!("/x/{name}"),
            is_dir,
        };
        let mut rows = vec![row("b.txt", false), row("z", true), row("a.txt", false), row("a", true)];

        sort_dirs_first(&mut rows);

        let shown: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(shown, ["a", "z", "a.txt", "b.txt"]);
    }

    #[tokio::test]
    async fn the_local_rows_put_directories_first_and_carry_full_paths() {
        let directory = tempfile::tempdir().expect("a temp directory");
        std::fs::create_dir(directory.path().join("b-dir")).expect("the directory");
        std::fs::create_dir(directory.path().join("a-dir")).expect("the directory");
        std::fs::write(directory.path().join("z-file"), "").expect("the file");

        let rows = dirs_local(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing");

        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["a-dir", "b-dir", "z-file"]);
        assert_eq!(rows.iter().filter(|row| row.is_dir).count(), 2);
        for row in &rows {
            assert!(
                Path::new(&row.path).is_absolute(),
                "rows carry whole paths: {}",
                row.path
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_local_picker_follows_a_link_to_a_directory() {
        // A picker that cannot walk into a linked directory loses half of some
        // home directories.
        let directory = tempfile::tempdir().expect("a temp directory");
        let target = directory.path().join("elsewhere");
        std::fs::create_dir(&target).expect("the target");
        std::os::unix::fs::symlink(&target, directory.path().join("a-link")).expect("the link");

        let rows = dirs_local(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing");

        let link = rows
            .iter()
            .find(|row| row.name == "a-link")
            .expect("the link is listed");
        assert!(link.is_dir, "a link to a directory is a directory to a picker");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_broken_link_is_a_row_and_not_a_failure() {
        // Home directories full of old dotfile links are the usual case, not the
        // exception. One of them must not stop the listing.
        let directory = tempfile::tempdir().expect("a temp directory");
        std::os::unix::fs::symlink(directory.path().join("nowhere"), directory.path().join("stale")).expect("the link");
        std::fs::write(directory.path().join("z-file"), "").expect("the file");

        let rows = dirs_local(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing");

        let stale = rows.iter().find(|row| row.name == "stale").expect("the link is listed");
        assert!(!stale.is_dir, "a link that leads nowhere is not a walkable directory");
    }

    #[tokio::test]
    async fn the_picker_takes_no_relative_path() {
        // Pie resolves no path against its own directory: on a phone that
        // directory is not the home of a person, and the two paths would not even
        // agree on it.
        for path in [".", "..", "sessions", "./sessions"] {
            let error = dirs_local(None, Some(path)).await.expect_err("`{path}` is relative");
            assert!(matches!(error, Error::NotAbsolute { .. }), "got {error:?}");
        }
    }
}
