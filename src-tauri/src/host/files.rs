//! Shared file types and path utilities for the machine pie reaches.

use std::{fmt, time::SystemTime};

use anyhow::Context as _;
use camino::Utf8Path;
use serde::Serialize;
use sha2::{Digest, Sha256};
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

    /// Returns the directory used for staged files on this machine.
    async fn cache_dir(&self) -> anyhow::Result<String>;

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

    /// Stages a file of this device where `pi` on this machine can read it,
    /// reporting progress through `on_progress`.
    async fn stage_file(
        &self,
        name: &str,
        ext: &str,
        source: &Utf8Path,
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

/// Progress callback `(transferred, total)` for file staging.
pub type ProgressFn<'a> = Box<dyn FnMut(u64, u64) + Send + 'a>;

/// Directories first, then by name. The order of the picker, on both machines.
pub(super) fn sort_dirs_first(rows: &mut [DirEntry]) {
    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
}

/// How many hex digits of the SHA-256 digest a staged name keeps.
pub const DIGEST_HEX: usize = 16;

/// Returns the truncated hex SHA-256 digest of bytes.
pub fn digest_bytes(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let hex = format!("{hash:x}");
    hex[..DIGEST_HEX].to_string()
}

/// Returns the truncated hex SHA-256 digest and byte size of a local file.
pub async fn digest_file(path: &Utf8Path) -> anyhow::Result<(String, u64)> {
    let std_path = path.to_path_buf().into_std_path_buf();
    tokio::task::spawn_blocking(move || -> anyhow::Result<(String, u64)> {
        use std::io::Read as _;
        let mut file = std::fs::File::open(&std_path).with_context(|| format!("cannot read {}", std_path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut total = 0u64;
        loop {
            let read = file
                .read(&mut buffer)
                .with_context(|| format!("cannot read {}", std_path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            total += read as u64;
        }
        let hex = format!("{:x}", hasher.finalize());
        Ok((hex[..DIGEST_HEX].to_string(), total))
    })
    .await
    .map_err(|e| anyhow::anyhow!("digest worker failed: {e}"))?
}

/// The name of a staged copy: the same bytes under the same name get the same
/// name, so a copy that already landed is not written again.
pub fn staged_name(digest: &str, stem_hint: &str, ext_hint: &str) -> String {
    let stem = clean_stem(stem_hint);
    let extension = clean_extension(ext_hint);
    if extension.is_empty() {
        format!("{digest}-{stem}")
    } else {
        format!("{digest}-{stem}.{extension}")
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

/// Validates that a host path is absolute.
pub(crate) fn check_absolute(path: &str) -> anyhow::Result<&str> {
    if Utf8TypedPath::derive(path).is_absolute() {
        Ok(path)
    } else {
        anyhow::bail!("`{path}` is not absolute; pie resolves no path against its own directory")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_absolute_accepts_posix_and_windows_roots_and_rejects_relative_paths() {
        for path in ["/", "/home/u", "C:\\Users\\u", "c:/Users/u", "\\\\server\\share"] {
            assert!(check_absolute(path).is_ok(), "`{path}` is absolute");
        }
        for path in ["", ".", "sessions/one", "C:relative", "\\Users\\u"] {
            assert!(check_absolute(path).is_err(), "`{path}` is relative");
        }
    }

    #[test]
    fn a_relative_path_names_itself_in_the_refusal() {
        let error = check_absolute(".pi/agent/sessions").unwrap_err();

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
    fn staged_name_formats_cleanly_without_trailing_dot() {
        let with_ext = staged_name("0123456789abcdef", "sample.pdf", "pdf");
        assert_eq!(with_ext, "0123456789abcdef-sample.pdf");

        let without_ext = staged_name("0123456789abcdef", "noext", "");
        assert_eq!(without_ext, "0123456789abcdef-noext");

        let with_dot_ext = staged_name("0123456789abcdef", "photo", ".png");
        assert_eq!(with_dot_ext, "0123456789abcdef-photo.png");

        let spaces = staged_name("0123456789abcdef", "my file (1)", "txt");
        assert_eq!(spaces, "0123456789abcdef-my_file__1_.txt");
    }

    #[tokio::test]
    async fn digest_file_matches_digest_bytes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("test.bin");
        let content = b"hello world from pie attachments";
        std::fs::write(&path, content).expect("write file");

        let utf8_path = camino::Utf8Path::from_path(&path).expect("utf8 path");
        let (file_digest, size) = digest_file(utf8_path).await.expect("digest file");
        let bytes_digest = digest_bytes(content);

        assert_eq!(file_digest, bytes_digest);
        assert_eq!(size, content.len() as u64);
    }
}
