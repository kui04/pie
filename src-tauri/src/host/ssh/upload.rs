//! Stateless, resumable, and deduplicating SFTP file uploader for an [`SshHost`].
//!
//! Deduplication and resume rely directly on the file's BLAKE3 digest embedded
//! in the remote filename and `.part` staging file, eliminating any shared
//! `.manifest.json` lock contention across concurrent sessions or processes.

use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::{Context as _, ensure};
use hostaddr::HostAddr;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Semaphore, watch};
use typed_path::{Utf8TypedPath, Utf8TypedPathBuf, Utf8UnixPath, Utf8UnixPathBuf};

use crate::host::executor::OsFamily;
use crate::host::fs::{UploadReceipt, UploadSource, UploadStatus, hashed_name, upload_digest};
use crate::host::ssh::{ClientHandler, SFTP_COPY_BUFFER, open_sftp_session, to_sftp_wire_path};

/// Maximum concurrent SFTP upload channels per SSH connection.
/// Stays safely below OpenSSH's default `MaxSessions 4`.
const MAX_UPLOAD_CONCURRENCY: usize = 4;

/// Trailing byte window (64 KiB) read back from an existing `.part` file
/// to verify its integrity against the local source before resuming.
const PART_VERIFY_WINDOW: u64 = 64 * 1024;

/// High-performance, cloneable SFTP file uploader tied to one [`SshHost`].
#[derive(Clone)]
pub struct Uploader {
    inner: Arc<UploaderInner>,
}

/// Shared state for an in-flight upload of a specific BLAKE3 hash.
struct InFlightUpload {
    tx: watch::Sender<Option<Result<UploadReceipt, String>>>,
}

/// Subscription held by a coalesced follower waiting on the leader.
enum FlightRole {
    Leader(LeaderGuard),
    Follower(watch::Receiver<Option<Result<UploadReceipt, String>>>),
}

/// RAII guard that removes the hash from `in_flight` and broadcasts an outcome
/// even if the leader returns early with `?`, panics, or has its future cancelled.
struct LeaderGuard {
    inner: Arc<UploaderInner>,
    hash: blake3::Hash,
    flight: Arc<InFlightUpload>,
    completed: bool,
}

impl LeaderGuard {
    fn complete(mut self, outcome: &anyhow::Result<UploadReceipt>) {
        self.completed = true;
        self.inner
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.hash);
        let shared = match outcome {
            Ok(receipt) => Ok(receipt.clone()),
            Err(err) => Err(format!("{err:#}")),
        };
        let _ = self.flight.tx.send_replace(Some(shared));
    }
}

impl Drop for LeaderGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.inner
                .in_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.hash);
            let _ = self.flight.tx.send_replace(Some(Err(
                "leader upload aborted before completion".to_owned(),
            )));
        }
    }
}

struct UploaderInner {
    handle: Arc<russh::client::Handle<ClientHandler>>,
    host: HostAddr<String>,
    family: OsFamily,
    target_dir: Utf8TypedPathBuf,
    staging_dir: Utf8TypedPathBuf,
    concurrency: Arc<Semaphore>,
    idle_sessions: Mutex<Vec<SftpSession>>,
    /// Singleflight coalescing map for concurrent uploads of identical content.
    in_flight: Mutex<HashMap<blake3::Hash, Arc<InFlightUpload>>>,
    /// Remote directories already verified or created during this connection.
    initialized_dirs: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for Uploader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Uploader")
            .field("host", &self.inner.host)
            .field("family", &self.inner.family)
            .field("target_dir", &self.inner.target_dir)
            .finish()
    }
}

