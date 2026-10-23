//! The conversations of this machine, read from its own filesystem.
//!
//! The scan of pi itself is the model (pinned `core/session-manager.ts`,
//! `buildSessionInfo`), and it is exact: the whole file is read, so a rename
//! anywhere in it is found. A local read costs little, and nothing is skipped to
//! save one. The reads run on blocking threads of the runtime, in a bounded
//! number, because a listing reads many files, and a file of a long conversation
//! is not small.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use tokio::task::JoinSet;

use crate::host::SessionFileLines;
use crate::host::files::{READ_CHUNK, expand_home};

/// The number of session files that one listing reads at the same time. The
/// drawer of pi reads its own list with the same bound
/// (`MAX_CONCURRENT_SESSION_INFO_LOADS` of `core/session-manager.ts`, pinned).
const MAX_CONCURRENT_LOADS: usize = 10;

/// Scans the conversation files of pi on this machine.
pub(super) async fn read_sessions(
    first_text: fn(&[u8]) -> Option<String>,
    name_in: fn(&[u8]) -> Option<Option<String>>,
) -> anyhow::Result<Vec<SessionFileLines>> {
    list_in(sessions_root().as_deref(), first_text, name_in).await
}

/// The sessions that pi wrote under `root`.
///
/// Pie skips a file or a project directory that it cannot read, and does not
/// fail the listing. One damaged part must not hide the rest. The scan of pi
/// also drops unreadable entries. A machine with no root of its own - no home
/// to resolve pi's directory against - has nothing to show, which is an empty
/// listing and not a failure.
async fn list_in(
    root: Option<&Path>,
    first_text: fn(&[u8]) -> Option<String>,
    name_in: fn(&[u8]) -> Option<Option<String>>,
) -> anyhow::Result<Vec<SessionFileLines>> {
    let mut results = Vec::new();
    let mut candidates = Vec::new();
    let Some(root) = root else {
        return Ok(results);
    };
    let mut projects = match tokio::fs::read_dir(root).await {
        Ok(projects) => projects,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(results),
        Err(error) => {
            return Err(error).with_context(|| format!("cannot read {}", root.display()));
        }
    };
    while let Some(project) = next_entry(&mut projects, &root.display().to_string()).await? {
        let project_path = project.path();
        let shown_project = project_path.display().to_string();
        // The free `metadata` follows links. The `metadata` of a `DirEntry` does
        // not. A project directory behind a link is still a project directory.
        if !match tokio::fs::metadata(&project_path).await {
            Ok(metadata) => metadata.is_dir(),
            Err(error) => {
                tracing::warn!(path = %shown_project, %error, "skipping a project directory pie cannot read");
                continue;
            }
        } {
            continue;
        }
        let mut files = match tokio::fs::read_dir(&project_path).await {
            Ok(files) => files,
            Err(error) => {
                tracing::warn!(path = %shown_project, %error, "skipping a project directory pie cannot read");
                continue;
            }
        };
        while let Some(file) = next_entry(&mut files, &shown_project).await? {
            let path = file.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            candidates.push(path);
        }
    }

    let mut reads = JoinSet::new();
    let mut pending = candidates.into_iter();
    loop {
        while reads.len() < MAX_CONCURRENT_LOADS {
            let Some(path) = pending.next() else { break };
            reads.spawn_blocking(move || match lines_of_file(&path, first_text, name_in) {
                Ok(lines) => Some(lines),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "skipping a session file pie cannot read");
                    None
                }
            });
        }
        let Some(finished) = reads.join_next().await else {
            break;
        };
        match finished {
            Ok(Some(lines)) => results.push(lines),
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "a read of the local listing did not finish"),
        }
    }

    Ok(results)
}

/// The place where pi keeps the sessions that it started on this machine.
fn sessions_root() -> Option<PathBuf> {
    let agent_dir = std::env::var_os("PI_CODING_AGENT_DIR");
    let agent_dir = agent_dir.as_deref().and_then(|value| value.to_str());
    if let Some(dir) = agent_dir {
        return Some(expand_home(dir, dirs::home_dir().as_deref()).join("sessions"));
    }

    let session_dir = std::env::var_os("PI_CODING_AGENT_SESSION_DIR");
    let session_dir = session_dir.as_deref().and_then(|value| value.to_str());
    if let Some(dir) = session_dir {
        return Some(expand_home(dir, dirs::home_dir().as_deref()));
    }

    dirs::home_dir().map(|home| home.join(".pi").join("agent").join("sessions"))
}

