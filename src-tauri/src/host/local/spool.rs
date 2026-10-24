//! Spooling in-memory attachments into the device cache directory.

use std::io::Write as _;

use anyhow::Context as _;
use camino::{Utf8Path, Utf8PathBuf};

use crate::host::files;

/// Writes `bytes` into `dir` under a content-addressed staged name.
///
/// If a file with the same name and size already exists in `dir`, it is reused
/// directly without rewriting.
pub async fn spool(dir: &Utf8Path, name: &str, ext: &str, bytes: &[u8]) -> anyhow::Result<Utf8PathBuf> {
    let digest = files::digest_bytes(bytes);
    let file_name = files::staged_name(&digest, name, ext);
    let target_path = dir.join(&file_name);

    if let Ok(metadata) = tokio::fs::metadata(&target_path).await
        && metadata.len() == bytes.len() as u64
    {
        tracing::debug!(path = %target_path, size = bytes.len(), "reusing existing spooled attachment");
        return Ok(target_path);
    }

    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("cannot create directory `{dir}`"))?;

    let dir_buf = dir.to_path_buf().into_std_path_buf();
    let target_buf = target_path.to_path_buf().into_std_path_buf();
    let payload = bytes.to_vec();

    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let mut temp = tempfile::Builder::new()
            .prefix(".spool-")
            .tempfile_in(&dir_buf)
            .with_context(|| format!("cannot create temporary file in `{}`", dir_buf.display()))?;

        temp.write_all(&payload)
            .with_context(|| "cannot write payload to temporary file")?;
        temp.flush().with_context(|| "cannot flush temporary file")?;

        match temp.persist(&target_buf) {
            Ok(_) => Ok(()),
            Err(persist_err) => {
                if target_buf.exists() {
                    let len = std::fs::metadata(&target_buf).map(|m| m.len()).unwrap_or(0);
                    if len == payload.len() as u64 {
                        return Ok(());
                    }
                }
                Err(persist_err.error).with_context(|| format!("cannot persist file to `{}`", target_buf.display()))
            }
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("spool task panicked: {e}"))??;

    tracing::debug!(path = %target_path, size = bytes.len(), "spooled attachment payload to disk");
    Ok(target_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spool_writes_and_reuses_existing_content() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dir = Utf8Path::from_path(temp.path()).expect("utf8 path");
        let bytes = b"sample test payload for spooling";

        let path1 = spool(dir, "doc", "txt", bytes).await.expect("first spool");
        assert!(path1.exists());
        assert_eq!(std::fs::read(&path1).expect("read"), bytes);

        let metadata_before = std::fs::metadata(&path1).expect("metadata before");
        let path2 = spool(dir, "doc", "txt", bytes).await.expect("second spool");
        assert_eq!(path1, path2);

        let metadata_after = std::fs::metadata(&path2).expect("metadata after");
        assert_eq!(metadata_before.modified().unwrap(), metadata_after.modified().unwrap());
    }

    #[tokio::test]
    async fn spool_different_bytes_yield_different_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dir = Utf8Path::from_path(temp.path()).expect("utf8 path");

        let path1 = spool(dir, "file", "txt", b"content 1").await.expect("spool 1");
        let path2 = spool(dir, "file", "txt", b"content 2").await.expect("spool 2");

        assert_ne!(path1, path2);
    }
}