impl Uploader {
    /// Creates an [`Uploader`] rooted at `target_dir` on `host`.
    pub(crate) fn new(
        handle: Arc<russh::client::Handle<ClientHandler>>,
        target_dir: Utf8TypedPath<'_>,
        family: OsFamily,
        host: HostAddr<String>,
    ) -> Self {
        let target_dir = target_dir.to_path_buf();
        let staging_dir = target_dir.join(".staging");

        Self {
            inner: Arc::new(UploaderInner {
                handle,
                host,
                family,
                target_dir,
                staging_dir,
                concurrency: Arc::new(Semaphore::new(MAX_UPLOAD_CONCURRENCY)),
                idle_sessions: Mutex::new(Vec::with_capacity(MAX_UPLOAD_CONCURRENCY)),
                in_flight: Mutex::new(HashMap::new()),
                initialized_dirs: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// Uploads `source` into the remote cache directory, emitting cumulative bytes
    /// ready on `progress`, and returns the [`UploadReceipt`].
    pub async fn upload(
        &self,
        source: UploadSource,
        progress: watch::Sender<u64>,
    ) -> anyhow::Result<UploadReceipt> {
        let rel_unix = extract_safe_relative_path(&source)?;
        let (hash, total_bytes) = upload_digest(&source).await?;

        // Singleflight guard: coalesce concurrent in-process uploads of identical content.
        // Followers subscribe to the `watch` channel while holding the mutex so they can
        // never miss a leader that finishes immediately after releasing the lock.
        let role = {
            let mut in_flight = self
                .inner
                .in_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(existing) = in_flight.get(&hash) {
                FlightRole::Follower(existing.tx.subscribe())
            } else {
                let (tx, _) = watch::channel(None);
                let flight = Arc::new(InFlightUpload { tx });
                in_flight.insert(hash, Arc::clone(&flight));
                FlightRole::Leader(LeaderGuard {
                    inner: Arc::clone(&self.inner),
                    hash,
                    flight,
                    completed: false,
                })
            }
        };

        let leader_guard = match role {
            FlightRole::Leader(guard) => guard,
            FlightRole::Follower(mut rx) => {
                // Wait for the leader to publish its result.
                if let Ok(borrowed) = rx.wait_for(Option::is_some).await
                    && let Some(Ok(leader_receipt)) = borrowed.as_ref()
                {
                    progress.send_replace(total_bytes);
                    return Ok(UploadReceipt {
                        hash: leader_receipt.hash,
                        remote_path: leader_receipt.remote_path.clone(),
                        total_bytes: leader_receipt.total_bytes,
                        bytes_transferred: 0,
                        status: UploadStatus::SkippedDuplicate {
                            existing_remote_path: leader_receipt.remote_path.clone(),
                        },
                    });
                }
                // If the leader failed or was cancelled, fall through and retry via a fresh call.
                return Box::pin(self.upload(source, progress)).await;
            }
        };

        let _permit = self
            .inner
            .concurrency
            .acquire()
            .await
            .context("uploader concurrency semaphore closed")?;

        let sftp = self.acquire_sftp().await?;
        let outcome = self
            .execute_transfer(&sftp, &source, &rel_unix, hash, total_bytes, &progress)
            .await;

        if outcome.is_ok() {
            self.release_sftp(sftp);
        }

        leader_guard.complete(&outcome);

        outcome
    }

    async fn acquire_sftp(&self) -> anyhow::Result<SftpSession> {
        let candidate = self
            .inner
            .idle_sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop();

        if let Some(session) = candidate
            && session.try_exists(".").await.is_ok()
        {
            return Ok(session);
        }
        open_sftp_session(&self.inner.handle, &self.inner.host).await
    }

    fn release_sftp(&self, session: SftpSession) {
        let mut pool = self
            .inner
            .idle_sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if pool.len() < MAX_UPLOAD_CONCURRENCY {
            pool.push(session);
        }
    }

    async fn execute_transfer(
        &self,
        sftp: &SftpSession,
        source: &UploadSource,
        rel_unix: &Utf8UnixPath,
        hash: blake3::Hash,
        total_bytes: u64,
        progress: &watch::Sender<u64>,
    ) -> anyhow::Result<UploadReceipt> {
        self.ensure_remote_dir(sftp, self.inner.target_dir.to_path())
            .await?;
        self.ensure_remote_dir(sftp, self.inner.staging_dir.to_path())
            .await?;

        let file_name = rel_unix.file_name().unwrap_or("upload.bin");
        let hashed_file_name = hashed_name(file_name, &hash);
        let final_remote_path = self.inner.target_dir.join(&hashed_file_name);
        let final_wire_path = to_sftp_wire_path(final_remote_path.to_path());

        // Fast-path stateless deduplication: if the target file bearing this BLAKE3
        // hash already exists on the remote host with the exact byte length, skip transfer.
        if let Ok(meta) = sftp.metadata(&final_wire_path).await
            && meta.is_regular()
            && meta.len() == total_bytes
        {
            progress.send_replace(total_bytes);
            tracing::info!(
                host = %self.inner.host,
                file = rel_unix.as_str(),
                %hash,
                existing = %final_remote_path,
                "skipped duplicate SFTP upload"
            );
            return Ok(UploadReceipt {
                hash,
                remote_path: final_remote_path.clone(),
                total_bytes,
                bytes_transferred: 0,
                status: UploadStatus::SkippedDuplicate {
                    existing_remote_path: final_remote_path,
                },
            });
        }

        // Staging `.part` path also carries the full BLAKE3 hash at the end.
        let part_remote_path = self
            .inner
            .staging_dir
            .join(format!("{file_name}.{}.part", hash.to_hex()));
        let part_wire_path = to_sftp_wire_path(part_remote_path.to_path());

        // Check for an existing partial upload to resume from.
        let mut resume_offset = 0u64;
        if let Ok(meta) = sftp.metadata(&part_wire_path).await {
            let existing_len = meta.len();
            if existing_len > 0 && existing_len <= total_bytes {
                let verified = if existing_len == total_bytes && existing_len > PART_VERIFY_WINDOW {
                    verify_part_full(sftp, &part_wire_path, hash).await
                } else {
                    verify_part_tail(sftp, &part_wire_path, source, existing_len).await
                };
                match verified {
                    Ok(true) if existing_len == total_bytes => {
                        self.atomic_replace(sftp, &part_wire_path, &final_wire_path)
                            .await?;
                        progress.send_replace(total_bytes);
                        return Ok(UploadReceipt {
                            hash,
                            remote_path: final_remote_path,
                            total_bytes,
                            bytes_transferred: 0,
                            status: UploadStatus::Resumed {
                                offset: total_bytes,
                            },
                        });
                    }
                    Ok(true) => {
                        resume_offset = existing_len;
                    }
                    Ok(false) => {
                        tracing::warn!(
                            host = %self.inner.host,
                            part = %part_remote_path,
                            existing_len,
                            "corrupt .part file detected; restarting upload from byte 0"
                        );
                    }
                    Err(err) => {
                        tracing::debug!(
                            host = %self.inner.host,
                            part = %part_remote_path,
                            %err,
                            "failed to verify .part file; restarting upload from byte 0"
                        );
                    }
                }
            }
        }

        let flags = if resume_offset > 0 {
            OpenFlags::CREATE | OpenFlags::WRITE
        } else {
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
        };

        let mut remote_file = sftp
            .open_with_flags(&part_wire_path, flags)
            .await
            .with_context(|| {
                format!(
                    "cannot open staging file `{part_remote_path}` on `{}`",
                    self.inner.host
                )
            })?;

        if resume_offset > 0 {
            remote_file
                .seek(SeekFrom::Start(resume_offset))
                .await
                .with_context(|| {
                    format!(
                        "cannot seek staging file `{part_remote_path}` on `{}`",
                        self.inner.host
                    )
                })?;
            progress.send_replace(resume_offset);
        }

        let (bytes_transferred, source_intact) = match source {
            UploadSource::Local { path } => {
                let mut local_file = tokio::fs::File::open(path.as_std_path())
                    .await
                    .with_context(|| format!("cannot open local file `{path}`"))?;
                let mut hasher = blake3::Hasher::new();
                if resume_offset > 0 {
                    hash_local_prefix(&mut local_file, resume_offset, &mut hasher).await?;
                }
                let transferred = stream_chunks(
                    &mut local_file,
                    &mut remote_file,
                    resume_offset,
                    total_bytes,
                    Some(&mut hasher),
                    progress,
                )
                .await?;
                (transferred, hasher.finalize() == hash)
            }
            UploadSource::InMemory { content, .. } => {
                let start = usize::try_from(resume_offset).unwrap_or(content.len());
                let mut slice = &content[start.min(content.len())..];
                let transferred = stream_chunks(
                    &mut slice,
                    &mut remote_file,
                    resume_offset,
                    total_bytes,
                    None,
                    progress,
                )
                .await?;
                (transferred, true)
            }
        };

        remote_file.flush().await.with_context(|| {
            format!("cannot flush `{part_remote_path}` on `{}`", self.inner.host)
        })?;
        remote_file.shutdown().await.with_context(|| {
            format!("cannot close `{part_remote_path}` on `{}`", self.inner.host)
        })?;
        drop(remote_file);

        let final_offset = resume_offset + bytes_transferred;
        if final_offset != total_bytes || !source_intact {
            let _ = sftp.remove_file(&part_wire_path).await;
            anyhow::bail!(
                "the source of the upload to `{}` changed after it was hashed; the transfer stopped",
                self.inner.host
            );
        }

        self.atomic_replace(sftp, &part_wire_path, &final_wire_path)
            .await?;

        let status = if resume_offset > 0 {
            UploadStatus::Resumed {
                offset: resume_offset,
            }
        } else {
            UploadStatus::UploadedFresh
        };

        Ok(UploadReceipt {
            hash,
            remote_path: final_remote_path,
            total_bytes,
            bytes_transferred,
            status,
        })
    }

    async fn ensure_remote_dir(
        &self,
        sftp: &SftpSession,
        dir: Utf8TypedPath<'_>,
    ) -> anyhow::Result<()> {
        let mut ancestors: Vec<Utf8TypedPath<'_>> =
            dir.ancestors().filter(|a| !a.as_str().is_empty()).collect();
        ancestors.reverse();

        for level in ancestors {
            let wire = to_sftp_wire_path(level);
            if self
                .inner
                .initialized_dirs
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(&wire)
            {
                continue;
            }
            if !sftp.try_exists(&wire).await.unwrap_or(false)
                && let Err(error) = sftp.create_dir(&wire).await
                && !sftp.try_exists(&wire).await.unwrap_or(false)
            {
                return Err(error)
                    .with_context(|| format!("cannot create `{level}` on `{}`", self.inner.host));
            }
            self.inner
                .initialized_dirs
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(wire);
        }
        Ok(())
    }

    async fn atomic_replace(
        &self,
        sftp: &SftpSession,
        src_wire: &str,
        dst_wire: &str,
    ) -> anyhow::Result<()> {
        if sftp.rename(src_wire, dst_wire).await.is_ok() {
            return Ok(());
        }
        if sftp.try_exists(dst_wire).await.unwrap_or(false) {
            let _ = sftp.remove_file(dst_wire).await;
        }
        sftp.rename(src_wire, dst_wire).await.with_context(|| {
            format!(
                "failed to rename `{src_wire}` to `{dst_wire}` on `{}`",
                self.inner.host
            )
        })
    }
}

/// Streams from `reader` into `remote_file` in 256 KiB chunks while updating `progress`.
///
/// Stops before it writes the chunk that would pass `total_bytes`; that chunk still counts in
/// the returned length, so the caller sees the excess. Every byte sent also goes into `hasher`.
async fn stream_chunks<R>(
    reader: &mut R,
    remote_file: &mut russh_sftp::client::fs::File,
    initial_offset: u64,
    total_bytes: u64,
    mut hasher: Option<&mut blake3::Hasher>,
    progress: &watch::Sender<u64>,
) -> anyhow::Result<u64>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = vec![0u8; SFTP_COPY_BUFFER].into_boxed_slice();
    let mut transferred = 0u64;

    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .context("failed to read upload source")?;
        if read == 0 {
            break;
        }
        transferred += read as u64;
        if initial_offset + transferred > total_bytes {
            break;
        }
        if let Some(hasher) = hasher.as_deref_mut() {
            hasher.update(&buffer[..read]);
        }
        remote_file
            .write_all(&buffer[..read])
            .await
            .context("failed to write chunk to SFTP")?;
        progress.send_replace(initial_offset + transferred);
    }

    Ok(transferred)
}

/// Feeds the first `len` bytes of `file` into `hasher`, leaving `file` positioned at `len`.
/// A shorter file leaves the hash wrong, which the caller finds at the end of the transfer.
async fn hash_local_prefix(
    file: &mut tokio::fs::File,
    len: u64,
    hasher: &mut blake3::Hasher,
) -> anyhow::Result<()> {
    let mut prefix = file.take(len);
    let mut buffer = vec![0u8; SFTP_COPY_BUFFER].into_boxed_slice();
    loop {
        let read = prefix
            .read(&mut buffer)
            .await
            .context("failed to read the local file for resume")?;
        if read == 0 {
            return Ok(());
        }
        hasher.update(&buffer[..read]);
    }
}

/// Extracts and validates the relative POSIX file name from [`UploadSource`].
fn extract_safe_relative_path(source: &UploadSource) -> anyhow::Result<Utf8UnixPathBuf> {
    match source {
        UploadSource::Local { path } => {
            let file_name = path
                .file_name()
                .with_context(|| format!("local path `{path}` has no file name"))?;
            sanitize_relative_unix_path(file_name)
        }
        UploadSource::InMemory { name, .. } => sanitize_relative_unix_path(name),
    }
}

/// Normalizes `raw` into a safe relative [`Utf8UnixPathBuf`] and verifies via `join_checked`
/// that it cannot traverse outside the target root directory.
pub(crate) fn sanitize_relative_unix_path(raw: &str) -> anyhow::Result<Utf8UnixPathBuf> {
    let trimmed = raw.trim();
    ensure!(
        !trimmed.is_empty() && !trimmed.contains('\0'),
        "invalid upload file name `{raw}`"
    );

    let Utf8TypedPathBuf::Unix(unix_candidate) =
        Utf8TypedPath::derive(trimmed).with_unix_encoding()
    else {
        unreachable!("`with_unix_encoding` always yields a Unix path");
    };

    ensure!(
        !unix_candidate.is_absolute(),
        "upload path `{raw}` must be relative"
    );

    let _verified = Utf8UnixPath::new("/root")
        .join_checked(&unix_candidate)
        .with_context(|| format!("path traversal refused in `{raw}`"))?;
    let normalized = unix_candidate.normalize();

    ensure!(
        !normalized.as_str().is_empty() && normalized.as_str() != ".",
        "invalid upload file name `{raw}`"
    );
    Ok(normalized)
}

/// Verifies that a complete `.part` file on the remote server matches `expected` across all bytes.
async fn verify_part_full(
    sftp: &SftpSession,
    part_wire_path: &str,
    expected: blake3::Hash,
) -> anyhow::Result<bool> {
    let mut remote_part = sftp.open(part_wire_path).await?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; SFTP_COPY_BUFFER];
    loop {
        let n = remote_part.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize() == expected)
}

/// Verifies that an existing `.part` file on the remote server matches the local `source`
/// by comparing the BLAKE3 digest of its trailing [`PART_VERIFY_WINDOW`] bytes (up to 64 KiB).
async fn verify_part_tail(
    sftp: &SftpSession,
    part_wire_path: &str,
    source: &UploadSource,
    existing_len: u64,
) -> anyhow::Result<bool> {
    let window = existing_len.min(PART_VERIFY_WINDOW);
    let offset = existing_len - window;
    let len_usize = usize::try_from(window).context("invalid verify window")?;

    let mut remote_part = sftp.open(part_wire_path).await?;
    if offset > 0 {
        remote_part.seek(SeekFrom::Start(offset)).await?;
    }
    let mut remote_buf = vec![0u8; len_usize];
    remote_part.read_exact(&mut remote_buf).await?;
    let remote_tail_hash = blake3::hash(&remote_buf);

    let local_tail_hash = match source {
        UploadSource::Local { path } => {
            let mut local_file = tokio::fs::File::open(path.as_std_path()).await?;
            if offset > 0 {
                local_file.seek(SeekFrom::Start(offset)).await?;
            }
            let mut local_buf = vec![0u8; len_usize];
            local_file.read_exact(&mut local_buf).await?;
            blake3::hash(&local_buf)
        }
        UploadSource::InMemory { content, .. } => {
            let start = usize::try_from(offset)?;
            let end = start + len_usize;
            if end > content.len() {
                return Ok(false);
            }
            blake3::hash(&content[start..end])
        }
    };

    Ok(remote_tail_hash == local_tail_hash)
}

#[cfg(test)]
mod tests {
    use camino::Utf8PathBuf;

