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

/// One directory level of a machine, with the directory it is.
///
/// The directory comes back with the rows because the picker cannot name the home
/// directory of a machine by itself: it asks for `None` and the machine answers with
/// its own. Every other level is named by the row the picker walked into.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The directory that was read, as the host writes it.
    pub directory: String,
    /// Its rows, directories first.
    pub entries: Vec<DirEntry>,
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
pub(crate) async fn dirs_local(home: Option<&Path>, path: Option<&str>) -> Result<Listing, Error> {
    let path = local_start(home, path)?;
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
    Ok(Listing {
        directory: shown,
        entries: rows,
    })
}

/// The same directory level over an sftp channel. `None` asks for the login home,
/// which is the start of an sftp session.
///
/// # Errors
///
/// [`Error::NotAbsolute`] for a relative path, and [`Error::UnreadableRemote`]
/// when the directory cannot be read.
pub(crate) async fn dirs_remote(sftp: &SftpSession, path: Option<&str>) -> Result<Listing, Error> {
    let base = remote_start(sftp, path).await?;
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
    Ok(Listing {
        directory: base,
        entries: rows,
    })
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

/// Whether a path names a directory on this machine.
///
/// Missing names answer `false`; anything else that goes wrong is a failure.
///
/// # Errors
///
/// [`Error::NotAbsolute`] for a relative path, and [`Error::UnreadableLocal`]
/// when the answer cannot be told.
pub(crate) async fn dir_exists_local(path: &str) -> Result<bool, Error> {
    if !Path::new(path).is_absolute() {
        return Err(not_absolute(path));
    }
    match tokio::fs::metadata(path).await {
        Ok(target) => Ok(target.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(unreadable(path, error)),
    }
}

/// The same over an sftp channel.
///
/// # Errors
///
/// [`Error::NotAbsolute`] for a relative path, and [`Error::UnreadableRemote`]
/// when the answer cannot be told.
pub(crate) async fn dir_exists_remote(sftp: &SftpSession, path: &str) -> Result<bool, Error> {
    if !is_absolute_on_the_host(path) {
        return Err(not_absolute(path));
    }
    match sftp.metadata(path).await {
        Ok(target) => Ok(target.is_dir()),
        Err(error) if is_no_such_file(&error) => Ok(false),
        Err(error) => Err(unreadable_there(path, error)),
    }
}

/// Makes a directory on this machine, with parents as needed.
///
/// The picker offers this when the typed path names nothing: the confirm names
/// the path, and this makes it.
///
/// # Errors
///
/// [`Error::NotAbsolute`] for a relative path, and [`Error::UncreatableLocal`]
/// when the directory cannot be made.
pub(crate) async fn create_dir_local(path: &str) -> Result<(), Error> {
    if !Path::new(path).is_absolute() {
        return Err(not_absolute(path));
    }
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|error| uncreatable(path, error))
}

/// The same over an sftp channel, one level at a time.
///
/// sftp makes one level per call, so pie walks the levels itself and leaves
/// what exists alone.
///
/// # Errors
///
/// [`Error::NotAbsolute`] for a relative path, and [`Error::UncreatableRemote`]
/// when a level cannot be made.
pub(crate) async fn create_dir_remote(sftp: &SftpSession, path: &str) -> Result<(), Error> {
    if !is_absolute_on_the_host(path) {
        return Err(not_absolute(path));
    }
    for level in levels_of(path) {
        match sftp.metadata(&level).await {
            Ok(_) => {}
            Err(error) if is_no_such_file(&error) => {
                sftp.create_dir(&level)
                    .await
                    .map_err(|error| uncreatable_there(path, error))?;
            }
            Err(error) => return Err(unreadable_there(&level, error)),
        }
    }
    Ok(())
}

/// How long a progress report may be held back. One report in a hundred milliseconds is
/// as smooth as a bar can be read.
const REPORT_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

/// How much of a file may be written before a report, when the clock does not ask for one.
const REPORT_SHARE: u64 = 20;

/// Writes a binary payload to a remote file via SFTP, reporting progress while it goes.
///
/// A report is an IPC message and a render of the strip, so one per chunk is not a reason.
/// The two bounds answer two different problems: the clock holds the rate to ten a second,
/// and the share holds a fast write to one report in twenty. The last byte always closes the
/// bar. A write of 50 MB in 64 KB chunks is 800 chunks and, when the link keeps up, about 20
/// reports instead of 800.
///
/// # Errors
///
/// [`Error::UncreatableRemote`] when opening or writing the file fails.
pub(crate) async fn write_file_remote<F>(
    sftp: &SftpSession,
    remote_path: &str,
    data: &[u8],
    mut on_progress: F,
) -> Result<(), Error>
where
    F: FnMut(u64, u64) + Send,
{
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    let mut file = sftp
        .open_with_flags(remote_path, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
        .await
        .map_err(|err| uncreatable_there(remote_path, err))?;

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
            .map_err(|err| uncreatable_there(remote_path, SftpError::from(err)))?;
        transferred += chunk.len() as u64;
        if transferred == total || reported_at.elapsed() >= REPORT_EVERY || transferred - reported >= share {
            on_progress(transferred, total);
            reported = transferred;
            reported_at = std::time::Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|err| uncreatable_there(remote_path, SftpError::from(err)))?;

    Ok(())
}

/// The name of the temporary copy that a machine keeps for one attachment.
///
/// This names a file on a host that pie cannot create one on itself: the upload
/// writes under this name. A file on this machine is named by [`stage_local`]
/// instead, which lets `tempfile` choose the part that must not collide.
pub fn temp_file_name(stem_hint: &str, ext_hint: &str) -> String {
    let id = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    let stem = clean_stem(stem_hint);
    let extension = clean_extension(ext_hint);
    if extension.is_empty() {
        format!("pie-{stem}-{id}")
    } else {
        format!("pie-{stem}-{id}.{extension}")
    }
}

/// Writes `bytes` into the temporary directory of this machine, and answers where.
///
/// The name is claimed with `O_EXCL` and the bytes go through that same handle. The
/// temporary directory is shared with every other process of the machine, so a name
/// that another writer chose, or a path reopened after the claim, could put the bytes
/// into a link that somebody planted; `tempfile` closes both doors with the one open.
///
/// The file stays after this call. Pi reads it, and pie has no moment at which it
/// knows that pi has finished with it.
///
/// # Errors
///
/// [`Error::UncreatableLocal`] when the directory refuses a file, or when the
/// write of it fails.
pub(crate) async fn stage_local(stem_hint: &str, ext_hint: &str, bytes: &[u8]) -> Result<String, Error> {
    use tokio::io::AsyncWriteExt as _;

    let directory = std::env::temp_dir();
    let prefix = format!("pie-{}-", clean_stem(stem_hint));
    let mut builder = tempfile::Builder::new();
    builder.prefix(&prefix);
    let extension = clean_extension(ext_hint);
    let suffix = format!(".{extension}");
    if !extension.is_empty() {
        builder.suffix(&suffix);
    }
    let claimed = builder
        .tempfile_in(&directory)
        .map_err(|error| uncreatable(&directory.display().to_string(), error))?;
    let (file, path) = claimed
        .keep()
        .map_err(|error| uncreatable(&directory.display().to_string(), error.error))?;
    let mut file = tokio::fs::File::from_std(file);
    file.write_all(bytes)
        .await
        .map_err(|error| uncreatable(&path.display().to_string(), error))?;
    file.flush()
        .await
        .map_err(|error| uncreatable(&path.display().to_string(), error))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The part of a name that a temporary copy keeps: letters, digits, `-` and `_`,
/// so that the name is legal on every machine that pie reaches.
fn clean_stem(stem_hint: &str) -> String {
    let stem: String = Path::new(stem_hint)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() { "file".to_string() } else { stem }
}

/// The extension of a name without its dot.
fn clean_extension(ext_hint: &str) -> String {
    ext_hint.trim_start_matches('.').to_string()
}

/// Every level of a host path from the top down, in the spelling the host uses.
///
/// The root keeps its own shape: `/`, `C:\`, or `\\host\share`.
fn levels_of(path: &str) -> Vec<String> {
    let sep = if path.contains('\\') { '\\' } else { '/' };
    let root_end = if path.starts_with("\\\\") {
        // A UNC head runs through the share: `\\host\share` plus one separator.
        let mut seen = 0;
        let mut end = path.len();
        for (at, char) in path.char_indices() {
            if char == '\\' || char == '/' {
                seen += 1;
                if seen == 4 {
                    end = at + 1;
                    break;
                }
            }
        }
        end
    } else {
        path.find(['/', '\\']).map(|at| at + 1).unwrap_or(path.len())
    };
    let mut levels = Vec::new();
    let mut built = path[..root_end].to_string();
    for part in path[root_end..].split(['/', '\\']).filter(|part| !part.is_empty()) {
        if !built.ends_with(sep) {
            built.push(sep);
        }
        built.push_str(part);
        levels.push(built.clone());
    }
    levels
}

/// Directories first, then by name. The order of the picker, on both machines.
fn sort_dirs_first(rows: &mut [DirEntry]) {
    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
}

/// The directory of this machine that a read was asked about: `None` is the home.
fn local_start(home: Option<&Path>, path: Option<&str>) -> Result<PathBuf, Error> {
    match path {
        None => home.map(Path::to_path_buf).ok_or(Error::NoHomeDirectory),
        Some(path) if Path::new(path).is_absolute() => Ok(PathBuf::from(path)),
        Some(path) => Err(not_absolute(path)),
    }
}

/// The same over sftp: `None` is the login home of the session.
async fn remote_start(sftp: &SftpSession, path: Option<&str>) -> Result<String, Error> {
    match path {
        None => sftp
            .canonicalize(".")
            .await
            .map_err(|error| unreadable_there("the login home", error)),
        Some(path) => {
            // These are the paths of the host, not the paths of this machine. Over sftp
            // they are as the host writes them, POSIX or Windows. Neither is the
            // directory of pie.
            if !is_absolute_on_the_host(path) {
                return Err(not_absolute(path));
            }
            Ok(path.to_string())
        }
    }
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

/// A path on this machine that pie cannot remove appears as any other failure of
/// the reach. The frontend offers the same retry, and the message names the path at
/// fault.
pub(crate) fn unremovable(path: &str, source: std::io::Error) -> Error {
    Error::UnremovableLocal {
        path: path.to_string(),
        source,
    }
}

/// The same for a path on the host, over sftp.
pub(crate) fn unremovable_there(path: &str, source: SftpError) -> Error {
    Error::UnremovableRemote {
        path: path.to_string(),
        source,
    }
}

/// A directory on this machine that pie cannot make.
pub(crate) fn uncreatable(path: &str, source: std::io::Error) -> Error {
    Error::UncreatableLocal {
        path: path.to_string(),
        source,
    }
}

/// The same for a directory on the host, over sftp.
pub(crate) fn uncreatable_there(path: &str, source: SftpError) -> Error {
    Error::UncreatableRemote {
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

        let listing = dirs_local(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing");
        // The listing names the directory it read: the picker cannot name the home of
        // a machine by itself.
        assert_eq!(listing.directory, directory.path().display().to_string());
        let rows = listing.entries;

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
            .expect("the listing")
            .entries;

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
            .expect("the listing")
            .entries;

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

    #[test]
    fn the_levels_of_a_path_run_from_the_top_down() {
        assert_eq!(levels_of("/a/b"), ["/a", "/a/b"]);
        assert_eq!(levels_of("/a"), ["/a"]);
        assert!(levels_of("/").is_empty(), "the root itself needs no making");
        assert_eq!(levels_of("C:\\a\\b"), ["C:\\a", "C:\\a\\b"]);
    }

    #[tokio::test]
    async fn the_local_make_builds_missing_parents() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let nested = directory.path().join("a/b");
        let missing = nested.to_str().expect("utf-8");

        create_dir_local(missing).await.expect("the making");

        assert!(nested.is_dir(), "the nested directory stands");
    }

    #[tokio::test]
    async fn the_local_make_leaves_what_exists_alone() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let start = directory.path().to_str().expect("utf-8");

        create_dir_local(start).await.expect("making what stands is fine");
    }

    #[tokio::test]
    async fn the_local_make_takes_no_relative_path() {
        let error = create_dir_local("sessions/new").await.expect_err("a relative path");

        assert!(matches!(error, Error::NotAbsolute { .. }), "got {error:?}");
    }

    #[tokio::test]
    async fn the_local_probe_tells_a_directory_from_a_missing_name() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let start = directory.path().to_str().expect("utf-8");
        let missing = directory.path().join("gone").to_str().expect("utf-8").to_string();

        assert!(dir_exists_local(start).await.expect("a directory stands"));
        assert!(!dir_exists_local(&missing).await.expect("a missing name does not"));

        let error = dir_exists_local("sessions").await.expect_err("a relative path");
        assert!(matches!(error, Error::NotAbsolute { .. }), "got {error:?}");
    }

    #[test]
    fn temp_file_name_avoids_trailing_dot_and_sanitizes() {
        let with_ext = temp_file_name("sample.pdf", "pdf");
        assert!(with_ext.starts_with("pie-sample-"));
        assert!(with_ext.ends_with(".pdf"));

        let without_ext = temp_file_name("noext", "");
        assert!(without_ext.starts_with("pie-noext-"));
        assert!(!without_ext.ends_with('.'));
        assert!(!without_ext.contains('.'));

        let with_dot_ext = temp_file_name("photo", ".png");
        assert!(with_dot_ext.ends_with(".png"));
        assert!(!with_dot_ext.ends_with("..png"));

        let spaces = temp_file_name("my file (1)", "txt");
        assert!(spaces.starts_with("pie-my_file__1_-"));
        assert!(spaces.ends_with(".txt"));
    }

    #[tokio::test]
    async fn a_staged_file_holds_the_bytes_under_a_pie_name() {
        let path = stage_local("report.pdf", "pdf", b"%PDF-1.4").await.expect("the write");

        let staged = Path::new(&path);
        let name = staged.file_name().expect("a name").to_string_lossy().into_owned();
        assert!(name.starts_with("pie-report-"), "a name of pie's own: {name}");
        assert_eq!(staged.extension().and_then(|ext| ext.to_str()), Some("pdf"));
        assert_eq!(
            tokio::fs::read(staged).await.expect("the bytes"),
            b"%PDF-1.4",
            "the file holds what was handed to it"
        );

        tokio::fs::remove_file(staged).await.expect("the cleanup");
    }

    #[tokio::test]
    async fn two_staged_files_of_one_name_do_not_meet() {
        // The name of an attachment is the name the person's file has, so two of
        // them arrive with one name as a matter of course.
        let first = stage_local("notes.txt", "txt", b"one").await.expect("the first");
        let second = stage_local("notes.txt", "txt", b"two").await.expect("the second");

        assert_ne!(first, second, "the second write may not land on the first");
        assert_eq!(tokio::fs::read(&first).await.expect("the first"), b"one");
        assert_eq!(tokio::fs::read(&second).await.expect("the second"), b"two");

        tokio::fs::remove_file(&first).await.expect("the cleanup");
        tokio::fs::remove_file(&second).await.expect("the cleanup");
    }

    #[tokio::test]
    async fn a_staged_file_without_an_extension_ends_on_no_dot() {
        let path = stage_local("LICENSE", "", b"text").await.expect("the write");

        assert!(!path.ends_with('.'), "a trailing dot names no file: {path}");

        tokio::fs::remove_file(&path).await.expect("the cleanup");
    }
}
