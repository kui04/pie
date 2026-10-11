//! The conversation files of pi, as pie reads them.
//!
//! Pi keeps its sessions as JSONL files under `~/.pi/agent/sessions/` and has no
//! command to list them. Therefore pie reads them itself. A summary needs three
//! values: the header line, the first words of the user, and the latest name.
//! [`SessionSummary`] is that summary, and the parsers of the lines behind it live
//! here, because the format is pi's wherever the bytes come from.
//!
//! [`SessionStore`] hands the reading to one of two readers, and the machine decides
//! which: [`local`] reads this machine's own filesystem, and [`ssh`] asks the host
//! itself. The session file names come from pi (`<timestamp>_<id>.jsonl`).
//! Therefore a plain glob is safe over them.
//!
//! This is the file layout of pi, not of a machine, which is why it lives with
//! the sessions: the layout is the same on both machines, and what differs - the
//! filesystem here, sftp there - is the file channel of the machine that
//! [`host`](crate::host) provides.
//!
//! `modified` is the time of the last growth of the file. Pi computes the
//! greatest message time in the full file. The last write of the file is that
//! time or later (pi appends). The listing carries the value at no cost, and it
//! never puts the order wrong.

mod local;
mod ssh;

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::error::PieError;
use crate::host::{Error, Host, HostPath};

use pi_rpc::entry::Entry;
use pi_rpc::message::{Message, UserBlock, UserContent};

/// The conversations of one connection's machine.
///
/// Which machine it is decides how the files are read, and nothing else: the
/// layout belongs to pi and is the same on both.
pub(crate) enum SessionStore {
    /// This machine: pi's own directory here, read straight from the filesystem.
    Local(local::Local),

    /// An SSH host: the tools of the host first, then sftp for what they miss.
    Ssh(ssh::Ssh),
}

impl SessionStore {
    /// The reader of the machine that a host reached.
    pub(crate) fn of(host: &Host) -> SessionStore {
        match host.ssh_handle() {
            None => SessionStore::Local(local::Local::new()),
            Some(ssh) => SessionStore::Ssh(ssh::Ssh::new(ssh)),
        }
    }

    /// Every conversation that pi wrote on this machine, the newest first.
    ///
    /// # Errors
    ///
    /// [`PieError::Host`] when the files cannot be read, with the path at fault in
    /// the message: `UnreadableLocal` on this machine, and `UnreadableRemote` or
    /// the failure of the reach over SSH.
    pub(crate) async fn summaries(&self) -> Result<Vec<SessionSummary>, PieError> {
        match self {
            SessionStore::Local(local) => local.summaries().await,
            SessionStore::Ssh(ssh) => ssh.summaries().await,
        }
    }
}

/// One read of the head scan.
const READ_CHUNK: usize = 8 * 1024;

/// One session that pi wrote, as its own lines report it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// The place of the file, as the host sees it.
    pub path: String,

    /// The id of the session from pi, from the header of the file.
    pub id: String,

    /// The start of the session. Empty for files that are older than this field
    /// of pi.
    pub cwd: String,

    /// The display name that the user gave last, if present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// The session of the fork, if this session is a fork.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,

    /// The start time of the session by pi (the timestamp in the header,
    /// RFC3339).
    pub created: String,

    /// The time of the last growth of the file, RFC3339.
    pub modified: String,

    /// The first words of the user, if the file goes that far.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_message: Option<String>,
}

impl SessionSummary {
    /// Builds a summary from the lines of one file.
    ///
    /// `None` when the file is not a session of pi: its first line is not a
    /// header, or the header names another kind.
    fn of(path: &str, lines: SessionSummaryLines, modified: Option<String>) -> Option<SessionSummary> {
        let header: SessionFileHeader = serde_json::from_str(lines.header.as_deref()?).ok()?;
        if header.kind != "session" {
            return None;
        }
        Some(SessionSummary {
            path: path.to_string(),
            id: header.id,
            cwd: header.cwd,
            name: lines.name,
            parent_session_path: header.parent_session,
            modified: modified.unwrap_or_else(|| header.timestamp.clone()),
            created: header.timestamp,
            first_message: lines.first,
        })
    }
}