    use super::*;

    #[test]
    fn a_plain_file_name_is_accepted() {
        let clean = sanitize_relative_unix_path("report.pdf").expect("valid file name");
        assert_eq!(clean.as_str(), "report.pdf");
    }

    #[test]
    fn parent_directory_traversal_is_refused() {
        assert!(sanitize_relative_unix_path("../secret.txt").is_err());
        assert!(sanitize_relative_unix_path("sub/../../secret.txt").is_err());
    }

    #[test]
    fn an_absolute_path_is_refused() {
        assert!(sanitize_relative_unix_path("/etc/passwd").is_err());
        assert!(sanitize_relative_unix_path("C:\\Windows\\System32").is_err());
    }

    #[test]
    fn a_nested_relative_name_is_accepted_and_normalized() {
        assert_eq!(
            sanitize_relative_unix_path("dir/report.pdf")
                .expect("a nested name")
                .as_str(),
            "dir/report.pdf"
        );
        assert_eq!(
            sanitize_relative_unix_path("a//b.png")
                .expect("repeated separators")
                .as_str(),
            "a/b.png"
        );
        assert_eq!(
            sanitize_relative_unix_path("./x.png")
                .expect("a current component")
                .as_str(),
            "x.png"
        );
    }

    #[test]
    fn a_name_that_could_leave_the_upload_directory_is_refused() {
        for raw in [
            "../secret.txt",
            "a/../../secret.txt",
            "/etc/passwd",
            r"C:\Windows\System32",
            "C:/Windows",
            r"\\server\share",
        ] {
            assert!(
                sanitize_relative_unix_path(raw).is_err(),
                "`{raw}` names no file inside the upload directory"
            );
        }
    }

