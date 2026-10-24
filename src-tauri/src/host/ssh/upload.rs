//! Streaming, resumable, content-addressed SFTP file uploader.

use std::{
    collections::HashMap,
    io::SeekFrom,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

use anyhow::Context as _;
use camino::Utf8Path;
use russh_sftp::client::SftpSession;
use tokio::{
    io::{AsyncReadExt as _, AsyncSeekExt as _, AsyncWriteExt as _},
    sync::watch,
};

use super::{SshHost, files::is_no_such_file};
use crate::host::files as host_files;

/// Buffer size for streaming SFTP writes (256 KiB).
///
/// 256 KiB balances network throughput over wide-area links against per-transfer
/// buffer memory. Standard OpenSSH SFTP clients use 256 KiB pipelined requests.
const CHUNK_SIZE: usize = 256 * 1024;

/// Throttle interval between progress notifications.
///
/// 100 ms bounds progress events to at most 10 IPC updates per second, keeping
/// the frontend render thread responsive without visual stutter.
const REPORT_EVERY: Duration = Duration::from_millis(100);

/// Throttle share: one report per 1/20th of the file during fast transfers.
///
/// Guarantees at most 20 progress updates for rapid transfers over high-speed links.
const REPORT_SHARE: u64 = 20;

/// Map of active uploads to coalesce concurrent identical transfers into one leader.
pub(super) type InFlightMap = Mutex<HashMap<String, watch::Receiver<Option<Result<String, String>>>>>;

/// Creates an empty in-flight singleflight map.
pub(super) fn new_in_flight() -> InFlightMap {
    Mutex::new(HashMap::new())
}

/// RAII guard that removes an in-flight upload key if the upload drops or is cancelled.
struct FlightGuard<'a> {
    in_flight: &'a InFlightMap,
    key: &'a str,
}

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        let mut map = self.in_flight.lock().unwrap_or_else(PoisonError::into_inner);
        map.remove(self.key);
    }
}

/// Throttles progress notifications to avoid flooding IPC and UI renders.
#[derive(Debug)]
struct ProgressThrottle {
    total: u64,
    share: u64,
    reported: u64,
    reported_at: Instant,
}

impl ProgressThrottle {
    fn new(start: u64, total: u64) -> Self {
        Self {
            total,
            share: (total / REPORT_SHARE).max(1),
            reported: start,
            reported_at: Instant::now(),
        }
    }

    fn should_report(&mut self, transferred: u64) -> bool {
        if transferred == self.total
            || self.reported_at.elapsed() >= REPORT_EVERY
            || transferred.saturating_sub(self.reported) >= self.share
        {
            self.reported = transferred;
            self.reported_at = Instant::now();
            true
        } else {
            false
        }
    }
}

/// Checks whether a completed target file exists on the remote SFTP server with matching size.
pub(super) async fn landed(sftp: &SftpSession, path: &str, size: u64) -> anyhow::Result<bool> {
    match sftp.metadata(path).await {
        Ok(meta) => Ok(meta.len() == size),
        Err(e) if is_no_such_file(&e) => Ok(false),
        Err(e) => Err(e).with_context(|| format!("cannot inspect remote path `{path}`")),
    }
}

/// Safely moves a completed part file to the final destination, falling back if already landed.
async fn finish_part(sftp: &SftpSession, part: &str, target_path: &str, total_size: u64) -> anyhow::Result<()> {
    match sftp.rename(part, target_path).await {
        Ok(_) => Ok(()),
        Err(err) => {
            if landed(sftp, target_path, total_size).await? {
                tracing::debug!(target = %target_path, "target file already landed, removing temporary part file");
                let _ = sftp.remove_file(part).await;
                Ok(())
            } else {
                Err(err).with_context(|| format!("cannot rename `{part}` to `{target_path}`"))
            }
        }
    }
}

#[derive(Debug)]
struct UploadTarget<'a> {
    dir: &'a str,
    path: &'a str,
    staged_name: &'a str,
    total_size: u64,
}

/// Uploads `source` to `target_dir` over SFTP with singleflight coalescing and breakpoint resumption.
pub(super) async fn upload(
    host: &SshHost,
    sftp: &SftpSession,
    target_dir: &str,
    source: &Utf8Path,
    name: &str,
    ext: &str,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> anyhow::Result<String> {
    let (digest, total_size) = host_files::digest_file(source).await?;
    let staged_file_name = host_files::staged_name(&digest, name, ext);
    let target = format!("{target_dir}/{staged_file_name}");

    if landed(sftp, &target, total_size).await? {
        tracing::debug!(
            endpoint = %host.endpoint(),
            path = %target,
            size = total_size,
            "attachment already landed on remote host"
        );
        on_progress(total_size, total_size);
        return Ok(target);
    }

    let flight_key = target.clone();
    let (leader_tx, follower_rx) = {
        let mut map = host.in_flight.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(existing_rx) = map.get(&flight_key) {
            (None, Some(existing_rx.clone()))
        } else {
            let (tx, rx) = watch::channel(None);
            map.insert(flight_key.clone(), rx);
            (Some(tx), None)
        }
    };

    if let Some(mut rx) = follower_rx {
        tracing::debug!(
            endpoint = %host.endpoint(),
            target = %target,
            "coalescing upload onto in-flight leader"
        );
        rx.wait_for(|state| state.is_some())
            .await
            .map_err(|_| anyhow::anyhow!("upload task dropped before completing"))?;
        let result = rx
            .borrow()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("missing in-flight upload result"))?;
        match result {
            Ok(remote_path) => {
                on_progress(total_size, total_size);
                return Ok(remote_path);
            }
            Err(error_msg) => anyhow::bail!("{error_msg}"),
        }
    }

    tracing::info!(
        endpoint = %host.endpoint(),
        source = %source,
        target = %target,
        size = total_size,
        "beginning sftp upload"
    );

    let target_spec = UploadTarget {
        dir: target_dir,
        path: &target,
        staged_name: &staged_file_name,
        total_size,
    };

    let leader_tx = leader_tx.expect("leader must hold transmission channel");
    let _guard = FlightGuard {
        in_flight: &host.in_flight,
        key: &flight_key,
    };

    let result = transfer(host, sftp, &target_spec, source, on_progress).await;

    let outcome = result.as_ref().map(|path| path.clone()).map_err(|e| e.to_string());
    let _ = leader_tx.send(Some(outcome));
    drop(_guard);

    result
}

