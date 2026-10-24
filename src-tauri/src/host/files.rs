//! Shared file types and path utilities for the machine pie reaches.

use std::{fmt, time::SystemTime};

use camino::Utf8Path;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncSeek};
use typed_path::Utf8TypedPath;

/// A seekable, readable stream backed by a local file or remote SFTP channel.
pub trait AsyncReadSeek: AsyncRead + AsyncSeek + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncSeek + Send + Unpin + 'static> AsyncReadSeek for T {}

/// The file operations of one machine.
#[async_trait::async_trait]
pub trait Files: fmt::Debug + Send + Sync + 'static {
    /// Returns the login home directory of this machine, if known.
    async fn home_dir(&self) -> anyhow::Result<Option<String>>;

    /// Reads directory entries of a directory on the machine.
    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<FileEntry>>;

    /// Opens a file for seekable asynchronous reading.
    async fn open(&self, path: &str) -> anyhow::Result<Box<dyn AsyncReadSeek>>;

    /// Removes a file on the machine.
    async fn remove_file(&self, path: &str) -> anyhow::Result<()>;

    /// Checks whether an absolute path names a directory on the machine.
    async fn is_dir(&self, path: &str) -> anyhow::Result<bool>;

    /// Creates a directory on the machine, with parents as needed.
    async fn create_dir_all(&self, path: &str) -> anyhow::Result<()>;

    /// Stages a file where `pi` on this machine can read it, reporting progress
    /// through `on_progress`.
    async fn stage_file(
        &self,
        name: &str,
        ext: &str,
        source: StageSource<'_>,
        on_progress: ProgressFn<'_>,
    ) -> anyhow::Result<String>;
}

/// One entry of a directory read on a host.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// File or directory name.
    pub name: String,
    /// Absolute path on the host.
    pub path: String,
    /// Whether this entry is a directory.
    pub is_dir: bool,
    /// File size in bytes, if known.
    pub size: Option<u64>,
    /// Last modification time, if known.
    pub modified: Option<SystemTime>,
}

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
/// The directory comes back with the rows so the picker always knows the full
/// host path of the level it is showing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The directory that was read, as the host writes it.
    pub directory: String,
    /// Its rows, directories first.
    pub entries: Vec<DirEntry>,
}

/// Source data for staging an attachment on a [`Host`](super::Host).
pub enum StageSource<'a> {
    /// A file that already exists on the local filesystem.
    ///
    /// [`LocalHost`](super::LocalHost) reuses this path without copying;
    /// [`SshHost`](super::SshHost) reads and uploads the file over SFTP.
    LocalFile(&'a Utf8Path),
    /// In-memory file bytes.
    Bytes(&'a [u8]),
}

/// Progress callback `(transferred, total)` for file staging.
pub type ProgressFn<'a> = Box<dyn FnMut(u64, u64) + Send + 'a>;

/// Directories first, then by name. The order of the picker, on both machines.
pub(super) fn sort_dirs_first(rows: &mut [DirEntry]) {
    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
}

/// The name of the temporary copy that a machine keeps for one attachment.
///
/// This names a file on a host that pie cannot create one on itself: the upload
/// writes under this name. A file on this machine is named by `tempfile`
/// instead, which chooses the part that must not collide.
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

/// The part of a name that a temporary copy keeps: letters, digits, `-` and `_`,
/// so that the name is legal on every machine that pie reaches.
pub(super) fn clean_stem(stem_hint: &str) -> String {
    let stem: String = Utf8TypedPath::derive(stem_hint)
        .file_stem()
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
pub(super) fn clean_extension(ext_hint: &str) -> String {
    ext_hint.trim_start_matches('.').to_string()
}

/// A relative path is a mistake of the frontend, not a failure of the host.
///
/// The function has a name so that a caller can reject such a path before the
/// handshake of a channel, and so that the sentence is written once.
pub(crate) fn not_absolute(path: &str) -> anyhow::Error {
    anyhow::anyhow!("`{path}` is not absolute; pie resolves no path against its own directory")
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
