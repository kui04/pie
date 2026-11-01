//! The files of a machine, and the two transports that read them.

use std::fmt::Debug;
use std::time::SystemTime;

use anyhow::{Context as _, ensure};
use bitflags::bitflags;
use bytes::Bytes;
use enum_dispatch::enum_dispatch;
use russh_sftp::protocol::OpenFlags;
use tokio::io::AsyncRead;
use tokio::sync::watch;
use tokio_util::either::Either;
use typed_path::{Utf8TypedPath, Utf8TypedPathBuf};

use crate::host::executor::OsFamily;

/// What pie reads about one entry of a machine.
///
/// The fields follow what `std::fs::Metadata` answers: the kind is read after a
/// link is followed, and a link names itself. std owns both `Metadata` and
/// `FileType`, though, and an SFTP listing builds neither, so the answers travel
/// as plain values that both transports can produce.
#[derive(Debug, Clone)]
pub struct FileMetadata {
    /// Whether the entry names a file, after following a link.
    pub is_file: bool,
    /// Whether the entry names a directory, after following a link.
    pub is_dir: bool,
    /// Whether the entry itself is a link, whatever it names.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "exercised by the filesystem unit tests")
    )]
    pub is_symlink: bool,
    /// The size in bytes of what the entry names, when the machine says.
    pub len: Option<u64>,
    /// The path the machine writes for it.
    pub path: Utf8TypedPathBuf,
    /// When it last changed, when the machine says.
    pub modified: Option<SystemTime>,
    /// When it was created, when the machine says.
    pub created: Option<SystemTime>,
}

/// A file opened on a host, for reading, writing, and seeking.
pub type HostFile = Either<tokio::fs::File, russh_sftp::client::fs::File>;

bitflags! {
    /// Bitflags for opening a file on a local or SSH host.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct FileOpenOptions: u32 {
        const READ       = 0x0000_0001;
        const WRITE      = 0x0000_0002;
        const APPEND     = 0x0000_0004;
        const CREATE     = 0x0000_0008;
        const TRUNCATE   = 0x0000_0010;
        const CREATE_NEW = 0x0000_0020;
    }
}

impl FileOpenOptions {
    /// Creates an empty set of options.
    pub const fn new() -> Self {
        Self::empty()
    }

    pub fn read(&mut self, read: bool) -> &mut Self {
        self.set(Self::READ, read);
        self
    }

    pub fn write(&mut self, write: bool) -> &mut Self {
        self.set(Self::WRITE, write);
        self
    }

    pub fn append(&mut self, append: bool) -> &mut Self {
        self.set(Self::APPEND, append);
        self
    }

    pub fn truncate(&mut self, truncate: bool) -> &mut Self {
        self.set(Self::TRUNCATE, truncate);
        self
    }

    pub fn create(&mut self, create: bool) -> &mut Self {
        self.set(Self::CREATE, create);
        self
    }

    pub fn create_new(&mut self, create_new: bool) -> &mut Self {
        self.set(Self::CREATE_NEW, create_new);
        self
    }
}

impl From<&FileOpenOptions> for tokio::fs::OpenOptions {
    fn from(opts: &FileOpenOptions) -> Self {
        Self::from(*opts)
    }
}

impl From<FileOpenOptions> for tokio::fs::OpenOptions {
    fn from(opts: FileOpenOptions) -> Self {
        let mut tokio_opts = tokio::fs::OpenOptions::new();
        tokio_opts
            .read(opts.contains(FileOpenOptions::READ) || opts.is_empty())
            .write(opts.contains(FileOpenOptions::WRITE))
            .append(opts.contains(FileOpenOptions::APPEND))
            .truncate(opts.contains(FileOpenOptions::TRUNCATE))
            .create(opts.contains(FileOpenOptions::CREATE))
            .create_new(opts.contains(FileOpenOptions::CREATE_NEW));
        tokio_opts
    }
}

impl From<&FileOpenOptions> for OpenFlags {
    fn from(opts: &FileOpenOptions) -> Self {
        Self::from(*opts)
    }
}