async fn transfer(
    host: &SshHost,
    sftp: &SftpSession,
    target: &UploadTarget<'_>,
    source: &Utf8Path,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> anyhow::Result<String> {
    super::files::create_dir_all(sftp, target.dir).await?;

    let part = format!("{}/.{}.part", target.dir, target.staged_name);
    let mut resume_offset = 0u64;

    if let Ok(meta) = sftp.metadata(&part).await {
        let existing_len = meta.len();
        if existing_len <= target.total_size {
            resume_offset = existing_len;
            if resume_offset > 0 {
                tracing::info!(
                    endpoint = %host.endpoint(),
                    part = %part,
                    offset = resume_offset,
                    total = target.total_size,
                    "resuming sftp upload from existing part file"
                );
            }
        } else {
            tracing::warn!(
                endpoint = %host.endpoint(),
                part = %part,
                existing = existing_len,
                total = target.total_size,
                "removing invalid part file larger than source"
            );
            let _ = sftp.remove_file(&part).await;
        }
    }

    if resume_offset == target.total_size && target.total_size > 0 {
        finish_part(sftp, &part, target.path, target.total_size).await?;
        tracing::info!(
            endpoint = %host.endpoint(),
            target = %target.path,
            size = target.total_size,
            "promoted existing complete part file to target"
        );
        on_progress(target.total_size, target.total_size);
        return Ok(target.path.to_string());
    }

    let mut local_file = tokio::fs::File::open(source)
        .await
        .with_context(|| format!("cannot open source file `{source}`"))?;

    if resume_offset > 0 {
        local_file
            .seek(SeekFrom::Start(resume_offset))
            .await
            .with_context(|| format!("cannot seek source file to offset {resume_offset}"))?;
    }

    let flags = if resume_offset > 0 {
        russh_sftp::protocol::OpenFlags::CREATE | russh_sftp::protocol::OpenFlags::WRITE
    } else {
        russh_sftp::protocol::OpenFlags::CREATE
            | russh_sftp::protocol::OpenFlags::WRITE
            | russh_sftp::protocol::OpenFlags::TRUNCATE
    };

    let mut remote_file = sftp
        .open_with_flags(&part, flags)
        .await
        .with_context(|| format!("cannot open remote part file `{part}`"))?;

    if resume_offset > 0 {
        remote_file
            .seek(SeekFrom::Start(resume_offset))
            .await
            .with_context(|| format!("cannot seek remote part file `{part}` to {resume_offset}"))?;
    }

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut transferred = resume_offset;
    let mut throttle = ProgressThrottle::new(transferred, target.total_size);

    on_progress(transferred, target.total_size);

    loop {
        let bytes_read = local_file
            .read(&mut buffer)
            .await
            .with_context(|| format!("cannot read from `{source}`"))?;
        if bytes_read == 0 {
            break;
        }

        remote_file
            .write_all(&buffer[..bytes_read])
            .await
            .with_context(|| format!("cannot write to `{part}`"))?;

        transferred += bytes_read as u64;
        if throttle.should_report(transferred) {
            on_progress(transferred, target.total_size);
        }
    }

    remote_file
        .flush()
        .await
        .with_context(|| format!("cannot flush `{part}`"))?;
    remote_file
        .shutdown()
        .await
        .with_context(|| format!("cannot close `{part}`"))?;
    drop(remote_file);

    if transferred != target.total_size {
        anyhow::bail!(
            "file changed during upload: expected {} bytes, transferred {transferred} bytes",
            target.total_size
        );
    }

    finish_part(sftp, &part, target.path, target.total_size).await?;
    tracing::info!(
        endpoint = %host.endpoint(),
        target = %target.path,
        size = target.total_size,
        "sftp upload completed successfully"
    );
    on_progress(target.total_size, target.total_size);
    Ok(target.path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flight_guard_removes_key_on_drop() {
        let map = new_in_flight();
        let key = "flight_test_key";
        {
            let (tx, rx) = watch::channel(None);
            map.lock().unwrap().insert(key.to_string(), rx);
            let _guard = FlightGuard { in_flight: &map, key };
            assert!(map.lock().unwrap().contains_key(key));
            drop(tx);
        }
        assert!(!map.lock().unwrap().contains_key(key));
    }
}
