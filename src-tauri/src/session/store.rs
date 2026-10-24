//! The conversation files of pi, as pie reads them.
//!
//! Pi keeps its sessions as JSONL files under `~/.pi/agent/sessions/` and has no
//! command to list them. Therefore pie reads them itself. A summary needs three
//! values: the header line, the first words of the user, and the latest name.
//! [`SessionSummary`] is that summary, and the parsers of the lines behind it live
//! here, because the format is pi's wherever the bytes come from.
//!
//! How the files are read from a machine is [`Files`]'s business; this module
//! knows only the JSONL format that pi writes and how to turn each file's lines
//! into a [`SessionSummary`].

use std::{io::SeekFrom, sync::Arc, time::SystemTime};

use camino::Utf8PathBuf;
use pi_rpc::{
    entry::Entry,
    message::{Message, UserBlock, UserContent},
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    task::JoinSet,
};

use crate::host::{AsyncReadSeek, Files};

/// The in-memory catalog of all session summaries of one machine.
#[derive(Debug, Default, Clone)]
pub struct SessionCatalog {
    sessions: Vec<SessionSummary>,
    last_scanned: Option<std::time::Instant>,
}

impl SessionCatalog {
    /// All session summaries in the catalog.
    pub fn all(&self) -> Vec<SessionSummary> {
        self.sessions.clone()
    }

    /// Looks up a session by its Pi ID.
    pub fn get(&self, id: &str) -> Option<&SessionSummary> {
        self.sessions.iter().find(|s| s.id == id)
    }

    /// Looks up a session by its file path.
    pub fn get_by_path(&self, path: &str) -> Option<&SessionSummary> {
        self.sessions.iter().find(|s| s.path == path)
    }

    /// Removes a session from the catalog by its file path.
    pub fn remove_by_path(&mut self, path: &str) {
        self.sessions.retain(|s| s.path != path);
    }

    /// Updates the catalog with a new list of session summaries.
    pub fn set(&mut self, sessions: Vec<SessionSummary>) {
        self.sessions = sessions;
        self.last_scanned = Some(std::time::Instant::now());
    }

    /// Drops every entry and the scan time, so the next read scans again.
    pub fn clear(&mut self) {
        self.sessions.clear();
        self.last_scanned = None;
    }

    /// Whether the catalog has not been populated yet.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty() && self.last_scanned.is_none()
    }
}

const HEAD_BYTES: usize = 1024 * 1024;
const READ_CHUNK: usize = 8 * 1024;
const NAME_SCAN_BYTES: u64 = 1024 * 1024;
const NAME_BLOCK: usize = 16 * 1024;

