use anyhow::Context as _;
use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use tokio_util::either::Either;
use typed_path::{Utf8TypedPath, Utf8TypedPathBuf};

use crate::channel::{Channel, Process};
use crate::host::executor::OsFamily;
use crate::host::fs::{
    FileOpenOptions, UploadReceipt, UploadSource, UploadStatus, check_type, hashed_name,
    require_absolute, staged_name, typed, upload_digest, uploads_dir,
};
use crate::host::{
    Command, CommandOutput, Executor, FileMetadata, FileSystem, HostFile, OUTPUT_TIMEOUT,
};
use crate::state::LocalDirs;

/// Bytes written to the file per syscall. A staged file reports progress once
/// per chunk.
const COPY_BUFFER: usize = 64 * 1024;

/// This machine.
pub struct LocalHost {
    /// The login home of this machine, where a new session starts when the
    /// frontend names no directory.
    home: Option<Utf8TypedPathBuf>,
    /// Where staged files wait for pi to read them.
    cache: Option<Utf8TypedPathBuf>,
}

impl std::fmt::Debug for LocalHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("LocalHost")
    }
}

impl LocalHost {
    /// This machine, with the home and the cache the app resolved for it.
    ///
    /// This is where the paths of pie's own machine become paths of this machine:
    /// the app keeps them as camino paths, and a machine path knows its own shape.
    pub(crate) fn new(dirs: &LocalDirs) -> Self {
        let family = OsFamily::of_this_process();
        Self {
            home: dirs.home.as_ref().map(|home| typed(home.as_str(), family)),
            cache: dirs
                .cache
                .as_ref()
                .map(|cache| typed(cache.as_str(), family)),
        }
    }

    /// Stages `source` in the upload cache of this machine, where its own pi can read it.
    pub(crate) async fn upload_file(
        &self,
        source: UploadSource,
        progress: watch::Sender<u64>,
    ) -> anyhow::Result<UploadReceipt> {
        let (hash, total_bytes) = upload_digest(&source).await?;
        let file_name = match &source {
            UploadSource::Local { path } => staged_name(path.as_str())?,
            UploadSource::InMemory { name, .. } => staged_name(name)?,
        };

        let cache = self.cache_dir().await?;
        let directory = uploads_dir(cache.to_path());
        let remote_path = directory.join(hashed_name(file_name, &hash));

        if let Ok(metadata) = self.metadata(remote_path.to_path()).await
            && metadata.is_file
            && metadata.len == Some(total_bytes)
        {
            progress.send_replace(total_bytes);
            return Ok(UploadReceipt {
                hash,
                remote_path: remote_path.clone(),
                total_bytes,
                bytes_transferred: 0,
                status: UploadStatus::SkippedDuplicate {
                    existing_remote_path: remote_path,
                },
            });
        }

        self.create_dir_all(directory.to_path()).await?;
        match source {
            UploadSource::Local { path } => {
                let file = tokio::fs::File::open(path.as_std_path())
                    .await
                    .with_context(|| format!("cannot open local file `{path}`"))?;
                self.write_from(remote_path.to_path(), file, progress)
                    .await?;
            }
            UploadSource::InMemory { content, .. } => {
                self.write_from(remote_path.to_path(), &content[..], progress)
                    .await?;
            }
        }

        Ok(UploadReceipt {
            hash,
            remote_path,
            total_bytes,
            bytes_transferred: total_bytes,
            status: UploadStatus::UploadedFresh,
        })
    }
}

impl Executor for LocalHost {
    async fn family(&self) -> OsFamily {
        OsFamily::of_this_process()
    }

    async fn spawn(&self, cmd: Command) -> anyhow::Result<(Channel, Process)> {
        let mut command = tokio::process::Command::new(&cmd.program);
        command.args(&cmd.args).envs(&cmd.env);
        if let Some(cwd) = &cmd.cwd {
            command.current_dir(cwd);
        }

        let (channel, process) = crate::channel::local::spawn(command)?;
        Ok((channel, Process::Local(process)))
    }

