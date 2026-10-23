//! Pi on this machine.
//!
//! The reach to this machine needs nothing: there is no socket to open, no
//! credential to present, and no host key to trust. What is left is where pi
//! starts, and where its files and sessions are read on this machine's
//! filesystem.

use super::files::{DirEntry, FileEntry, Listing, SeekableReader, clean_extension, clean_stem, sort_dirs_first};
use super::{Endpoint, Host, ProgressFn, StageSource, check_version, checked_host_path, is_absolute_path};
use crate::channel::{Channel, Program};
use anyhow::Context as _;
use camino::Utf8PathBuf;
use std::path::Path;

/// The arguments of the `pi` of this machine: the RPC mode, and the conversation
/// to load at the start when one is named.
///
/// Pi reads the conversation path itself, on the machine where it runs, so the
/// path travels as the host wrote it.
fn pi_args(conversation: Option<&str>) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    if let Some(path) = conversation {
        args.push("--session".to_string());
        args.push(path.to_string());
    }
    args
}

/// Writes `bytes` into the temporary directory of this machine, and answers where.
async fn stage_bytes(stem_hint: &str, ext_hint: &str, bytes: &[u8]) -> anyhow::Result<String> {
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
        .with_context(|| format!("cannot make {}", directory.display()))?;
    let (file, path) = claimed
        .keep()
        .with_context(|| format!("cannot make {}", directory.display()))?;
    let mut file = tokio::fs::File::from_std(file);
    file.write_all(bytes)
        .await
        .with_context(|| format!("cannot write {}", path.display()))?;
    file.flush()
        .await
        .with_context(|| format!("cannot write {}", path.display()))?;
    let path = Utf8PathBuf::from_path_buf(path)
        .map_err(|path| anyhow::anyhow!("temporary path is not valid utf-8: {}", path.display()))?;
    Ok(path.into_string())
}

/// This machine, as a machine that runs pi.
#[derive(Debug)]
pub struct LocalHost {
    /// The home directory of this machine: the start of a session when the
    /// frontend names no directory. `None` leaves pi in the directory of the
    /// app, which is the result on a platform without a home directory.
    home: Option<Utf8PathBuf>,
}

impl LocalHost {
    /// The machine the app itself runs on, with the home the app resolved.
    pub fn new(home: Option<Utf8PathBuf>) -> Self {
        Self { home }
    }
}

#[async_trait::async_trait]
impl Host for LocalHost {
    async fn connect(&self) -> anyhow::Result<()> {
        let version = self.pi_version().await?;
        if let Err(mismatch) = check_version(&version) {
            tracing::warn!(%mismatch, "the pi of this machine is not the release pie speaks; going on");
        }
        Ok(())
    }

    fn is_open(&self) -> bool {
        true
    }

    fn endpoint(&self) -> Endpoint {
        Endpoint::local()
    }

    async fn open_pi(&self, cwd: &str, conversation: Option<&str>) -> anyhow::Result<(Channel, Option<String>)> {
        let conversation = conversation.map(checked_host_path).transpose()?;
        let cwd = checked_host_path(cwd)?;
        let program = Program::new("pi").args(pi_args(conversation)).cwd(cwd);
        Ok((program.spawn()?, Some(cwd.to_string())))
    }

    async fn pi_version(&self) -> anyhow::Result<String> {
        let output = tokio::process::Command::new("pi")
            .arg("--version")
            .output()
            .await
            .context("`pi --version` failed: could not be started")?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !stdout.is_empty() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let said = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        if said.is_empty() {
            anyhow::bail!("`pi --version` failed with {}", output.status);
        } else {
            anyhow::bail!("`pi --version` failed: {said}");
        }
    }