/// Reads the candidate lines and modification time of one session file on a blocking thread.
fn lines_of_file(
    path: &Path,
    first_text: fn(&[u8]) -> Option<String>,
    name_in: fn(&[u8]) -> Option<Option<String>>,
) -> std::io::Result<SessionFileLines> {
    let shown = path.to_string_lossy().into_owned();
    let modified = std::fs::metadata(path).ok().and_then(|stats| stats.modified().ok());
    let mut lines = read_session_file(std::fs::File::open(path)?, first_text, name_in)?;
    lines.path = shown;
    lines.modified = modified;
    Ok(lines)
}

/// Reads one session file of this machine for its summary lines.
fn read_session_file(
    file: impl Read,
    first_text: fn(&[u8]) -> Option<String>,
    name_in: fn(&[u8]) -> Option<Option<String>>,
) -> std::io::Result<SessionFileLines> {
    let mut reader = BufReader::with_capacity(READ_CHUNK * 4, file);
    let mut buffer = Vec::new();
    let mut lines = SessionFileLines::default();
    loop {
        buffer.clear();
        if reader.read_until(b'\n', &mut buffer)? == 0 {
            break;
        }
        let line = buffer.trim_ascii_end();
        if lines.header.is_none() {
            lines.header = Some(String::from_utf8_lossy(line).into_owned());
            continue;
        }
        if lines.first.is_none() && holds(line, b"user") {
            let line = String::from_utf8_lossy(line);
            if let Some(text) = first_text(line.as_bytes()) {
                lines.first = Some(text);
            }
        }
        if holds(line, b"session_info") {
            let line = String::from_utf8_lossy(line);
            if let Some(name) = name_in(line.as_bytes()) {
                lines.name = name;
            }
        }
    }
    Ok(lines)
}

/// Whether a line holds a literal.
fn holds(line: &[u8], literal: &[u8]) -> bool {
    memchr::memmem::find(line, literal).is_some()
}