    async fn exec(&self, cmd: Command) -> anyhow::Result<CommandOutput> {
        let mut command = tokio::process::Command::new(&cmd.program);
        command.args(&cmd.args).envs(&cmd.env).kill_on_drop(true);
        if let Some(cwd) = &cmd.cwd {
            command.current_dir(cwd);
        }

        let program = cmd.program;
        // `output` reads both pipes while the program runs, so a program that
        // fills one never blocks on it.
        let output = tokio::time::timeout(OUTPUT_TIMEOUT, command.output())
            .await
            .with_context(|| format!("`{program}` did not answer within {OUTPUT_TIMEOUT:?}"))?
            .with_context(|| format!("failed to run `{program}`"))?;

        Ok(CommandOutput {
            stdout: Bytes::from(output.stdout),
            stderr: Bytes::from(output.stderr),
            exit_status: output.status.into(),
        })
    }
}

impl FileSystem for LocalHost {
    async fn home_dir(&self) -> anyhow::Result<Utf8TypedPathBuf> {
        self.home
            .clone()
            .context("this machine has no home directory")
    }

    async fn cache_dir(&self) -> anyhow::Result<Utf8TypedPathBuf> {
        self.cache
            .clone()
            .context("this machine has no cache directory")
    }

    async fn metadata(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<FileMetadata> {
        row_of(path, self.family().await).await
    }

    async fn read_dir(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<Vec<FileMetadata>> {
        let path = require_absolute(path)?;
        let family = self.family().await;
        check_type(path, family)?;
        let mut entries = tokio::fs::read_dir(path.as_str())
            .await
            .with_context(|| format!("cannot read {path}"))?;

        let mut rows = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .with_context(|| format!("cannot read {path}"))?
        {
            let entry_path = typed(entry.path().to_string_lossy(), family);
            match row_of(entry_path.to_path(), family).await {
                Ok(row) => rows.push(row),
                Err(error) => tracing::warn!(%error, "an entry pie cannot read"),
            }
        }
        Ok(rows)
    }

    async fn is_dir(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<bool> {
        let path = require_absolute(path)?;
        check_type(path, self.family().await)?;

        match tokio::fs::metadata(path.as_str()).await {
            Ok(metadata) => Ok(metadata.is_dir()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).with_context(|| format!("cannot check {path}")),
        }
    }

    async fn open_file(
        &self,
        path: Utf8TypedPath<'_>,
        options: FileOpenOptions,
    ) -> anyhow::Result<HostFile> {
        let path = require_absolute(path)?;
        check_type(path, self.family().await)?;
        let tokio_options = tokio::fs::OpenOptions::from(&options);
        let file = tokio_options
            .open(path.as_str())
            .await
            .with_context(|| format!("cannot open {path}"))?;
        Ok(Either::Left(file))
    }

    async fn read_bytes(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<Bytes> {
        let path = require_absolute(path)?;
        check_type(path, self.family().await)?;
        let bytes = tokio::fs::read(path.as_str())
            .await
            .with_context(|| format!("cannot read {path}"))?;
        Ok(Bytes::from(bytes))
    }

    async fn write_from<R>(
        &self,
        path: Utf8TypedPath<'_>,
        mut source: R,
        progress: watch::Sender<u64>,
    ) -> anyhow::Result<()>
    where
        R: AsyncRead + Unpin + Send,
    {
        let path = require_absolute(path)?;
        let family = self.family().await;
        check_type(path, family)?;
        let mut file = tokio::fs::File::create(path.as_str())
            .await
            .with_context(|| format!("cannot create {path}"))?;
        let mut buffer = vec![0u8; COPY_BUFFER].into_boxed_slice();
        let mut written = 0u64;

        loop {
            let read = source
                .read(&mut buffer)
                .await
                .with_context(|| format!("cannot read the file of {path}"))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .await
                .with_context(|| format!("cannot write {path}"))?;
            written += read as u64;
            progress.send_replace(written);
        }

        file.flush()
            .await
            .with_context(|| format!("cannot write {path}"))?;
        Ok(())
    }

    async fn remove(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<()> {
        let path = require_absolute(path)?;
        check_type(path, self.family().await)?;
        tokio::fs::remove_file(path.as_str())
            .await
            .with_context(|| format!("cannot remove {path}"))
    }

    async fn create_dir_all(&self, path: Utf8TypedPath<'_>) -> anyhow::Result<()> {
        let path = require_absolute(path)?;
        check_type(path, self.family().await)?;
        tokio::fs::create_dir_all(path.as_str())
            .await
            .with_context(|| format!("cannot make {path}"))
    }
}

/// The row pie shows for one entry: the entry itself, and what a link names.
///
/// A broken link still shows itself, with no kind and no size: it is a row of the
/// directory, not a row that vanishes.
async fn row_of(path: Utf8TypedPath<'_>, host: OsFamily) -> anyhow::Result<FileMetadata> {
    check_type(path, host)?;
    let local = path.as_str();
    let entry = tokio::fs::symlink_metadata(local)
        .await
        .with_context(|| format!("cannot read {path}"))?;
    let is_symlink = entry.file_type().is_symlink();
    let target = if is_symlink {
        tokio::fs::metadata(local).await.ok()
    } else {
        None
    };
    let shown = target.as_ref().unwrap_or(&entry);

    Ok(FileMetadata {
        is_file: shown.is_file(),
        is_dir: shown.is_dir(),
        is_symlink,
        len: Some(shown.len()),
        path: path.to_path_buf(),
        modified: shown.modified().ok(),
        created: shown.created().ok(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use pi_rpc::transport::{Transport, TransportRecv};
    use tempfile::TempDir;

    use super::*;
    use crate::channel::Handle;
    use crate::host::fs::typed;

    fn host() -> LocalHost {
        LocalHost::new(&LocalDirs::default())
    }

    /// The typed path this test machine writes for one of its own paths.
    fn unix_path(path: &std::path::Path) -> typed_path::Utf8TypedPathBuf {
        crate::host::fs::typed(path.to_string_lossy(), OsFamily::Unix)
    }

    /// A machine with an empty directory on it, and a file in that directory.
    fn workspace() -> (TempDir, LocalHost) {
        (tempfile::tempdir().expect("a temporary directory"), host())
    }

    #[tokio::test]
    async fn a_file_reports_its_size_and_kind() {
        let (directory, host) = workspace();
        let path = directory.path().join("hello.txt");
        std::fs::write(&path, "hello").expect("the file lands");
        let path = unix_path(&path);

        let row = host
            .metadata(path.to_path())
            .await
            .expect("the file is read");

        assert!(row.is_file);
        assert!(!row.is_dir);
        assert!(!row.is_symlink);
        assert_eq!(row.len, Some(5));
        assert_eq!(row.path, path);
        assert!(row.modified.is_some());
    }

    #[tokio::test]
    async fn a_directory_reports_its_kind() {
        let (directory, host) = workspace();
        let path = unix_path(directory.path());

        let row = host
            .metadata(path.to_path())
            .await
            .expect("the directory is read");

        assert!(row.is_dir);
        assert!(!row.is_file);
    }

    #[tokio::test]
    async fn only_a_directory_is_a_directory() {
        let (directory, host) = workspace();
        let file = directory.path().join("file.txt");
        std::fs::write(&file, "").expect("the file lands");

        assert!(
            host.is_dir(unix_path(directory.path()).to_path())
                .await
                .expect("a directory")
        );
        assert!(
            !host
                .is_dir(unix_path(&file).to_path())
                .await
                .expect("a file")
        );
        assert!(
            !host
                .is_dir(unix_path(&directory.path().join("missing")).to_path())
                .await
                .expect("a missing path")
        );
    }

    #[tokio::test]
    async fn a_symlink_shows_its_target_and_names_itself_a_link() {
        let (directory, host) = workspace();
        let target = directory.path().join("target.txt");
        std::fs::write(&target, "hello").expect("the file lands");
        let link = directory.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).expect("the link lands");

        let row = host
            .metadata(unix_path(&link).to_path())
            .await
            .expect("the link is read");

        assert!(row.is_symlink);
        assert!(row.is_file);
        assert_eq!(row.len, Some(5));
    }

    #[tokio::test]
    async fn a_broken_symlink_is_still_a_row() {
        let (directory, host) = workspace();
        let link = directory.path().join("broken");
        std::os::unix::fs::symlink(directory.path().join("gone"), &link).expect("the link lands");

        let row = host
            .metadata(unix_path(&link).to_path())
            .await
            .expect("the link is read");

        assert!(row.is_symlink);
        assert!(!row.is_file);
        assert!(!row.is_dir);
    }

    #[tokio::test]
    async fn every_entry_of_a_directory_comes_back() {
        let (directory, host) = workspace();
        std::fs::write(directory.path().join("b.txt"), "").expect("the file lands");
        std::fs::write(directory.path().join("a.txt"), "").expect("the file lands");
        std::fs::create_dir(directory.path().join("sub")).expect("the directory lands");

        let rows = host
            .read_dir(unix_path(directory.path()).to_path())
            .await
            .expect("the directory is read");

        let mut names: Vec<String> = rows
            .iter()
            .map(|row| {
                row.path
                    .to_path()
                    .file_name()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect();
        names.sort();
        assert_eq!(names, ["a.txt", "b.txt", "sub"]);
        assert_eq!(rows.iter().filter(|row| row.is_dir).count(), 1);
    }

    #[tokio::test]
    async fn a_file_opened_for_writing_reads_back_its_bytes() {
        let (directory, host) = workspace();
        let path = unix_path(&directory.path().join("written.txt"));

        let mut options = FileOpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = host
            .open_file(path.to_path(), options)
            .await
            .expect("the file opens");
        tokio::io::AsyncWriteExt::write_all(&mut file, b"bytes")
            .await
            .expect("the bytes land");
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .expect("the bytes flush");
        drop(file);

        let bytes = host
            .read_bytes(path.to_path())
            .await
            .expect("the file is read");

        assert_eq!(&bytes[..], b"bytes");
    }

    #[tokio::test]
    async fn a_directory_comes_with_every_level() {
        let (directory, host) = workspace();
        let path = directory.path().join("one/two/three");

        host.create_dir_all(unix_path(&path).to_path())
            .await
            .expect("the levels land");

        assert!(path.is_dir());
    }

    #[tokio::test]
    async fn a_removed_file_is_gone() {
        let (directory, host) = workspace();
        let path = directory.path().join("gone.txt");
        std::fs::write(&path, "").expect("the file lands");

        host.remove(unix_path(&path).to_path())
            .await
            .expect("the file goes");

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn a_relative_path_is_refused_before_the_filesystem_sees_it() {
        let (_, host) = workspace();

        let error = host
            .read_bytes(Utf8TypedPath::derive("relative.txt"))
            .await
            .expect_err("a relative path names nothing");

        assert!(error.to_string().contains("is not absolute"), "{error}");
    }

    #[tokio::test]
    async fn a_command_reports_its_output_and_its_exit() {
        let (_, host) = workspace();
        let command = Command::new("sh")
            .with_arg("-c")
            .with_arg("printf out; printf err >&2; exit 3");

        let output = host.exec(command).await.expect("the command answers");

        assert_eq!(&output.stdout[..], b"out");
        assert_eq!(&output.stderr[..], b"err");
        assert_eq!(output.exit_status.code(), Some(3));
    }

    #[tokio::test]
    async fn a_command_starts_in_the_directory_it_is_given() {
        let (directory, host) = workspace();
        let command = Command::new("sh")
            .with_arg("-c")
            .with_arg("pwd")
            .with_cwd(directory.path().to_string_lossy().into_owned());

        let output = host.exec(command).await.expect("the command answers");

        let printed = String::from_utf8(output.stdout.to_vec()).expect("pwd prints text");
        assert_eq!(
            printed.trim(),
            directory.path().canonicalize().unwrap().to_string_lossy()
        );
    }

    #[tokio::test]
    async fn a_command_reads_the_environment_it_is_given() {
        let (_, host) = workspace();
        let command = Command::new("sh")
            .with_arg("-c")
            .with_arg("printf %s \"$PIE_TEST\"")
            .with_env("PIE_TEST", "a value");

        let output = host.exec(command).await.expect("the command answers");

        assert_eq!(&output.stdout[..], b"a value");
    }

    #[tokio::test]
    async fn a_started_program_hands_its_records_and_its_end_to_the_channel() {
        let (_, host) = workspace();
        let command = Command::new("sh")
            .with_arg("-c")
            .with_arg("printf 'one\\n'");

        let (channel, mut process) = host.spawn(command).await.expect("the program starts");
        let (_, mut receiver) = channel.split();

        let record = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("the channel answers in time")
            .expect("the channel takes the record");
        assert_eq!(record, Some("one".to_string()));

        let status = process.wait().await.expect("the program ends");
        assert!(status.is_success());
    }

    #[tokio::test]
    async fn the_bytes_of_a_staged_file_land_on_the_machine() {
        let (directory, host) = workspace();
        let path = unix_path(&directory.path().join("staged.txt"));
        let (report, progress) = watch::channel(0u64);

        host.write_from(path.to_path(), &b"bytes"[..], report)
            .await
            .expect("the file is staged");

        assert_eq!(*progress.borrow(), 5);
        assert_eq!(
            host.read_bytes(path.to_path())
                .await
                .expect("the file reads")[..],
            b"bytes"[..]
        );
    }

    #[tokio::test]
    async fn a_staged_file_replaces_what_was_there() {
        let (directory, host) = workspace();
        let local = directory.path().join("staged.txt");
        std::fs::write(&local, "far longer than what comes next").expect("the old file lands");
        let (report, _) = watch::channel(0u64);

        host.write_from(unix_path(&local).to_path(), &b"new"[..], report)
            .await
            .expect("the file is staged");

        assert_eq!(
            std::fs::read_to_string(&local).expect("the file reads"),
            "new"
        );
    }

    #[tokio::test]
    async fn an_empty_source_leaves_an_empty_file() {
        let (directory, host) = workspace();
        let path = unix_path(&directory.path().join("empty.txt"));
        let (report, progress) = watch::channel(0u64);

        host.write_from(path.to_path(), &b""[..], report)
            .await
            .expect("the file is staged");

        assert_eq!(*progress.borrow(), 0);
        assert_eq!(
            host.read_bytes(path.to_path())
                .await
                .expect("the file reads")
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn the_progress_of_a_staged_file_arrives_while_it_is_written() {
        let (directory, host) = workspace();
        let path = unix_path(&directory.path().join("large.bin"));
        let source = vec![b'a'; 4 * 64 * 1024];
        let (report, mut progress) = watch::channel(0u64);

        let watcher = tokio::spawn(async move {
            let mut seen = Vec::new();
            while progress.changed().await.is_ok() {
                seen.push(*progress.borrow());
            }
            seen
        });

        host.write_from(path.to_path(), &source[..], report)
            .await
            .expect("the file is staged");
        let seen = watcher.await.expect("the watcher lives");

        assert_eq!(
            seen.last(),
            Some(&(source.len() as u64)),
            "the last report is the whole file"
        );
        assert!(seen.len() >= 2, "the progress came in pieces: {seen:?}");
        assert!(
            seen.windows(2).all(|pair| pair[0] < pair[1]),
            "each report is further than the last: {seen:?}"
        );
    }
}