    async fn dirs(&self, path: &str) -> anyhow::Result<Listing> {
        let path = checked_host_path(path)?;
        let shown = path.to_string();
        let mut entries = tokio::fs::read_dir(path)
            .await
            .with_context(|| format!("cannot read {shown}"))?;
        let mut rows = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .with_context(|| format!("cannot read {shown}"))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." {
                continue;
            }
            let is_dir = match tokio::fs::metadata(entry.path()).await {
                Ok(target) => target.is_dir(),
                Err(error) => {
                    tracing::warn!(path = %entry.path().display(), %error, "an entry pie cannot follow");
                    false
                }
            };
            let row_path = Utf8PathBuf::from_path_buf(entry.path())
                .map(|p| p.into_string())
                .unwrap_or_else(|p| p.to_string_lossy().into_owned());
            rows.push(DirEntry {
                name,
                path: row_path,
                is_dir,
            });
        }
        sort_dirs_first(&mut rows);
        Ok(Listing {
            directory: shown,
            entries: rows,
        })
    }

    async fn dir_exists(&self, path: &str) -> anyhow::Result<bool> {
        let path = is_absolute_path(path)?;
        match tokio::fs::metadata(path).await {
            Ok(target) => Ok(target.is_dir()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).with_context(|| format!("cannot read {path}")),
        }
    }

    async fn create_dir(&self, path: &str) -> anyhow::Result<()> {
        let path = is_absolute_path(path)?;
        tokio::fs::create_dir_all(path)
            .await
            .with_context(|| format!("cannot make {path}"))
    }

    async fn home_dir(&self) -> anyhow::Result<Option<String>> {
        let home = self
            .home
            .as_ref()
            .map(|p| p.as_str().to_string())
            .or_else(|| dirs::home_dir().and_then(|h| Utf8PathBuf::from_path_buf(h).ok().map(|p| p.into_string())));
        Ok(home)
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<FileEntry>> {
        let path = is_absolute_path(path)?;
        let mut dir = tokio::fs::read_dir(path)
            .await
            .with_context(|| format!("cannot read {path}"))?;
        let mut entries = Vec::new();
        while let Some(entry) = dir.next_entry().await.with_context(|| format!("cannot read {path}"))? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." {
                continue;
            }
            let meta = tokio::fs::metadata(entry.path()).await.ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = meta.as_ref().map(|m| m.len());
            let modified = meta.as_ref().and_then(|m| m.modified().ok());
            let entry_path = Utf8PathBuf::from_path_buf(entry.path())
                .map(|p| p.into_string())
                .unwrap_or_else(|p| p.to_string_lossy().into_owned());
            entries.push(FileEntry {
                name,
                path: entry_path,
                is_dir,
                size,
                modified,
            });
        }
        Ok(entries)
    }

    async fn open_file(&self, path: &str) -> anyhow::Result<Box<dyn SeekableReader>> {
        let path = is_absolute_path(path)?;
        let file = tokio::fs::File::open(path)
            .await
            .with_context(|| format!("cannot open {path}"))?;
        Ok(Box::new(file) as Box<dyn SeekableReader>)
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        let path = is_absolute_path(path)?;
        tokio::fs::remove_file(path)
            .await
            .with_context(|| format!("cannot remove {path}"))
    }

    async fn metadata(&self, path: &str) -> anyhow::Result<FileEntry> {
        let path = is_absolute_path(path)?;
        let meta = tokio::fs::metadata(path)
            .await
            .with_context(|| format!("cannot read metadata for {path}"))?;
        let name = Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        Ok(FileEntry {
            name,
            path: path.to_string(),
            is_dir: meta.is_dir(),
            size: Some(meta.len()),
            modified: meta.modified().ok(),
        })
    }

    async fn stage_file(
        &self,
        name: &str,
        ext: &str,
        source: StageSource<'_>,
        mut on_progress: ProgressFn<'_>,
    ) -> anyhow::Result<String> {
        match source {
            StageSource::LocalFile(path) => {
                let metadata = tokio::fs::metadata(path).await?;
                let size = metadata.len();
                on_progress(size, size);
                Ok(path.as_str().to_string())
            }
            StageSource::Bytes(bytes) => {
                let staged = stage_bytes(name, ext, bytes).await?;
                let size = bytes.len() as u64;
                on_progress(size, size);
                Ok(staged)
            }
        }
    }

    async fn close(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use camino::Utf8Path;

    #[test]
    fn a_conversation_is_passed_as_a_session_argument() {
        assert_eq!(pi_args(None), ["--mode", "rpc"]);
        assert_eq!(
            pi_args(Some("/tmp/sessions/one.jsonl")),
            ["--mode", "rpc", "--session", "/tmp/sessions/one.jsonl"]
        );
    }

    #[tokio::test]
    async fn the_local_rows_put_directories_first_and_carry_full_paths() {
        let directory = tempfile::tempdir().expect("a temp directory");
        std::fs::create_dir(directory.path().join("b-dir")).expect("the directory");
        std::fs::create_dir(directory.path().join("a-dir")).expect("the directory");
        std::fs::write(directory.path().join("z-file"), "").expect("the file");

        let host = LocalHost::new(None);
        let listing = host
            .dirs(directory.path().to_str().expect("utf-8"))
            .await
            .expect("the listing");
        assert_eq!(listing.directory, directory.path().display().to_string());
        let rows = listing.entries;

        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["a-dir", "b-dir", "z-file"]);
        assert_eq!(rows.iter().filter(|row| row.is_dir).count(), 2);
        for row in &rows {
            assert!(
                Utf8Path::new(&row.path).is_absolute(),
                "rows carry whole paths: {}",
                row.path
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_local_picker_follows_a_link_to_a_directory() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let target = directory.path().join("elsewhere");
        std::fs::create_dir(&target).expect("the target");
        std::os::unix::fs::symlink(&target, directory.path().join("a-link")).expect("the link");

        let host = LocalHost::new(None);
        let rows = host
            .dirs(directory.path().to_str().expect("utf-8"))
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
        let directory = tempfile::tempdir().expect("a temp directory");
        std::os::unix::fs::symlink(directory.path().join("nowhere"), directory.path().join("stale")).expect("the link");
        std::fs::write(directory.path().join("z-file"), "").expect("the file");

        let host = LocalHost::new(None);
        let rows = host
            .dirs(directory.path().to_str().expect("utf-8"))
            .await
            .expect("the listing")
            .entries;

        let stale = rows.iter().find(|row| row.name == "stale").expect("the link is listed");
        assert!(!stale.is_dir, "a link that leads nowhere is not a walkable directory");
    }

    #[tokio::test]
    async fn the_picker_takes_no_relative_path() {
        let host = LocalHost::new(None);
        for path in [".", "..", "sessions", "./sessions"] {
            let error = host.dirs(path).await.expect_err("`{path}` is relative");
            assert!(error.to_string().contains("is not absolute"), "got {error}");
        }
    }

    #[tokio::test]
    async fn the_local_make_builds_missing_parents() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let nested = directory.path().join("a/b");
        let missing = nested.to_str().expect("utf-8");

        let host = LocalHost::new(None);
        host.create_dir(missing).await.expect("the making");

        assert!(nested.is_dir(), "the nested directory stands");
    }

    #[tokio::test]
    async fn the_local_make_leaves_what_exists_alone() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let start = directory.path().to_str().expect("utf-8");

        let host = LocalHost::new(None);
        host.create_dir(start).await.expect("making what stands is fine");
    }

    #[tokio::test]
    async fn the_local_make_takes_no_relative_path() {
        let host = LocalHost::new(None);
        let error = host.create_dir("sessions/new").await.expect_err("a relative path");

        assert!(error.to_string().contains("is not absolute"), "got {error}");
    }

    #[tokio::test]
    async fn the_local_probe_tells_a_directory_from_a_missing_name() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let start = directory.path().to_str().expect("utf-8");
        let missing = directory.path().join("gone").to_str().expect("utf-8").to_string();

        let host = LocalHost::new(None);
        assert!(host.dir_exists(start).await.expect("a directory stands"));
        assert!(!host.dir_exists(&missing).await.expect("a missing name does not"));

        let error = host.dir_exists("sessions").await.expect_err("a relative path");
        assert!(error.to_string().contains("is not absolute"), "got {error}");
    }

    #[tokio::test]
    async fn a_removed_file_leaves_the_directory() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let file = directory.path().join("one.jsonl");
        std::fs::write(&file, "{}\n").expect("a file");

        let host = LocalHost::new(None);
        host.remove_file(file.to_str().expect("utf-8"))
            .await
            .expect("the removal");

        assert!(!file.exists(), "the file is gone");
    }

    #[tokio::test]
    async fn a_file_that_is_already_gone_cannot_be_removed_and_says_so() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let missing = directory.path().join("gone.jsonl");

        let host = LocalHost::new(None);
        let error = host
            .remove_file(missing.to_str().expect("utf-8"))
            .await
            .expect_err("a file that is not there cannot be removed");

        let message = error.to_string();
        assert!(
            message.contains("cannot remove"),
            "the failure names the step: {message}"
        );
        assert!(
            message.contains(missing.to_str().expect("utf-8")),
            "and the path at fault: {message}"
        );
    }

    #[tokio::test]
    async fn a_staged_file_holds_the_bytes_under_a_pie_name() {
        let path = stage_bytes("report.pdf", "pdf", b"%PDF-1.4").await.expect("the write");

        let staged = Utf8Path::new(&path);
        let name = staged.file_name().expect("a name");
        assert!(name.starts_with("pie-report-"), "a name of pie's own: {name}");
        assert_eq!(staged.extension(), Some("pdf"));
        assert_eq!(
            tokio::fs::read(staged).await.expect("the bytes"),
            b"%PDF-1.4",
            "the file holds what was handed to it"
        );

        tokio::fs::remove_file(staged).await.expect("the cleanup");
    }

    #[tokio::test]
    async fn two_staged_files_of_one_name_do_not_meet() {
        let first = stage_bytes("notes.txt", "txt", b"one").await.expect("the first");
        let second = stage_bytes("notes.txt", "txt", b"two").await.expect("the second");

        assert_ne!(first, second, "the second write may not land on the first");
        assert_eq!(tokio::fs::read(&first).await.expect("the first"), b"one");
        assert_eq!(tokio::fs::read(&second).await.expect("the second"), b"two");

        tokio::fs::remove_file(&first).await.expect("the cleanup");
        tokio::fs::remove_file(&second).await.expect("the cleanup");
    }

    #[tokio::test]
    async fn a_staged_file_without_an_extension_ends_on_no_dot() {
        let path = stage_bytes("LICENSE", "", b"text").await.expect("the write");

        assert!(!path.ends_with('.'), "a trailing dot names no file: {path}");

        tokio::fs::remove_file(&path).await.expect("the cleanup");
    }

    #[tokio::test]
    async fn read_dir_and_open_file_and_metadata_operate_on_local_filesystem() {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let directory = tempfile::tempdir().expect("temp dir");
        let dir_path = directory.path().to_str().expect("utf-8");
        let file_path = directory.path().join("test.txt");
        tokio::fs::write(&file_path, b"hello world").await.expect("write");

        let host = LocalHost::new(None);
        let entries = host.read_dir(dir_path).await.expect("read_dir");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "test.txt");
        assert!(!entries[0].is_dir);
        assert_eq!(entries[0].size, Some(11));

        let meta = host
            .metadata(file_path.to_str().expect("utf-8"))
            .await
            .expect("metadata");
        assert_eq!(meta.name, "test.txt");
        assert_eq!(meta.size, Some(11));

        let mut reader = host
            .open_file(file_path.to_str().expect("utf-8"))
            .await
            .expect("open_file");
        let mut buf = vec![0u8; 5];
        reader.read_exact(&mut buf).await.expect("read_exact");
        assert_eq!(&buf, b"hello");

        reader.seek(std::io::SeekFrom::Start(6)).await.expect("seek");
        let mut rest = String::new();
        reader.read_to_string(&mut rest).await.expect("read_to_string");
        assert_eq!(rest, "world");
    }
}
