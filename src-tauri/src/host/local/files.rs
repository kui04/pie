//! Local filesystem operations for [`LocalHost`](super::LocalHost).

use anyhow::Context as _;
use camino::{Utf8Path, Utf8PathBuf};

use crate::host::checked_host_path;
use crate::host::files::{DirEntry, Listing, clean_extension, clean_stem, not_absolute, sort_dirs_first};

/// One directory level of this machine.
///
/// The paths are absolute and belong to the machine. `path` is `None` for the
/// home directory of the connection, which the caller resolved long before this
/// point.
///
/// # Errors
///
/// A sentence when `path` is `None` and this machine has no home directory, when
/// the path is relative, and when the directory cannot be read.
pub(super) async fn dirs(home: Option<&Utf8Path>, path: Option<&str>) -> anyhow::Result<Listing> {
    let path = start(home, path)?;
    let shown = path.as_str().to_string();
    let mut entries = tokio::fs::read_dir(&path)
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

/// Whether a path names a directory on this machine.
///
/// Missing names answer `false`; anything else that goes wrong is a failure.
///
/// # Errors
///
/// A sentence when the path is relative, and one when the answer cannot be told.
pub(super) async fn dir_exists(path: &str) -> anyhow::Result<bool> {
    if !Utf8Path::new(path).is_absolute() {
        return Err(not_absolute(path));
    }
    match tokio::fs::metadata(path).await {
        Ok(target) => Ok(target.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("cannot read {path}")),
    }
}

/// Makes a directory on this machine, with parents as needed.
///
/// The picker offers this when the typed path names nothing: the confirm names
/// the path, and this makes it.
///
/// # Errors
///
/// A sentence when the path is relative, and one when the directory cannot be
/// made.
pub(super) async fn create_dir(path: &str) -> anyhow::Result<()> {
    if !Utf8Path::new(path).is_absolute() {
        return Err(not_absolute(path));
    }
    tokio::fs::create_dir_all(path)
        .await
        .with_context(|| format!("cannot make {path}"))
}

/// Removes one file on this machine.
///
/// # Errors
///
/// A sentence when the path is relative, and one when the file cannot be
/// removed.
pub(super) async fn remove_file(path: &str) -> anyhow::Result<()> {
    let path = checked_host_path(path)?;
    tokio::fs::remove_file(path)
        .await
        .with_context(|| format!("cannot remove {path}"))
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
/// A sentence when the directory refuses a file, or when the write of it fails.
pub(super) async fn stage(stem_hint: &str, ext_hint: &str, bytes: &[u8]) -> anyhow::Result<String> {
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

/// The directory of this machine that a read was asked about: `None` is the home.
fn start(home: Option<&Utf8Path>, path: Option<&str>) -> anyhow::Result<Utf8PathBuf> {
    match path {
        None => home
            .map(Utf8Path::to_path_buf)
            .context("there is no home directory on this machine to browse"),
        Some(path) if Utf8Path::new(path).is_absolute() => Ok(Utf8PathBuf::from(path)),
        Some(path) => Err(not_absolute(path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_local_rows_put_directories_first_and_carry_full_paths() {
        let directory = tempfile::tempdir().expect("a temp directory");
        std::fs::create_dir(directory.path().join("b-dir")).expect("the directory");
        std::fs::create_dir(directory.path().join("a-dir")).expect("the directory");
        std::fs::write(directory.path().join("z-file"), "").expect("the file");

        let listing = dirs(None, Some(directory.path().to_str().expect("utf-8")))
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

        let rows = dirs(None, Some(directory.path().to_str().expect("utf-8")))
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

        let rows = dirs(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing")
            .entries;

        let stale = rows.iter().find(|row| row.name == "stale").expect("the link is listed");
        assert!(!stale.is_dir, "a link that leads nowhere is not a walkable directory");
    }

    #[tokio::test]
    async fn the_picker_takes_no_relative_path() {
        for path in [".", "..", "sessions", "./sessions"] {
            let error = dirs(None, Some(path)).await.expect_err("`{path}` is relative");
            assert!(error.to_string().contains("is not absolute"), "got {error}");
        }
    }

    #[tokio::test]
    async fn the_local_make_builds_missing_parents() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let nested = directory.path().join("a/b");
        let missing = nested.to_str().expect("utf-8");

        create_dir(missing).await.expect("the making");

        assert!(nested.is_dir(), "the nested directory stands");
    }

    #[tokio::test]
    async fn the_local_make_leaves_what_exists_alone() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let start = directory.path().to_str().expect("utf-8");

        create_dir(start).await.expect("making what stands is fine");
    }

    #[tokio::test]
    async fn the_local_make_takes_no_relative_path() {
        let error = create_dir("sessions/new").await.expect_err("a relative path");

        assert!(error.to_string().contains("is not absolute"), "got {error}");
    }

    #[tokio::test]
    async fn the_local_probe_tells_a_directory_from_a_missing_name() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let start = directory.path().to_str().expect("utf-8");
        let missing = directory.path().join("gone").to_str().expect("utf-8").to_string();

        assert!(dir_exists(start).await.expect("a directory stands"));
        assert!(!dir_exists(&missing).await.expect("a missing name does not"));

        let error = dir_exists("sessions").await.expect_err("a relative path");
        assert!(error.to_string().contains("is not absolute"), "got {error}");
    }

    #[tokio::test]
    async fn a_removed_file_leaves_the_directory() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let file = directory.path().join("one.jsonl");
        std::fs::write(&file, "{}\n").expect("a file");

        remove_file(file.to_str().expect("utf-8")).await.expect("the removal");

        assert!(!file.exists(), "the file is gone");
    }

    #[tokio::test]
    async fn a_file_that_is_already_gone_cannot_be_removed_and_says_so() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let missing = directory.path().join("gone.jsonl");

        let error = remove_file(missing.to_str().expect("utf-8"))
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
        let path = stage("report.pdf", "pdf", b"%PDF-1.4").await.expect("the write");

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
        let first = stage("notes.txt", "txt", b"one").await.expect("the first");
        let second = stage("notes.txt", "txt", b"two").await.expect("the second");

        assert_ne!(first, second, "the second write may not land on the first");
        assert_eq!(tokio::fs::read(&first).await.expect("the first"), b"one");
        assert_eq!(tokio::fs::read(&second).await.expect("the second"), b"two");

        tokio::fs::remove_file(&first).await.expect("the cleanup");
        tokio::fs::remove_file(&second).await.expect("the cleanup");
    }

    #[tokio::test]
    async fn a_staged_file_without_an_extension_ends_on_no_dot() {
        let path = stage("LICENSE", "", b"text").await.expect("the write");

        assert!(!path.ends_with('.'), "a trailing dot names no file: {path}");

        tokio::fs::remove_file(&path).await.expect("the cleanup");
    }
}
