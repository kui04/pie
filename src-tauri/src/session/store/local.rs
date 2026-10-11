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

use tokio::task::JoinSet;

use crate::error::PieError;
use crate::host::Error;
use crate::host::files::unreadable;

use super::{READ_CHUNK, SessionSummary, SessionSummaryLines, expand_home, first_text, name_in, newest_first, rfc3339};

/// This machine's conversations, as its own filesystem holds them.
#[derive(Clone)]
pub(crate) struct Local {
    /// The sessions directory of pi as it resolves it here (see
    /// [`local_sessions_root`]). Nothing when there is no home to resolve it
    /// against.
    root: Option<PathBuf>,
}

impl Local {
    /// The reader of this machine.
    pub(super) fn new() -> Self {
        Self {
            root: local_sessions_root(),
        }
    }

    /// Every conversation that pi wrote on this machine, the newest first.
    ///
    /// No root is no listing and not a failure: a machine where pi never ran has
    /// nothing to show.
    ///
    /// # Errors
    ///
    /// [`Error::UnreadableLocal`] when the sessions directory itself cannot be
    /// read. A file or a project directory inside it that fails costs one row and
    /// a log line, not the listing. A path at fault names itself in the message.
    pub(super) async fn summaries(&self) -> Result<Vec<SessionSummary>, PieError> {
        Ok(self.list().await?)
    }

    /// The sessions that pi wrote under this machine's `sessions` directory.
    ///
    /// Pie skips a file or a project directory that it cannot read, and does not
    /// fail the listing. One damaged part must not hide the rest. The scan of pi
    /// also drops unreadable entries. A machine with no root of its own - no home
    /// to resolve pi's directory against - has nothing to show, which is an empty
    /// listing and not a failure.
    ///
    /// # Errors
    ///
    /// [`Error::UnreadableLocal`] when the sessions directory itself cannot be
    /// read.
    async fn list(&self) -> Result<Vec<SessionSummary>, Error> {
        let mut summaries = Vec::new();
        let mut candidates = Vec::new();
        let Some(root) = self.root.as_deref() else {
            return Ok(summaries);
        };
        let mut projects = match tokio::fs::read_dir(root).await {
            Ok(projects) => projects,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(summaries),
            Err(error) => return Err(unreadable(&root.display().to_string(), error)),
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

        // The files are read side by side, as the drawer of pi reads its own list: a
        // session of this machine is a file of a few megabytes, and a machine that
        // reads them one after the other waits for the sum of them. The bound keeps a
        // drawer of hundreds of sessions from opening hundreds of files at once.
        let mut reads = JoinSet::new();
        let mut pending = candidates.into_iter();
        loop {
            while reads.len() < MAX_CONCURRENT_LOADS {
                let Some(path) = pending.next() else { break };
                // The task must own what it reads: `spawn_blocking` takes a
                // `'static` future, and the reader of this machine is a path.
                let reader = self.clone();
                reads.spawn_blocking(move || reader.row(path));
            }
            let Some(finished) = reads.join_next().await else {
                break;
            };
            match finished {
                Ok(Some(summary)) => summaries.push(summary),
                Ok(None) => {}
                Err(error) => tracing::warn!(%error, "a read of the local listing did not finish"),
            }
        }

        newest_first(&mut summaries);
        Ok(summaries)
    }

    /// One row of the listing, or none when the file behind it fails.
    ///
    /// The failure of one file is the loss of one row, not of the listing, and the
    /// log says which file it was.
    fn row(&self, path: PathBuf) -> Option<SessionSummary> {
        match summary_of_file(&path) {
            Ok(summary) => summary,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "skipping a session file pie cannot read");
                None
            }
        }
    }
}

/// The number of session files that one listing reads at the same time. The
/// drawer of pi reads its own list with the same bound
/// (`MAX_CONCURRENT_SESSION_INFO_LOADS` of `core/session-manager.ts`, pinned).
const MAX_CONCURRENT_LOADS: usize = 10;

/// The place where pi keeps the sessions that it started on this machine.
///
/// Pi resolves its sessions root in one order (pinned `main.ts`): the
/// `--session-dir` flag, which pie never passes, then the two environment
/// variables, then the default under the home. The names are the package name
/// of pi in capitals (`config.ts`, `ENV_AGENT_DIR`). The standard package writes
/// them as `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. A user who
/// moved the sessions said so in one of them. A listing that shows none without
/// a message is the worst result.
///
/// Pie does not read the step before the flag here: the `sessionDir` of pi in
/// `settings.json`. A user who set only that value still sees an empty listing.
///
/// The home itself resolves as pi resolves it: `$HOME`, or the login entry. This
/// is the rule that `os.homedir()` of Node and [`dirs::home_dir`] share.
fn local_sessions_root() -> Option<PathBuf> {
    sessions_root_from(
        std::env::var_os("PI_CODING_AGENT_DIR")
            .as_deref()
            .and_then(|value| value.to_str()),
        std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
            .as_deref()
            .and_then(|value| value.to_str()),
        dirs::home_dir(),
    )
}