/// The first line of a session file: the `SessionHeader` of pi (pinned
/// `core/session-manager.ts`).
///
/// The header is the only place of the working directory. Pi also encodes a cwd
/// into the name of the directory, but with loss: the encoding replaces `/` and
/// `:` in the same way. Therefore `/home/pie` and `/home-pie` are the same name.
/// For this reason, nothing here decodes a directory name back into a cwd.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFileHeader {
    /// The kind of the entry. Pi decides that a file is a session if this value
    /// is `session`. This reader does the same. Without the check, anything with
    /// an id and a timestamp would be a header.
    #[serde(rename = "type")]
    kind: String,

    /// The session id from pi.
    id: String,

    /// The start time of the session by pi, ISO.
    timestamp: String,

    /// The start of the session. The value is absent in files that are older
    /// than this field.
    #[serde(default)]
    cwd: String,

    /// The session of the fork, if this session is a fork.
    #[serde(default)]
    parent_session: Option<String>,
}

/// The three lines that one session's summary is built from, from any place of
/// the read.
///
/// One file's worth: the header line, the first words of the user, and the latest
/// name. Which reader produced them - a full scan here, a script on the machine,
/// or fragments over sftp - is not part of this value.
#[derive(Debug, Default, Clone)]
struct SessionSummaryLines {
    /// The header line of the file.
    header: Option<String>,

    /// The first words of the user, as pi reads them.
    first: Option<String>,

    /// The latest display name in the file, including a clear.
    name: Option<String>,
}

