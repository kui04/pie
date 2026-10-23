//! Shared file types and path utilities for the machine pie reaches.

use std::time::SystemTime;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncSeek};
use typed_path::Utf8TypedPath;

/// A seekable, readable stream backed by a local file or remote SFTP channel.
pub trait SeekableReader: AsyncRead + AsyncSeek + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncSeek + Send + Unpin + 'static> SeekableReader for T {}

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