/// Reads the working directory recorded in the header of a session file.
pub(crate) async fn read_session_cwd(reader: &mut (dyn AsyncReadSeek + '_)) -> anyhow::Result<Option<String>> {
    let (header, _) = scan_head(reader).await?;
    Ok(header.map(|h| h.cwd))
}

/// Scans the summary lines of one session file using seekable asynchronous stream reads.
pub async fn read_summary(
    reader: &mut (dyn AsyncReadSeek + '_),
    path: String,
    size: Option<u64>,
    modified: Option<SystemTime>,
) -> anyhow::Result<Option<SessionSummary>> {
    let (header, first) = scan_head(reader).await?;
    let Some(header) = header else {
        return Ok(None);
    };

    let name = scan_tail_backwards(reader, size).await?;
    let modified_str = modified.and_then(rfc3339).unwrap_or_else(|| header.timestamp.clone());

    Ok(Some(SessionSummary {
        path,
        id: header.id,
        cwd: header.cwd,
        name,
        parent_session_path: header.parent_session,
        modified: modified_str,
        created: header.timestamp,
        first_message: first,
    }))
}

struct HeadScan {
    searched: usize,
    line_start: usize,
}

fn first_turn_is_whole(head: &[u8], scan: &mut HeadScan) -> bool {
    let mut found = false;
    while !found {
        let fresh = &head[scan.searched..];
        let Some(at) = memchr::memchr(b'\n', fresh) else {
            scan.searched = head.len();
            break;
        };
        let line_end = scan.searched + at;
        found = String::from_utf8_lossy(&head[scan.line_start..line_end]).contains("\"role\":\"user\"");
        scan.line_start = line_end + 1;
        scan.searched = scan.line_start;
    }
    found
}

async fn scan_head(
    reader: &mut (dyn AsyncReadSeek + '_),
) -> anyhow::Result<(Option<SessionFileHeader>, Option<String>)> {
    reader.seek(SeekFrom::Start(0)).await?;
    let mut head = Vec::new();
    let mut scan = HeadScan {
        searched: 0,
        line_start: 0,
    };
    let mut chunk = [0u8; READ_CHUNK];

    while head.len() < HEAD_BYTES {
        let room = (HEAD_BYTES - head.len()).min(READ_CHUNK);
        let read = reader.read(&mut chunk[..room]).await?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
        if first_turn_is_whole(&head, &mut scan) {
            break;
        }
    }

    let lossy = String::from_utf8_lossy(&head);
    let mut lines = lossy.lines();
    let Some(header_line) = lines.next() else {
        return Ok((None, None));
    };

    let Ok(header) = serde_json::from_str::<SessionFileHeader>(header_line) else {
        return Ok((None, None));
    };
    if header.kind != "session" {
        return Ok((None, None));
    }

    let mut first = None;
    for line in lines {
        if let Some(text) = first_text(line.as_bytes()) {
            first = Some(text);
            break;
        }
    }

    Ok((Some(header), first))
}

async fn scan_tail_backwards(
    reader: &mut (dyn AsyncReadSeek + '_),
    size: Option<u64>,
) -> anyhow::Result<Option<String>> {
    let size = match size {
        Some(size) => size,
        None => reader.seek(SeekFrom::End(0)).await?,
    };
    let budget = size.min(NAME_SCAN_BYTES);
    let mut position = size;
    let mut scanned = 0u64;
    let mut carry: Vec<u8> = Vec::new();

    while scanned < budget {
        let block = NAME_BLOCK.min((budget - scanned) as usize);
        position -= block as u64;
        reader.seek(SeekFrom::Start(position)).await?;

        let mut suffix = vec![0u8; block];
        let mut filled = 0;
        while filled < block {
            let read = reader.read(&mut suffix[filled..]).await?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        suffix.truncate(filled);
        suffix.extend_from_slice(&carry);
        scanned += block as u64;

        let mut end = suffix.len();
        loop {
            let Some(line_end) = memchr::memrchr(b'\n', &suffix[..end]) else {
                carry = suffix[..end].to_vec();
                break;
            };
            let line = &suffix[line_end + 1..end];
            end = line_end;
            if let Some(name) = name_in(line) {
                return Ok(name);
            }
        }
    }
    Ok(None)
}

fn sessions_root(home: Option<&str>) -> Option<Utf8PathBuf> {
    home.map(|h| Utf8PathBuf::from(h).join(".pi").join("agent").join("sessions"))
}

/// Every conversation that pi wrote on `host`, the newest first.
///
/// # Errors
///
/// A sentence when the files cannot be read, with the path at fault in it.
pub(crate) async fn summaries(files: Arc<dyn Files>) -> anyhow::Result<Vec<SessionSummary>> {
    let home = files.home_dir().await?;
    let Some(root) = sessions_root(home.as_deref()) else {
        return Ok(Vec::new());
    };
    let projects = match files.read_dir(root.as_str()).await {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };

    let mut candidates = Vec::new();
    for project in projects {
        if !project.is_dir {
            continue;
        }
        let Ok(entries) = files.read_dir(&project.path).await else {
            continue;
        };
        for file in entries {
            if file.name.ends_with(".jsonl") {
                candidates.push(file);
            }
        }
    }

    let mut set = JoinSet::new();
    let mut pending = candidates.into_iter();
    let mut list = Vec::new();
    const MAX_CONCURRENT_LOADS: usize = 10;

    loop {
        while set.len() < MAX_CONCURRENT_LOADS {
            let Some(candidate) = pending.next() else { break };
            let files = Arc::clone(&files);
            set.spawn(async move {
                let mut reader = files.open(&candidate.path).await.ok()?;
                read_summary(&mut *reader, candidate.path, candidate.size, candidate.modified)
                    .await
                    .ok()
                    .flatten()
            });
        }
        if set.is_empty() {
            break;
        }
        if let Some(Ok(Some(summary))) = set.join_next().await {
            list.push(summary);
        }
    }

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
    #[cfg(test)]
    fn of(lines: tests::TestLines) -> Option<SessionSummary> {
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const HEADER: &str =
        r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-10-02T13:45:12.345Z","cwd":"/home/pie"}"#;

    #[derive(Debug, Default)]
    pub(super) struct TestLines {
        pub path: String,
        pub modified: Option<SystemTime>,
        pub header: Option<String>,
        pub first: Option<String>,
        pub name: Option<String>,
    }

    fn user_line(id: &str, timestamp: &str, millis: i64, text: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":null,"timestamp":"{timestamp}","message":{{"role":"user","content":"{text}","timestamp":{millis}}}}}"#
        )
    }

    #[test]
    fn a_summary_reads_its_header_and_first_message() {
        let modified = std::time::UNIX_EPOCH + Duration::from_millis(1_790_948_720_000);
        let lines = TestLines {
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
        let lines = TestLines {
            path: "/x/s.jsonl".to_string(),
            header: Some(HEADER.to_string()),
            ..TestLines::default()
        };

        let summary = SessionSummary::of(lines).expect("a session file");

        assert_eq!(
            summary.modified, summary.created,
            "no file time leaves the header's own"
        );
    }

    #[test]
    fn a_file_without_a_session_header_is_not_a_session() {
        let lines = TestLines {
            path: "/x/s.jsonl".to_string(),
            header: Some(user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")),
            ..TestLines::default()
        };

        assert!(
            SessionSummary::of(lines).is_none(),
            "pi's own scan drops files whose first entry is not a header"
        );
    }

    #[tokio::test]
    async fn read_summary_stream_extracts_header_and_first_turn_and_backward_rename() {
        let content = format!(
            "{HEADER}\n{}\n{}\n",
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hello stream"),
            r#"{"type":"session_info","id":"s1","parentId":null,"timestamp":"2026-10-02T13:50:00.000Z","name":"Stream Session"}"#
        );
        let mut cursor = std::io::Cursor::new(content.into_bytes());
        let summary = read_summary(&mut cursor, "/path/s.jsonl".to_string(), None, None)
            .await
            .expect("read_summary")
            .expect("summary present");

        assert_eq!(summary.id, "s1");
        assert_eq!(summary.cwd, "/home/pie");
        assert_eq!(summary.name.as_deref(), Some("Stream Session"));
        assert_eq!(summary.first_message.as_deref(), Some("hello stream"));
    }

    #[test]
    fn text_parts_are_joined_the_way_pi_reads_them() {
        let line = r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":[{"type":"text","text":"one"},{"type":"image","data":"AAAA","mimeType":"image/png"},{"type":"text","text":"two"}],"timestamp":1790948713000}}"#;

        assert_eq!(first_text(line.as_bytes()).as_deref(), Some("one two"));
    }

    #[test]
    fn the_modified_time_formats_the_way_pi_stores_it() {
        assert_eq!(
            rfc3339_of_millis(1790948713000).as_deref(),
            Some("2026-10-02T13:45:13.000Z")
        );
    }
}