/// The root [`local_sessions_root`] reads, over the pieces it reads it from.
fn sessions_root_from(agent_dir: Option<&str>, session_dir: Option<&str>, home: Option<PathBuf>) -> Option<PathBuf> {
    // `PI_CODING_AGENT_SESSION_DIR` names the sessions root itself.
    // `PI_CODING_AGENT_DIR` names the agent root of pi, and the sessions are
    // below it (pinned `getAgentDir`, `getDefaultSessionDirPath`).
    if let Some(dir) = session_dir {
        return Some(expand_home(dir, home.as_deref()));
    }
    if let Some(dir) = agent_dir {
        return Some(expand_home(dir, home.as_deref()).join("sessions"));
    }
    Some(home?.join(".pi").join("agent").join("sessions"))
}

/// The summary of one session file, or nothing if it is not one.
///
/// This runs on a blocking thread of the runtime: a listing reads many files, and
/// a file of a long conversation is not small.
fn summary_of_file(path: &Path) -> std::io::Result<Option<SessionSummary>> {
    let shown = path.to_string_lossy();
    let modified = std::fs::metadata(path)
        .ok()
        .and_then(|stats| stats.modified().ok())
        .and_then(rfc3339);
    let lines = read_local(std::fs::File::open(path)?)?;
    Ok(SessionSummary::of(&shown, lines, modified))
}

/// Reads one session file of this machine for its summary.
///
/// The whole file goes through the reader, because the name of a session may be
/// anywhere in it: a rename that a long conversation followed sits far from the
/// end, and a listing that shows no name for it would be wrong. What the read
/// saves is the parse: only the three kinds of line that a summary needs are
/// parsed as JSON - the header, the first turn of the user, and a rename. Every
/// other line, which is the bulk of a long transcript, is searched for a
/// literal and dropped.
fn read_local(file: impl Read) -> std::io::Result<SessionSummaryLines> {
    let mut reader = BufReader::with_capacity(READ_CHUNK * 4, file);
    let mut buffer = Vec::new();
    let mut lines = SessionSummaryLines::default();
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
            // The line goes to the parser the way the reader of pi sees it: one bad
            // byte is a replacement character, not a line that says nothing. The
            // decode costs nothing for a line that is valid UTF-8, which is nearly
            // every line, and it happens only for a line this filter kept.
            let line = String::from_utf8_lossy(line);
            if let Some(text) = first_text(line.as_bytes()) {
                lines.first = Some(text);
            }
        }
        // The latest name wins, including a clear. Pi appends a `session_info`
        // entry at each rename, and the scan of pi reads the last one.
        if holds(line, b"session_info") {
            let line = String::from_utf8_lossy(line);
            if let Some(name) = name_in(line.as_bytes()) {
                lines.name = name;
            }
        }
    }
    Ok(lines)
}

/// Whether a line holds a literal. The first byte is what the scan looks for, so
/// a literal that starts with a rare byte costs one pass over the line. It is a
/// filter and not a decision: the parse that follows is what reads the line.
fn holds(line: &[u8], literal: &[u8]) -> bool {
    let Some((first, rest)) = literal.split_first() else {
        return true;
    };
    let mut at = 0;
    while let Some(found) = line[at..].iter().position(|byte| byte == first) {
        let start = at + found;
        let Some(window) = line.get(start + 1..start + literal.len()) else {
            return false;
        };
        if window == rest {
            return true;
        }
        at = start + 1;
    }
    false
}

/// Reads the next directory entry. The function names the directory of the listing
/// if pie cannot read one of its entries.
async fn next_entry(entries: &mut tokio::fs::ReadDir, shown: &str) -> Result<Option<tokio::fs::DirEntry>, Error> {
    entries.next_entry().await.map_err(|error| unreadable(shown, error))
}

#[cfg(test)]
mod tests {
    use super::super::ssh::{NAME_BLOCK, NAME_SCAN_BYTES};
    use super::super::tests::*;
    use super::*;

    /// The lines of a session file of this machine, as the listing reads them.
    async fn summary_lines(path: &std::path::Path) -> SessionSummaryLines {
        let opened = std::fs::File::open(path).expect("the file");
        read_local(opened).expect("the read")
    }

    #[tokio::test]
    async fn a_file_that_is_not_a_session_is_no_row_and_no_failure() {
        let (_keep, path) = on_disk(&format!(
            "{}\n",
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")
        ))
        .await;

        let summary = summary_of_file(&path).expect("a file that opens");

        assert!(
            summary.is_none(),
            "its first line is not a header, so the file is not a session"
        );
    }

    #[test]
    fn a_file_that_cannot_be_read_is_a_failure_and_not_a_row() {
        let directory = tempfile::tempdir().expect("a temp directory");
        let missing = directory.path().join("gone.jsonl");

        assert!(
            summary_of_file(&missing).is_err(),
            "a file that is not there is a failure, not a session with nothing to say"
        );
    }