/// Reads the next directory entry.
async fn next_entry(entries: &mut tokio::fs::ReadDir, shown: &str) -> anyhow::Result<Option<tokio::fs::DirEntry>> {
    entries
        .next_entry()
        .await
        .with_context(|| format!("cannot read {shown}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::files::tests::{HEADER, first_text, name_in, name_line, on_disk, user_line};
    use crate::host::ssh::sessions::{NAME_BLOCK, NAME_SCAN_BYTES};

    async fn summary_lines(path: &Path) -> SessionFileLines {
        let opened = std::fs::File::open(path).expect("the file");
        read_session_file(opened, first_text, name_in).expect("the read")
    }

    #[test]
    fn a_file_that_cannot_be_read_is_a_failure_and_not_a_row() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let missing = directory.path().join("gone.jsonl");

        assert!(
            lines_of_file(&missing, first_text, name_in).is_err(),
            "a file that is not there is a failure, not a session with nothing to say"
        );
    }

    #[tokio::test]
    async fn a_name_far_from_the_end_still_lists_on_this_machine() {
        let mut content = format!(
            "{HEADER}\n{}\n{}\n",
            name_line("n1", "Far away"),
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")
        );
        while content.len() < NAME_SCAN_BYTES as usize + NAME_BLOCK * 2 {
            content.push_str(&user_line("m2", "2026-10-02T13:45:14.000Z", 1790948714000, "later"));
            content.push('\n');
        }
        let (_keep, path) = on_disk(&content).await;

        let lines = summary_lines(&path).await;

        assert_eq!(lines.name.as_deref(), Some("Far away"));
        assert_eq!(lines.first.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn a_file_with_a_bad_byte_still_lists() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let path = directory.path().join("s.jsonl");
        let mut content: Vec<u8> = Vec::new();
        content.extend_from_slice(HEADER.as_bytes());
        content.push(b'\n');
        let mut line: Vec<u8> =
            String::from(r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":"hi "#)
                .into_bytes();
        line.push(0xFF);
        line.extend_from_slice(r#" there","timestamp":1790948713000}}"#.as_bytes());
        content.extend_from_slice(&line);
        content.push(b'\n');
        std::fs::write(&path, content).expect("the session file");

        let lines = summary_lines(&path).await;

        assert_eq!(
            lines.first.as_deref(),
            Some("hi \u{fffd} there"),
            "the one bad byte became a replacement character, not a missing session"
        );
    }

    #[tokio::test]
    async fn the_whole_file_read_meets_the_last_rename_last() {
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}\n{}",
            name_line("n1", "First"),
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi"),
            name_line("n2", "Last"),
        ))
        .await;

        let lines = summary_lines(&path).await;

        assert_eq!(lines.name.as_deref(), Some("Last"));
    }

    #[tokio::test]
    async fn renaming_to_nothing_clears_the_name() {
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}",
            name_line("n1", "Named"),
            name_line("n2", ""),
        ))
        .await;

        let lines = summary_lines(&path).await;

        assert_eq!(
            lines.name, None,
            "pi clears a name by renaming to nothing; an older one is never shown in its place"
        );
    }

    #[tokio::test]
    async fn the_first_message_is_what_the_user_said_not_what_is_in_the_way() {
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}\n{}",
            r#"{"type":"usage","id":"u1","parentId":null,"timestamp":"2026-10-02T13:45:12.500Z","kind":"cache_warm"}"#,
            r#"{"type":"message","id":"m0","parentId":null,"timestamp":"2026-10-02T13:45:12.600Z","message":{"role":"user","content":[{"type":"image","data":"AAAA","mimeType":"image/png"}],"timestamp":1790948712600}}"#,
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "the real first words"),
        ))
        .await;

        let lines = summary_lines(&path).await;

        assert_eq!(
            lines.first.as_deref(),
            Some("the real first words"),
            "an image-only turn is not what the user said"
        );
    }

    #[tokio::test]
    async fn the_local_listing_reads_every_project_directory() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let root = directory.path().join("sessions");
        let project = root.join("--home-pie--");
        std::fs::create_dir_all(&project).expect("the project directory");
        let file = project.join("20261002_abc.jsonl");
        std::fs::write(
            &file,
            format!(
                "{HEADER}\n{}",
                user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")
            ),
        )
        .expect("the session file");
        std::fs::write(root.join("stray.txt"), HEADER).expect("the stray");

        let found = list_in(Some(&root), first_text, name_in).await.expect("the listing");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, file.to_string_lossy());
        assert_eq!(found[0].first.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn a_local_listing_of_nothing_is_not_a_failure() {
        let directory = tempfile::tempdir().expect("a temp directory");

        let found = list_in(Some(&directory.path().join("no-such-dir")), first_text, name_in)
            .await
            .expect("a host that has run nothing lists as empty");

        assert!(found.is_empty());
    }

    #[tokio::test]
    async fn one_unreadable_project_directory_does_not_hide_the_rest() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("a temp directory");
        let good = root.path().join("--good--");
        std::fs::create_dir(&good).expect("the readable project");
        std::fs::write(
            good.join("s.jsonl"),
            format!(
                "{HEADER}\n{}",
                user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")
            ),
        )
        .expect("the session file");
        let bad = root.path().join("--bad--");
        std::fs::create_dir(&bad).expect("the unreadable project");
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o000)).expect("the lock");
        if tokio::fs::read_dir(&bad).await.is_ok() {
            return;
        }

        let found = list_in(Some(root.path()), first_text, name_in)
            .await
            .expect("the listing");

        assert_eq!(found.len(), 1, "the readable project is still listed");
    }

    #[tokio::test]
    #[ignore = "reads whatever sessions exist on this machine"]
    async fn the_names_of_this_machines_sessions_all_come_out_right() {
        let root = sessions_root().expect("a home");
        let found = list_in(Some(&root), first_text, name_in).await.expect("the listing");

        let mut named = 0;
        for entry in &found {
            let whole = std::fs::read(&entry.path).expect("the file");
            let reference = whole.split(|byte| *byte == b'\n').rev().find_map(name_in).flatten();
            assert_eq!(
                entry.name, reference,
                "the listing and the whole file disagree on {}",
                entry.path
            );
            named += usize::from(reference.is_some());
        }
        eprintln!("sessions: {}, named: {}", found.len(), named);
    }
}