    #[test]
    fn an_empty_or_corrupt_name_is_refused() {
        for raw in ["", "   ", ".", "a\0b"] {
            assert!(
                sanitize_relative_unix_path(raw).is_err(),
                "`{raw}` names no file pie can stage"
            );
        }
    }

    #[test]
    fn a_local_source_stages_under_its_file_name() {
        let source = UploadSource::Local {
            path: Utf8PathBuf::from("/tmp/dir/report.pdf"),
        };
        assert_eq!(
            extract_safe_relative_path(&source)
                .expect("a file name")
                .as_str(),
            "report.pdf"
        );

        let source = UploadSource::Local {
            path: Utf8PathBuf::from("/tmp/dir/.."),
        };
        let error = extract_safe_relative_path(&source).expect_err("no file name");
        assert!(error.to_string().contains("has no file name"), "{error}");
    }

    #[test]
    fn an_in_memory_source_keeps_the_name_it_carries() {
        let source = UploadSource::InMemory {
            name: "note.txt".to_owned(),
            content: bytes::Bytes::from_static(b"hi"),
        };
        assert_eq!(
            extract_safe_relative_path(&source)
                .expect("a file name")
                .as_str(),
            "note.txt"
        );

        let source = UploadSource::InMemory {
            name: "../note.txt".to_owned(),
            content: bytes::Bytes::from_static(b"hi"),
        };
        assert!(extract_safe_relative_path(&source).is_err());
    }
}