impl From<FileOpenOptions> for OpenFlags {
    fn from(opts: FileOpenOptions) -> Self {
        let mut flags = OpenFlags::empty();
        if opts.contains(FileOpenOptions::READ) {
            flags |= OpenFlags::READ;
        }
        if opts.contains(FileOpenOptions::WRITE) {
            flags |= OpenFlags::WRITE;
        }
        if opts.contains(FileOpenOptions::APPEND) {
            flags |= OpenFlags::APPEND | OpenFlags::WRITE;
        }
        if opts.contains(FileOpenOptions::TRUNCATE) {
            flags |= OpenFlags::TRUNCATE;
        }
        if opts.contains(FileOpenOptions::CREATE) || opts.contains(FileOpenOptions::CREATE_NEW) {
            flags |= OpenFlags::CREATE;
        }
        if opts.contains(FileOpenOptions::CREATE_NEW) {
            flags |= OpenFlags::EXCLUDE;
        }
        if flags.is_empty() {
            OpenFlags::READ
        } else {
            flags
        }
    }
}

/// The files of a machine.
#[enum_dispatch]
pub trait FileSystem: Send + Sync + Debug {
    /// The login home of this machine.
    async fn home_dir(&self) -> anyhow::Result<Utf8TypedPathBuf>;
    /// The directory where this machine keeps the cache of a program.
    async fn cache_dir(&self) -> anyhow::Result<Utf8TypedPathBuf>;
    /// The row of one entry: its kind, its size, and its times.
    async fn metadata(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<FileMetadata>;
    /// Every row of one directory; an entry pie cannot read is left out.
    async fn read_dir(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<Vec<FileMetadata>>;
    /// Whether a path names a directory, following a link; a missing path is not one.
    async fn is_dir(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<bool>;
    /// Opens one file with `options`.
    ///
    /// A write reaches the file when the caller flushes or closes the handle: the
    /// handle buffers, so a returned `write_all` alone leaves the bytes unsent.
    async fn open_file(
        &self,
        path: Utf8TypedPath<'_>,
        options: FileOpenOptions,
    ) -> anyhow::Result<HostFile>;
    /// Reads a whole file into memory.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "exercised by the filesystem unit tests")
    )]
    async fn read_bytes(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<Bytes>;
    /// Writes `source` to `path`, reporting the bytes written as it goes.
    ///
    /// The file is flushed before this returns, so a caller can hand the path to
    /// pi as soon as it has the answer.
    async fn write_from<R>(
        &self,
        path: Utf8TypedPath<'_>,
        source: R,
        progress: watch::Sender<u64>,
    ) -> anyhow::Result<()>
    where
        R: AsyncRead + Unpin + Send;
    /// Removes one file; a directory is refused.
    async fn remove(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<()>;
    /// Makes one directory and every parent it needs.
    async fn create_dir_all(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<()>;
}

/// Refuses a path of a type the machine does not write.
pub(crate) fn check_type(path: Utf8TypedPath<'_>, family: OsFamily) -> anyhow::Result<()> {
    let written = match family {
        OsFamily::Unix => path.is_unix(),
        OsFamily::Windows => path.is_windows(),
    };
    ensure!(written, "`{path}` is not a path of this machine");
    Ok(())
}

/// The typed path this machine writes for the text `path`.
pub(crate) fn typed(path: impl AsRef<str>, family: OsFamily) -> Utf8TypedPathBuf {
    match family {
        OsFamily::Unix => Utf8TypedPathBuf::from_unix(path),
        OsFamily::Windows => Utf8TypedPathBuf::from_windows(path),
    }
}

/// Where staged files wait for pi to read them, inside `cache_dir`.
pub(crate) fn uploads_dir(cache_dir: Utf8TypedPath<'_>) -> Utf8TypedPathBuf {
    cache_dir.join("pie").join("uploads")
}

/// Refuses a path pie would otherwise resolve against its own directory.
pub(crate) fn require_absolute(path: Utf8TypedPath<'_>) -> anyhow::Result<Utf8TypedPath<'_>> {
    ensure!(
        path.is_absolute(),
        "`{path}` is not absolute; pie resolves no path against its own directory"
    );
    Ok(path)
}

/// Where the file to stage comes from.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UploadSource {
    /// A file of the machine pie runs on.
    Local { path: camino::Utf8PathBuf },
    /// A file the frontend already holds.
    InMemory { name: String, content: bytes::Bytes },
}

/// The transfer state of a staged file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UploadStatus {
    /// The file was written in full.
    UploadedFresh,
    /// The file resumed from a partial upload at `offset`.
    Resumed { offset: u64 },
    /// An identical remote file was found; no bytes were sent.
    SkippedDuplicate {
        #[serde(rename = "existingRemotePath")]
        existing_remote_path: Utf8TypedPathBuf,
    },
}

/// The receipt returned when a file upload finishes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReceipt {
    /// The BLAKE3 digest of the file.
    pub hash: blake3::Hash,
    /// The destination path on the remote host.
    pub remote_path: Utf8TypedPathBuf,
    /// The full length of the file in bytes.
    pub total_bytes: u64,
    /// The number of bytes sent in this operation.
    pub bytes_transferred: u64,
    /// Whether the file was uploaded, resumed, or skipped.
    pub status: UploadStatus,
}

/// The largest file pie stages for a prompt (128 MiB).
pub(crate) const MAX_UPLOAD_FILE_SIZE: u64 = 128 * 1024 * 1024;

/// The name a staged file takes: the digest goes before the extension, so the same
/// bytes always land on the same name and a second upload meets the first.
pub(crate) fn hashed_name(name: &str, hash: &blake3::Hash) -> String {
    let hex = hash.to_hex();
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
            format!("{stem}.{hex}.{extension}")
        }
        _ => format!("{name}.{hex}"),
    }
}