    #[test]
    fn the_sessions_root_follows_pis_own_order() {
        // Pi resolves the flag, then `PI_CODING_AGENT_SESSION_DIR`, then
        // `PI_CODING_AGENT_DIR` plus `sessions`, then the default (pinned
        // `main.ts`, `getAgentDir`). Pie never passes the flag.
        let home = || Some(PathBuf::from("/home/u"));
        assert_eq!(
            sessions_root_from(None, None, home()),
            Some(PathBuf::from("/home/u/.pi/agent/sessions")),
            "the default lives under the home"
        );
        assert_eq!(
            sessions_root_from(Some("/opt/pi-agent"), None, home()),
            Some(PathBuf::from("/opt/pi-agent/sessions")),
            "the agent dir holds the sessions under it"
        );
        assert_eq!(
            sessions_root_from(Some("/opt/pi-agent"), Some("/var/pi/sessions"), home()),
            Some(PathBuf::from("/var/pi/sessions")),
            "the sessions dir wins over the agent dir"
        );
        assert_eq!(
            sessions_root_from(Some("~/relocated"), None, home()),
            Some(PathBuf::from("/home/u/relocated/sessions")),
            "a leading ~ is the home, as pi expands it"
        );
        assert_eq!(sessions_root_from(None, None, None), None, "no home, no default");
    }

    #[tokio::test]
    async fn a_name_far_from_the_end_still_lists_on_this_machine() {
        // The listing of this machine reads the whole file for this reason: a rename
        // that a long conversation followed sits far from the end of the file, and the
        // name is what tells one session of the drawer from another. The fallback of a
        // host over the network reports no name there, because it cannot afford that
        // read (`the_fallback_never_shows_a_name_the_file_does_not_hold_latest`).
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
        // Pi reads through a decoder that replaces each value that is not UTF-8
        // with U+FFFD and continues. A full file that pie skips for one bad byte
        // would be stricter than the reader that it mirrors.
        let directory = tempfile::tempdir().expect("a temp directory");
        let path = directory.path().join("s.jsonl");
        let mut content: Vec<u8> = Vec::new();
        content.extend_from_slice(HEADER.as_bytes());
        content.push(b'\n');
        // The one bad byte is a real byte in the file, added to the line and not
        // written as an escape. `\xff` in a raw string is four characters, and
        // JSON has no such escape. One 0xFF alone is never valid UTF-8. That is
        // the purpose of the test.
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
        // Pi takes the latest `session_info` entry, whatever the growth of the
        // file. A full read sees the entries in order and keeps the last one.
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
            // This is not a message.
            r#"{"type":"usage","id":"u1","parentId":null,"timestamp":"2026-10-02T13:45:12.500Z","kind":"cache_warm"}"#,
            // This is a message, but the user said nothing.
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
        // This is neither a directory nor a session file. Both kinds ignore it.
        std::fs::write(root.join("stray.txt"), HEADER).expect("the stray");

        let summaries = Local {
            root: Some(root.clone()),
        }
        .list()
        .await
        .expect("the listing");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "s1");
        assert_eq!(summaries[0].path, file.to_string_lossy());
    }

    #[tokio::test]
    async fn a_local_listing_of_nothing_is_not_a_failure() {
        let directory = tempfile::tempdir().expect("a temp directory");

        let summaries = Local {
            root: Some(directory.path().join("no-such-dir")),
        }
        .list()
        .await
        .expect("a host that has run nothing lists as empty");

        assert!(summaries.is_empty());
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
            // A run as root ignores the mode. The skip has nothing to prove.
            return;
        }

        let summaries = Local {
            root: Some(root.path().to_path_buf()),
        }
        .list()
        .await
        .expect("the listing");

        assert_eq!(summaries.len(), 1, "the readable project is still listed");
        assert_eq!(summaries[0].id, "s1");
    }

    /// The listings of the real sessions of this machine, checked against the read
    /// of a file by pi: the full file, the latest name, and the first words of the
    /// user.
    ///
    /// The test reads the sessions that exist on the machine of the run. Therefore
    /// it is ignored here and runs when the read of real data is important.
    #[tokio::test]
    #[ignore = "reads whatever sessions exist on this machine"]
    async fn the_names_of_this_machines_sessions_all_come_out_right() {
        let root = local_sessions_root().expect("a home");
        let summaries = Local {
            root: Some(root.clone()),
        }
        .list()
        .await
        .expect("the listing");

        let mut named = 0;
        for summary in &summaries {
            let whole = std::fs::read(&summary.path).expect("the file");
            let reference = whole.split(|byte| *byte == b'\n').rev().find_map(name_in).flatten();
            assert_eq!(
                summary.name, reference,
                "the listing and the whole file disagree on {}",
                summary.path
            );
            named += usize::from(reference.is_some());
        }
        eprintln!("sessions: {}, named: {}", summaries.len(), named);
    }
}