/// A session name as pi stores it: without space at the ends, and empty for no
/// name. The scan of pi takes the latest `session_info` entry, whatever it says,
/// including an empty entry: a rename to nothing clears a name.
fn cleaned_name(name: Option<&str>) -> Option<String> {
    let name = name?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// What one line says about the display name.
///
/// `Some(None)` is a clear. Pi removes a name with a rename to nothing. A scan
/// stops there and does not read an older name.
fn name_in(line: &[u8]) -> Option<Option<String>> {
    let entry: Entry = serde_json::from_slice(line).ok()?;
    let Entry::SessionInfo(info) = entry else {
        return None;
    };
    Some(cleaned_name(info.name.as_deref()))
}

/// What one line reports as the words of the user, in the shape that the scan of
/// pi uses: a user message with text in it (pinned `extractTextContent`).
///
/// One difference from the scan of pi is deliberate. The scan of pi keeps a
/// first turn without text: `if (!textContent) continue` is false for a
/// non-empty string such as `" "`. Therefore that turn becomes the first message
/// of pi (pinned `session-manager.ts:840`). This reader looks for a turn that says
/// something, and continues the search. The difference is the value in the
/// session drawer for a session that started with one space. The skip of that
/// turn is the correct result.
fn first_text(line: &[u8]) -> Option<String> {
    let entry: Entry = serde_json::from_slice(line).ok()?;
    let Entry::Message(message) = entry else {
        return None;
    };
    let Message::User(user) = message.message else {
        return None;
    };
    let text = text_of(&user.content);
    (!text.trim().is_empty()).then_some(text)
}

/// The text of the content of a message: a plain string as it is, or the text
/// blocks joined with one space, as pi reads them.
fn text_of(content: &UserContent) -> String {
    match content {
        UserContent::Text(text) => text.clone(),
        UserContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                UserBlock::Text(text) => Some(text.text.as_str()),
                UserBlock::Image(_) | UserBlock::Other(_) => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// Formats the time of a file as the ISO strings of pi (`toISOString()`, always
/// three fractional digits). Therefore timestamps compare and sort in one order.
fn rfc3339(when: SystemTime) -> Option<String> {
    let since_epoch = when.duration_since(std::time::UNIX_EPOCH).ok()?;
    let millis = since_epoch.as_millis() as i64;
    rfc3339_of_millis(millis)
}

fn rfc3339_of_millis(millis: i64) -> Option<String> {
    let when = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()?;
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        when.year(),
        u8::from(when.month()),
        when.day(),
        when.hour(),
        when.minute(),
        when.second(),
        when.millisecond()
    ))
}

/// Pi expands a leading `~` in these paths (pinned `expandTildePath`). A value
/// without a `~` stays as it is, with or without a home. Both readers use it: the
/// session root of this machine ([`local`]) and the one that a host reports
/// ([`ssh`]).
pub(super) fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    match (path, home) {
        ("~", Some(home)) => home.to_path_buf(),
        (_, Some(home)) => path
            .strip_prefix("~/")
            .or_else(|| path.strip_prefix("~\\"))
            .map(|rest| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        (_, None) => PathBuf::from(path),
    }
}

/// The newest conversation first, the order of the session list.
fn newest_first(summaries: &mut [SessionSummary]) {
    summaries.sort_by(|a, b| b.modified.cmp(&a.modified));
}

/// The path of a session file, or the mistake of a caller that handed in another.
///
/// A session file is named the way the listings hand it out: absolutely. Pi
/// resolves a relative path against its own directory, which on a phone is not the
/// home of a person. The answer comes before any channel or process is touched.
///
/// # Errors
///
/// [`Error::NotAbsolute`] for a relative path.
pub(crate) fn checked_session_path(path: &HostPath) -> Result<&str, Error> {
    if path.is_absolute() {
        Ok(path.as_str())
    } else {
        Err(crate::host::files::not_absolute(path.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first line of a session file, as pi writes it.
    pub(super) const HEADER: &str =
        r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-10-02T13:45:12.345Z","cwd":"/home/pie"}"#;

    pub(super) fn user_line(id: &str, timestamp: &str, millis: i64, text: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":null,"timestamp":"{timestamp}","message":{{"role":"user","content":"{text}","timestamp":{millis}}}}}"#
        )
    }

    pub(super) fn name_line(id: &str, name: &str) -> String {
        format!(
            r#"{{"type":"session_info","id":"{id}","parentId":null,"timestamp":"2026-10-02T13:50:00.000Z","name":"{name}"}}"#
        )
    }

    pub(super) fn system_line(fill: &str) -> String {
        format!(
            r#"{{"type":"message","id":"sys","parentId":null,"timestamp":"2026-10-02T13:45:12.900Z","message":{{"role":"system","content":"","sections":{{"tools":"{fill}"}},"timestamp":1790948712900}}}}"#
        )
    }

    pub(super) async fn on_disk(content: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().expect("a temp directory");
        let path = directory.path().join("s.jsonl");
        std::fs::write(&path, content).expect("the session file");
        (directory, path)
    }

    #[test]
    fn a_summary_reads_its_header_and_first_message() {
        let lines = SessionSummaryLines {
            header: Some(HEADER.to_string()),
            first: Some("hello there".to_string()),
            name: Some("Renamed".to_string()),
        };

        let summary = SessionSummary::of("/x/s.jsonl", lines, Some("2026-10-02T13:45:20.000Z".to_string()))
            .expect("a session file");

        assert_eq!(summary.id, "s1");
        assert_eq!(summary.cwd, "/home/pie");
        assert_eq!(summary.name.as_deref(), Some("Renamed"));
        assert_eq!(summary.created, "2026-10-02T13:45:12.345Z");
        assert_eq!(summary.modified, "2026-10-02T13:45:20.000Z");
        assert_eq!(summary.first_message.as_deref(), Some("hello there"));
    }

    #[test]
    fn the_file_time_is_what_modified_falls_back_to() {
        let lines = SessionSummaryLines {
            header: Some(HEADER.to_string()),
            ..SessionSummaryLines::default()
        };

        let summary = SessionSummary::of("/x/s.jsonl", lines, None).expect("a session file");

        assert_eq!(
            summary.modified, summary.created,
            "no file time leaves the header's own"
        );
    }

    #[test]
    fn a_file_without_a_session_header_is_not_a_session() {
        let lines = SessionSummaryLines {
            header: Some(user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")),
            ..SessionSummaryLines::default()
        };

        assert!(
            SessionSummary::of("/x/s.jsonl", lines, None).is_none(),
            "pi's own scan drops files whose first entry is not a header"
        );
    }

    #[test]
    fn text_parts_are_joined_the_way_pi_reads_them() {
        let line = r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":[{"type":"text","text":"one"},{"type":"image","data":"AAAA","mimeType":"image/png"},{"type":"text","text":"two"}],"timestamp":1790948713000}}"#;

        assert_eq!(first_text(line.as_bytes()).as_deref(), Some("one two"));
    }

    #[test]
    fn a_session_file_is_named_absolutely() {
        // The rule that `switch_session` answers with before it touches the client.
        assert_eq!(
            checked_session_path(&HostPath::new("/home/u/.pi/agent/sessions/x/one.jsonl")).expect("absolute"),
            "/home/u/.pi/agent/sessions/x/one.jsonl"
        );
        assert!(matches!(
            checked_session_path(&HostPath::new("sessions/one.jsonl")),
            Err(Error::NotAbsolute { .. })
        ));
        assert!(matches!(
            checked_session_path(&HostPath::new("")),
            Err(Error::NotAbsolute { .. })
        ));
    }

    #[test]
    fn the_modified_time_formats_the_way_pi_stores_it() {
        // The ISO strings of pi and the file times of pie must land in one order
        // for the sort of the list.
        assert_eq!(
            rfc3339_of_millis(1790948713000).as_deref(),
            Some("2026-10-02T13:45:13.000Z")
        );
    }
}
