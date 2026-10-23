//! The conversation files of pi, as pie reads them.
//!
//! Pi keeps its sessions as JSONL files under `~/.pi/agent/sessions/` and has no
//! command to list them. Therefore pie reads them itself. A summary needs three
//! values: the header line, the first words of the user, and the latest name.
//! [`SessionSummary`] is that summary, and the parsers of the lines behind it live
//! here, because the format is pi's wherever the bytes come from.
//!
//! How the files are read from a machine is [`Host::read_session_files`]'s
//! business; this module knows only the JSONL format that pi writes and how to
//! turn each file's lines into a [`SessionSummary`].

use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::host::{Host, SessionFileLines};

use pi_rpc::entry::Entry;
use pi_rpc::message::{Message, UserBlock, UserContent};

/// Every conversation that pi wrote on `host`, the newest first.
///
/// # Errors
///
/// A sentence when the files cannot be read, with the path at fault in it,
/// and the failure of the reach over SSH.
pub(crate) async fn summaries(host: &dyn Host) -> anyhow::Result<Vec<SessionSummary>> {
    let files = host.read_session_files(first_text, name_in).await?;
    let mut list: Vec<SessionSummary> = files.into_iter().filter_map(SessionSummary::of).collect();
    newest_first(&mut list);
    Ok(list)
}

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
    fn of(lines: SessionFileLines) -> Option<SessionSummary> {
        let header: SessionFileHeader = serde_json::from_str(lines.header.as_deref()?).ok()?;
        if header.kind != "session" {
            return None;
        }
        let modified = lines
            .modified
            .and_then(rfc3339)
            .unwrap_or_else(|| header.timestamp.clone());
        Some(SessionSummary {
            path: lines.path,
            id: header.id,
            cwd: header.cwd,
            name: lines.name,
            parent_session_path: header.parent_session,
            modified,
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
pub(crate) fn name_in(line: &[u8]) -> Option<Option<String>> {
    let entry: Entry = serde_json::from_slice(line).ok()?;
    let Entry::SessionInfo(info) = entry else {
        return None;
    };
    Some(cleaned_name(info.name.as_deref()))
}

/// What one line reports as the words of the user, in the shape that the scan of
/// pi uses: a user message with text in it (pinned `extractTextContent`).
pub(crate) fn first_text(line: &[u8]) -> Option<String> {
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

/// The newest conversation first, the order of the session list.
fn newest_first(summaries: &mut [SessionSummary]) {
    summaries.sort_by(|a, b| b.modified.cmp(&a.modified));
}

/// The path of a session file, or the mistake of a caller that handed in another.
///
/// # Errors
///
/// A sentence when the path is relative.
pub(crate) fn checked_session_path(path: &str) -> anyhow::Result<&str> {
    crate::host::checked_host_path(path)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const HEADER: &str =
        r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-10-02T13:45:12.345Z","cwd":"/home/pie"}"#;

    fn user_line(id: &str, timestamp: &str, millis: i64, text: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":null,"timestamp":"{timestamp}","message":{{"role":"user","content":"{text}","timestamp":{millis}}}}}"#
        )
    }

    #[test]
    fn a_summary_reads_its_header_and_first_message() {
        let modified = std::time::UNIX_EPOCH + Duration::from_millis(1_790_948_720_000);
        let lines = SessionFileLines {
            path: "/x/s.jsonl".to_string(),
            modified: Some(modified),
            header: Some(HEADER.to_string()),
            first: Some("hello there".to_string()),
            name: Some("Renamed".to_string()),
        };

        let summary = SessionSummary::of(lines).expect("a session file");

        assert_eq!(summary.id, "s1");
        assert_eq!(summary.cwd, "/home/pie");
        assert_eq!(summary.name.as_deref(), Some("Renamed"));
        assert_eq!(summary.created, "2026-10-02T13:45:12.345Z");
        assert_eq!(summary.modified, "2026-10-02T13:45:20.000Z");
        assert_eq!(summary.first_message.as_deref(), Some("hello there"));
    }

    #[test]
    fn the_file_time_is_what_modified_falls_back_to() {
        let lines = SessionFileLines {
            path: "/x/s.jsonl".to_string(),
            header: Some(HEADER.to_string()),
            ..SessionFileLines::default()
        };

        let summary = SessionSummary::of(lines).expect("a session file");

        assert_eq!(
            summary.modified, summary.created,
            "no file time leaves the header's own"
        );
    }

    #[test]
    fn a_file_without_a_session_header_is_not_a_session() {
        let lines = SessionFileLines {
            path: "/x/s.jsonl".to_string(),
            header: Some(user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")),
            ..SessionFileLines::default()
        };

        assert!(
            SessionSummary::of(lines).is_none(),
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
        assert_eq!(
            checked_session_path("/home/u/.pi/agent/sessions/x/one.jsonl").expect("absolute"),
            "/home/u/.pi/agent/sessions/x/one.jsonl"
        );
        assert!(
            checked_session_path("sessions/one.jsonl")
                .unwrap_err()
                .to_string()
                .contains("is not absolute")
        );
        assert!(
            checked_session_path("")
                .unwrap_err()
                .to_string()
                .contains("is not absolute")
        );
    }

    #[test]
    fn the_modified_time_formats_the_way_pi_stores_it() {
        assert_eq!(
            rfc3339_of_millis(1790948713000).as_deref(),
            Some("2026-10-02T13:45:13.000Z")
        );
    }
}