/// The one component `raw` names, under either separator.
///
/// The frontend names a file, and a name is not a path: no component of it may
/// leave the directory pie stages in, on a machine of either family.
pub(crate) fn staged_name(raw: &str) -> anyhow::Result<&str> {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    ensure!(
        !last.is_empty() && last != "." && last != "..",
        "`{raw}` names no file pie can stage"
    );
    Ok(last)
}

/// The BLAKE3 digest and the whole length of the file `source` names.
pub(crate) async fn upload_digest(source: &UploadSource) -> anyhow::Result<(blake3::Hash, u64)> {
    match source {
        UploadSource::Local { path } => {
            let path = path.clone();
            tokio::task::spawn_blocking(move || -> anyhow::Result<(blake3::Hash, u64)> {
                let mut file = std::fs::File::open(path.as_std_path())
                    .with_context(|| format!("cannot open local file `{path}`"))?;
                let expected_len = file.metadata()?.len();
                ensure!(
                    expected_len <= MAX_UPLOAD_FILE_SIZE,
                    "file size ({expected_len} bytes) exceeds maximum limit ({MAX_UPLOAD_FILE_SIZE} bytes)"
                );
                let mut hasher = blake3::Hasher::new();
                hasher.update_reader(&mut file)?;
                let read_len = hasher.count();
                ensure!(
                    read_len == expected_len,
                    "local file size changed while hashing: expected {expected_len}, read {read_len}"
                );
                Ok((hasher.finalize(), read_len))
            })
            .await
            .context("blocking hash worker panicked")?
        }
        UploadSource::InMemory { content, .. } => {
            let len = content.len() as u64;
            ensure!(
                len <= MAX_UPLOAD_FILE_SIZE,
                "in-memory file size ({len} bytes) exceeds maximum limit ({MAX_UPLOAD_FILE_SIZE} bytes)"
            );
            let hash = blake3::hash(content);
            Ok((hash, len))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_staged_name_carries_the_digest_before_the_extension() {
        let hash = blake3::hash(b"hello");
        let hex = hash.to_hex();

        assert_eq!(
            hashed_name("diagram.svg", &hash),
            format!("diagram.{hex}.svg")
        );
        assert_eq!(
            hashed_name("Dockerfile", &hash),
            format!("Dockerfile.{hex}")
        );
    }

    #[test]
    fn a_name_from_the_frontend_keeps_one_component() {
        assert_eq!(staged_name("a/b/c.png").unwrap(), "c.png");
        assert_eq!(staged_name("a\\b\\c.png").unwrap(), "c.png");
        assert_eq!(staged_name("  c.png  ").unwrap(), "c.png");

        for name in ["", "..", "/", "a/..", "///"] {
            assert!(staged_name(name).is_err(), "`{name}` names no file");
        }
    }

    #[tokio::test]
    async fn a_digest_counts_a_source_held_in_memory() {
        let bytes = b"hello";
        let (hash, len) = upload_digest(&UploadSource::InMemory {
            name: "x".to_owned(),
            content: Bytes::from_static(bytes),
        })
        .await
        .expect("a digest");

        assert_eq!(len, 5);
        assert_eq!(hash, blake3::hash(bytes));
    }

    #[tokio::test]
    async fn a_digest_reads_a_file_of_this_machine() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let std_path = directory.path().join("source.txt");
        std::fs::write(&std_path, b"hello").expect("the file lands");
        let path = camino::Utf8PathBuf::from_path_buf(std_path).expect("a UTF-8 path");

        let (hash, len) = upload_digest(&UploadSource::Local { path })
            .await
            .expect("a digest");

        assert_eq!(len, 5);
        assert_eq!(hash, blake3::hash(b"hello"));
    }

    #[test]
    fn only_an_absolute_path_names_a_place_on_a_machine() {
        for path in [
            "/",
            "/home/u",
            "C:\\Users\\u",
            "c:/Users/u",
            "\\\\server\\share",
        ] {
            let path = Utf8TypedPath::derive(path);
            assert!(require_absolute(path).is_ok(), "`{path}` is absolute");
        }
        for path in ["", ".", "sessions/one", "C:relative", "\\Users\\u"] {
            let path = Utf8TypedPath::derive(path);
            assert!(require_absolute(path).is_err(), "`{path}` is relative");
        }
    }

    #[test]
    fn a_relative_path_names_itself_in_the_refusal() {
        let error = require_absolute(Utf8TypedPath::derive(".pi/agent/sessions")).unwrap_err();

        assert_eq!(
            error.to_string(),
            "`.pi/agent/sessions` is not absolute; pie resolves no path against its own directory"
        );
    }

    #[test]
    fn a_machine_accepts_only_the_kind_of_path_it_writes() {
        let unix = Utf8TypedPath::derive("/tmp/pi");
        let windows = Utf8TypedPath::derive("C:\\Users\\u");

        assert!(check_type(unix, OsFamily::Unix).is_ok());
        assert!(check_type(windows, OsFamily::Windows).is_ok());
        assert!(check_type(unix, OsFamily::Windows).is_err());
        assert!(check_type(windows, OsFamily::Unix).is_err());
    }

    #[test]
    fn a_path_of_another_kind_names_itself_in_the_refusal() {
        let windows = Utf8TypedPath::derive("C:\\Users\\u");

        let error =
            check_type(windows, OsFamily::Unix).expect_err("a Unix machine writes Unix paths");

        assert_eq!(
            error.to_string(),
            "`C:\\Users\\u` is not a path of this machine"
        );
    }

    #[cfg(unix)]
    #[test]
    fn this_process_is_a_unix_one() {
        assert_eq!(OsFamily::of_this_process(), OsFamily::Unix);
    }

    #[cfg(windows)]
    #[test]
    fn this_process_is_a_windows_one() {
        assert_eq!(OsFamily::of_this_process(), OsFamily::Windows);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_takes_the_kind_of_the_machine_that_writes_it() {
        let unix = typed("/tmp/pi work", OsFamily::Unix);
        let windows = typed("C:\\Users\\u", OsFamily::Windows);

        assert!(unix.is_unix());
        assert_eq!(unix.to_path().as_str(), "/tmp/pi work");
        assert!(windows.is_windows());
        assert_eq!(windows.to_path().as_str(), "C:\\Users\\u");
    }
}
