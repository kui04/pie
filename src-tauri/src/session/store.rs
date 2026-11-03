//! The conversation files of a machine, as the catalog reads them.

use std::io::SeekFrom;

use anyhow::Context;
use futures::{StreamExt, stream};
use pi_rpc::response::SessionState;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, BufReader};
use typed_path::{Utf8TypedPath, Utf8TypedPathBuf};

use crate::host::executor::OsFamily;
use crate::host::fs::{FileMetadata, FileOpenOptions, FileSystem, typed};
use crate::session::SessionId;

/// Maximum number of session files inspected at one time.
const MAX_CONCURRENT_FILES: usize = 10;

/// Bytes per backward step when the tail of a session file is read.
const TAIL_CHUNK_SIZE: u64 = 16 * 1024;

/// Largest tail window searched for a `session_info` rename once activity is known.
const MAX_TAIL_NAME_WINDOW: u64 = 64 * 1024;

/// Largest window read from the head or the tail of one session file.
const MAX_SCAN_WINDOW: u64 = 4 * 1024 * 1024;

/// One conversation of a machine.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: SessionId,
    pub cwd: Option<Utf8TypedPathBuf>,
    pub path: Utf8TypedPathBuf,
    pub title: SessionTitle,
    pub parent_path: Option<Utf8TypedPathBuf>,
    pub created_at: jiff::Timestamp,
    pub modified_at: jiff::Timestamp,
    pub first_prompt: Option<String>,
}

/// How a conversation is named, and who named it.
///
/// A person may name a conversation, and pi may derive one from the first thing a
/// person asked. The two look the same on screen and differ on rename, so the
/// difference is a variant, not an `Option` that hides it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionTitle {
    /// A person named this conversation.
    Named { name: String },
    /// No name was chosen, so the first prompt is the label.
    FromFirstPrompt,
    /// No name was chosen and no prompt was read.
    Untitled,
}

impl SessionTitle {
    /// The title a rename leaves behind: the chosen name, or what an empty name
    /// falls back to.
    pub(crate) fn renamed(name: &str, first_prompt: Option<&str>) -> Self {
        if name.is_empty() {
            title_of(TailName::Cleared, first_prompt)
        } else {
            title_of(TailName::Named(name.to_owned()), first_prompt)
        }
    }
}

impl SessionInfo {
    /// Updates scanned metadata with live state returned by `pi` RPC `get_state` after attach.
    ///
    /// The conversation file is the identity of a session, so this never takes the
    /// file pi reports: pi may spell the same file another way.
    pub(crate) fn apply_rpc_state(&mut self, state: &SessionState) {
        if !state.session_id.is_empty() {
            self.id = SessionId::new(state.session_id.clone());
        }
        if let Some(name) = state
            .session_name
            .as_deref()
            .filter(|name| !name.is_empty())
        {
            self.title = SessionTitle::Named {
                name: name.to_owned(),
            };
        }
    }
}

/// What the head of a session file says.
#[derive(Debug, Clone)]
pub(crate) struct HeadSummary {
    pub id: SessionId,
    pub cwd: Option<Utf8TypedPathBuf>,
    pub parent_path: Option<Utf8TypedPathBuf>,
    pub created_at: Option<jiff::Timestamp>,
    pub first_prompt: Option<String>,
}

/// What the tail of a session file says.
#[derive(Debug, Clone, Default)]
pub(crate) struct TailSummary {
    pub name: TailName,
    pub last_activity: Option<jiff::Timestamp>,
}

/// The name the latest `session_info` entry gives a conversation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) enum TailName {
    /// No `session_info` entry in the scanned window.
    #[default]
    Unknown,
    /// The latest `session_info` entry clears the name.
    Cleared,
    /// The latest `session_info` entry names the conversation.
    Named(String),
}

/// Scans `<home>/.pi/agent/sessions/...` with bounded concurrency, sorted by `modified_at` descending.
pub(crate) async fn load_catalog<F>(fs: &F, family: OsFamily) -> anyhow::Result<Vec<SessionInfo>>
where
    F: FileSystem,
{
    let home = fs
        .home_dir()
        .await
        .context("cannot find the home directory of this machine")?;
    let root = home.join(".pi").join("agent").join("sessions");

    let mut files = Vec::new();
    collect_session_files(fs, root.to_path(), &mut files).await;

    let scanned: Vec<Option<SessionInfo>> = stream::iter(files)
        .map(|entry| async move {
            match scan_session_file(fs, &entry, family).await {
                Ok(info) => Some(info),
                Err(error) => {
                    // A machine holds files pie did not write, and pi skips them too.
                    tracing::debug!(%error, path = %entry.path, "a session file was skipped");
                    None
                }
            }
        })
        .buffer_unordered(MAX_CONCURRENT_FILES)
        .collect()
        .await;

    let mut results: Vec<SessionInfo> = scanned.into_iter().flatten().collect();
    results.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.path.as_str().cmp(b.path.as_str()))
    });
    Ok(results)
}

async fn collect_session_files<F>(fs: &F, dir: Utf8TypedPath<'_>, out: &mut Vec<FileMetadata>)
where
    F: FileSystem,
{
    let Ok(entries) = fs.read_dir(dir).await else {
        return;
    };

    // pi keeps one directory per project: `<sessions>/--<cwd>--/<time>_<id>.jsonl`.
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        if entry.is_dir {
            dirs.push(entry.path);
        } else {
            files.push(entry);
        }
    }
    for dir in dirs {
        if let Ok(children) = fs.read_dir(dir.to_path()).await {
            files.extend(children);
        }
    }

    out.extend(files.into_iter().filter(|entry| {
        entry.is_file && matches!(entry.path.to_path().extension(), Some("jsonl"))
    }));
}

/// Scans the head and tail of a single session file over one handle.
pub(crate) async fn scan_session_file<F>(
    fs: &F,
    entry: &FileMetadata,
    family: OsFamily,
) -> anyhow::Result<SessionInfo>
where
    F: FileSystem,
{
    let mut options = FileOpenOptions::new();
    options.read(true);

    let mut file = fs
        .open_file(entry.path.to_path(), options)
        .await
        .with_context(|| format!("cannot open `{}`", entry.path))?;

    // The listing is a snapshot: pi can append before this file is read.
    let file_len = file
        .seek(SeekFrom::End(0))
        .await
        .with_context(|| format!("cannot measure `{}`", entry.path))?;
    file.seek(SeekFrom::Start(0))
        .await
        .with_context(|| format!("cannot seek `{}`", entry.path))?;

    let head = scan_head(&mut file, family)
        .await
        .with_context(|| format!("cannot scan `{}`", entry.path))?
        .with_context(|| format!("`{}` does not start with a session header", entry.path))?;
    let tail = scan_tail(&mut file, file_len)
        .await
        .with_context(|| format!("cannot scan `{}`", entry.path))?;

    let file_modified = entry
        .modified
        .and_then(|time| jiff::Timestamp::try_from(time).ok());
    let file_created = entry
        .created
        .or(entry.modified)
        .and_then(|time| jiff::Timestamp::try_from(time).ok());

    let modified_at = tail
        .last_activity
        .or(head.created_at)
        .or(file_modified)
        .unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    let created_at = head
        .created_at
        .or(file_created)
        .unwrap_or(jiff::Timestamp::UNIX_EPOCH);

    let title = title_of(tail.name, head.first_prompt.as_deref());

    Ok(SessionInfo {
        id: head.id,
        cwd: head.cwd,
        path: entry.path.clone(),
        title,
        parent_path: head.parent_path,
        created_at,
        modified_at,
        first_prompt: head.first_prompt,
    })
}

/// How the label of a conversation follows from its scan.
///
/// A name a person chose wins. Without one, a cleared name and a name that was
/// never chosen fall back to the first prompt; there is nothing else to fall back to.
fn title_of(name: TailName, first_prompt: Option<&str>) -> SessionTitle {
    match name {
        TailName::Named(name) => SessionTitle::Named { name },
        TailName::Cleared | TailName::Unknown if first_prompt.is_some() => {
            SessionTitle::FromFirstPrompt
        }
        TailName::Cleared | TailName::Unknown => SessionTitle::Untitled,
    }
}

/// Reads the header and the first user message, or `None` when the file is no session.
async fn scan_head<R>(reader: &mut R, family: OsFamily) -> anyhow::Result<Option<HeadSummary>>
where
    R: AsyncRead + Unpin,
{
    let limited = reader.take(MAX_SCAN_WINDOW);
    let mut buf_reader = BufReader::new(limited);
    let mut line = Vec::new();
    let mut header = None;
    let mut first_prompt = None;

    loop {
        line.clear();
        if buf_reader.read_until(b'\n', &mut line).await? == 0 {
            break;
        }

        let Ok(entry) = serde_json::from_slice::<Value>(&line) else {
            // pi skips a blank or unreadable line while it looks for the header.
            continue;
        };

        if header.is_none() {
            header = session_header(&entry, family);
            if header.is_none() {
                return Ok(None);
            }
            continue;
        }

        if first_prompt.is_none() {
            first_prompt = user_prompt(&entry);
        }
        if first_prompt.is_some() {
            break;
        }
    }

    Ok(header.map(|mut header| {
        header.first_prompt = first_prompt;
        header
    }))
}

/// The header a session file starts with, when `entry` is one.
fn session_header(entry: &Value, family: OsFamily) -> Option<HeadSummary> {
    if entry.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;

    Some(HeadSummary {
        id: SessionId::new(id),
        cwd: entry
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
            .map(|cwd| typed(cwd, family)),
        parent_path: entry
            .get("parentSession")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
            .map(|path| typed(path, family)),
        created_at: entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|timestamp| timestamp.parse().ok()),
        first_prompt: None,
    })
}

async fn scan_tail<R>(reader: &mut R, file_len: u64) -> anyhow::Result<TailSummary>
where
    R: AsyncRead + AsyncSeek + Unpin,
{
    scan_tail_in_chunks(reader, file_len, TAIL_CHUNK_SIZE).await
}

/// Reads the tail of a file backward, one chunk at a time, until the name and the activity are known.
async fn scan_tail_in_chunks<R>(
    reader: &mut R,
    file_len: u64,
    chunk: u64,
) -> anyhow::Result<TailSummary>
where
    R: AsyncRead + AsyncSeek + Unpin,
{
    let mut summary = TailSummary::default();
    let mut end = file_len;
    let mut scanned = 0u64;
    let mut carry = Vec::new();

    while end > 0 && scanned < MAX_SCAN_WINDOW {
        let start = end.saturating_sub(chunk);
        scanned += end - start;

        reader.seek(SeekFrom::Start(start)).await?;
        let mut buf = vec![0u8; usize::try_from(end - start)?];
        reader.read_exact(&mut buf).await?;
        buf.extend_from_slice(&carry);

        // Bytes, not text: a chunk boundary can cut a character in two.
        let mut lines = buf.split(|byte| *byte == b'\n');
        let first = lines.next().unwrap_or_default();
        if start > 0 {
            carry = first.to_vec();
        } else {
            carry.clear();
        }

        for line in lines.rev() {
            read_tail_line(line, &mut summary);
        }
        if start == 0 {
            read_tail_line(first, &mut summary);
        }

        if summary.last_activity.is_some()
            && (summary.name != TailName::Unknown || scanned >= MAX_TAIL_NAME_WINDOW)
        {
            break;
        }
        end = start;
    }

    Ok(summary)
}

/// Reads one line of the tail, newest first, and keeps what it tells.
fn read_tail_line(line: &[u8], summary: &mut TailSummary) {
    let line = line.trim_ascii();
    if line.is_empty() {
        return;
    }
    let Ok(entry) = serde_json::from_slice::<Value>(line) else {
        return;
    };

    if summary.name == TailName::Unknown
        && let Some(name) = name_update(&entry)
    {
        summary.name = name;
    }
    if summary.last_activity.is_none() {
        summary.last_activity = message_activity(&entry);
    }
}

/// The name a `session_info` entry gives, or `None` when the entry is another kind.
fn name_update(entry: &Value) -> Option<TailName> {
    if entry.get("type").and_then(Value::as_str) != Some("session_info") {
        return None;
    }
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty());

    Some(name.map_or(TailName::Cleared, |name| TailName::Named(name.to_owned())))
}

/// When `entry` moved the conversation: a message from a person or the model.
fn message_activity(entry: &Value) -> Option<jiff::Timestamp> {
    if entry.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = entry.get("message")?;
    let role = message.get("role").and_then(Value::as_str)?;
    if !matches!(role, "user" | "assistant") || message.get("content").is_none() {
        return None;
    }

    if let Some(millis) = message.get("timestamp").and_then(Value::as_i64) {
        return jiff::Timestamp::from_millisecond(millis).ok();
    }
    entry
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|timestamp| timestamp.parse().ok())
}

/// The text of the first user message, when `entry` is one.
fn user_prompt(entry: &Value) -> Option<String> {
    if entry.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = entry.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = message.get("content")?;

    if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    for item in content.as_array()? {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::io::SeekFrom;

    use serde_json::json;
    use tempfile::TempDir;
    use tokio::fs::File;

    use super::*;

    async fn file_of_bytes(content: &[u8]) -> (TempDir, File, u64) {
        let dir = TempDir::new().expect("a temporary directory");
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, content).expect("a writable file");
        let mut file = File::open(&path).await.expect("a readable file");
        let len = file
            .seek(SeekFrom::End(0))
            .await
            .expect("a measurable file");
        file.seek(SeekFrom::Start(0))
            .await
            .expect("a readable file");
        (dir, file, len)
    }

    async fn file_of_lines(lines: &[&str]) -> (TempDir, File, u64) {
        file_of_bytes(format!("{}\n", lines.join("\n")).as_bytes()).await
    }

    #[tokio::test]
    async fn the_header_names_the_session() {
        let (_dir, mut file, _len) = file_of_lines(&[
            r#"{"type":"session","version":3,"id":"0193","timestamp":"2025-09-01T10:00:00.000Z","cwd":"/work","parentSession":"/h/.pi/agent/sessions/--work--/2025-08-01T10-00-00-000Z_0192.jsonl"}"#,
            r#"{"type":"message","id":"a","parentId":null,"timestamp":"2025-09-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"fix the bug"}]}}"#,
        ])
        .await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");

        assert_eq!(head.id.as_str(), "0193");
        assert_eq!(head.cwd.as_ref().map(|cwd| cwd.as_str()), Some("/work"));
        assert_eq!(
            head.parent_path.as_ref().map(|path| path.as_str()),
            Some("/h/.pi/agent/sessions/--work--/2025-08-01T10-00-00-000Z_0192.jsonl")
        );
        assert_eq!(head.first_prompt.as_deref(), Some("fix the bug"));
        assert_eq!(
            head.created_at.expect("a header time").to_string(),
            "2025-09-01T10:00:00Z"
        );
    }

    #[tokio::test]
    async fn a_file_of_another_kind_is_no_session() {
        let (_dir, mut file, _len) = file_of_lines(&[
            r#"{"type":"session_info","name":"x"}"#,
            r#"{"type":"session","id":"0193"}"#,
        ])
        .await;

        assert!(
            scan_head(&mut file, OsFamily::Unix)
                .await
                .expect("a readable file")
                .is_none()
        );
    }

    #[tokio::test]
    async fn blank_and_broken_lines_do_not_hide_the_header() {
        let (_dir, mut file, _len) =
            file_of_lines(&["", "not JSON", r#"{"type":"session","id":"0193"}"#]).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");

        assert_eq!(head.id.as_str(), "0193");
    }

    #[tokio::test]
    async fn an_empty_cwd_names_no_place() {
        let (_dir, mut file, _len) =
            file_of_lines(&[r#"{"type":"session","id":"0193","cwd":""}"#]).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");

        assert_eq!(head.cwd, None);
    }

    #[tokio::test]
    async fn the_first_prompt_is_the_first_user_message() {
        let (_dir, mut file, _len) = file_of_lines(&[
            r#"{"type":"session","id":"0193"}"#,
            r#"{"type":"message","message":{"role":"assistant","content":"hello"}}"#,
            r#"{"type":"message","message":{"role":"user","content":"fix the bug"}}"#,
        ])
        .await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");

        assert_eq!(head.first_prompt.as_deref(), Some("fix the bug"));
    }

    #[tokio::test]
    async fn the_latest_name_wins() {
        let (_dir, mut file, len) = file_of_lines(&[
            r#"{"type":"session","id":"0193"}"#,
            r#"{"type":"session_info","name":"old"}"#,
            r#"{"type":"session_info","name":"new"}"#,
        ])
        .await;

        let tail = scan_tail(&mut file, len).await.expect("a readable file");

        assert_eq!(tail.name, TailName::Named("new".to_owned()));
    }

    #[tokio::test]
    async fn an_empty_name_clears_the_title() {
        let (_dir, mut file, len) = file_of_lines(&[
            r#"{"type":"session","id":"0193"}"#,
            r#"{"type":"session_info","name":"old"}"#,
            r#"{"type":"session_info","name":""}"#,
        ])
        .await;

        let tail = scan_tail(&mut file, len).await.expect("a readable file");

        assert_eq!(tail.name, TailName::Cleared);
    }

    #[tokio::test]
    async fn no_name_entry_leaves_the_name_unknown() {
        let (_dir, mut file, len) = file_of_lines(&[
            r#"{"type":"session","id":"0193"}"#,
            r#"{"type":"message","message":{"role":"user","content":"hello"}}"#,
        ])
        .await;

        let tail = scan_tail(&mut file, len).await.expect("a readable file");

        assert_eq!(tail.name, TailName::Unknown);
    }

    #[tokio::test]
    async fn the_last_message_dates_the_conversation() {
        let (_dir, mut file, len) = file_of_lines(&[
            r#"{"type":"session","id":"0193","timestamp":"2025-09-01T10:00:00.000Z"}"#,
            r#"{"type":"message","timestamp":"2025-09-02T10:00:00.000Z","message":{"role":"assistant","content":"done"}}"#,
            r#"{"type":"session_info","name":"renamed"}"#,
        ])
        .await;

        let tail = scan_tail(&mut file, len).await.expect("a readable file");

        assert_eq!(tail.name, TailName::Named("renamed".to_owned()));
        assert_eq!(
            tail.last_activity.expect("a message time").to_string(),
            "2025-09-02T10:00:00Z"
        );
    }

    #[tokio::test]
    async fn a_message_time_in_milliseconds_dates_the_conversation() {
        let activity =
            jiff::Timestamp::from_millisecond(1_757_000_000_000).expect("a message time");
        let (_dir, mut file, len) = file_of_lines(&[
            r#"{"type":"session","id":"0193"}"#,
            r#"{"type":"message","message":{"role":"user","content":"hi","timestamp":1757000000000}}"#,
        ])
        .await;

        let tail = scan_tail(&mut file, len).await.expect("a readable file");

        assert_eq!(tail.last_activity, Some(activity));
    }

    #[tokio::test]
    async fn a_character_across_a_chunk_boundary_keeps_its_line() {
        let line = r#"{"type":"session_info","name":"日本語の名前"}"#;
        let split = line.find('日').expect("a wide character");
        let chunk = u64::try_from(line.len() - (split + 1)).expect("a chunk size");

        let (_dir, mut file, len) = file_of_lines(&[line]).await;

        // The first chunk starts one byte inside the first wide character.
        let tail = scan_tail_in_chunks(&mut file, len, chunk)
            .await
            .expect("a readable file");

        assert_eq!(tail.name, TailName::Named("日本語の名前".to_owned()));
    }

    #[test]
    fn a_chosen_name_is_the_title_and_a_prompt_is_only_a_fallback() {
        assert_eq!(
            title_of(TailName::Named("chosen".to_owned()), Some("first")),
            SessionTitle::Named {
                name: "chosen".to_owned()
            }
        );
        assert_eq!(
            title_of(TailName::Unknown, Some("first")),
            SessionTitle::FromFirstPrompt
        );
        assert_eq!(
            title_of(TailName::Cleared, Some("first")),
            SessionTitle::FromFirstPrompt
        );
        assert_eq!(title_of(TailName::Cleared, None), SessionTitle::Untitled);
        assert_eq!(title_of(TailName::Unknown, None), SessionTitle::Untitled);
    }

    #[test]
    fn a_title_says_on_the_wire_who_named_it() {
        let chosen = serde_json::to_value(SessionTitle::Named {
            name: "one".to_owned(),
        })
        .expect("a title serializes");
        assert_eq!(
            chosen,
            serde_json::json!({ "type": "named", "name": "one" })
        );

        let derived =
            serde_json::to_value(SessionTitle::FromFirstPrompt).expect("a title serializes");
        assert_eq!(derived, serde_json::json!({ "type": "from_first_prompt" }));
    }

    #[test]
    fn a_parent_path_keeps_the_shape_of_its_machine() {
        for (family, parent) in [
            (
                OsFamily::Unix,
                "/home/my_user/.pi/agent/sessions/--home-my_user--/2025-09-01T10-00-00-000Z_0193.jsonl",
            ),
            (
                OsFamily::Windows,
                r"C:\Users\my_user\.pi\agent\sessions\--C--Users-my_user--\2025-09-01T10-00-00-000Z_0193.jsonl",
            ),
        ] {
            let entry =
                serde_json::json!({ "type": "session", "id": "0193", "parentSession": parent });

            let head = session_header(&entry, family).expect("a session");

            assert_eq!(
                head.parent_path.as_ref().map(|path| path.as_str()),
                Some(parent)
            );
        }
    }

    fn live_state(session_name: Option<&str>) -> SessionState {
        let mut state = json!({
            "thinkingLevel": "low",
            "isStreaming": false,
            "isCompacting": false,
            "steeringMode": "all",
            "followUpMode": "one-at-a-time",
            "sessionId": "new",
            "messageCount": 0,
            "pendingMessageCount": 0,
            "autoCompactionEnabled": true,
        });
        if let Some(name) = session_name {
            state["sessionName"] = json!(name);
        }
        serde_json::from_value(state).expect("a session state")
    }

    fn session_info() -> SessionInfo {
        SessionInfo {
            id: SessionId::new("old"),
            cwd: None,
            path: typed("/home/u/.pi/agent/sessions/a.jsonl", OsFamily::Unix),
            title: SessionTitle::FromFirstPrompt,
            parent_path: None,
            created_at: jiff::Timestamp::UNIX_EPOCH,
            modified_at: jiff::Timestamp::UNIX_EPOCH,
            first_prompt: Some("fix the bug".to_owned()),
        }
    }

    #[test]
    fn live_state_names_the_session_and_leaves_an_empty_name_alone() {
        let mut info = session_info();

        info.apply_rpc_state(&live_state(Some("")));
        assert_eq!(info.id.as_str(), "new");
        assert_eq!(info.title, SessionTitle::FromFirstPrompt);

        info.apply_rpc_state(&live_state(Some("chosen")));
        assert_eq!(
            info.title,
            SessionTitle::Named {
                name: "chosen".to_owned(),
            }
        );

        info.apply_rpc_state(&live_state(None));
        assert_eq!(
            info.title,
            SessionTitle::Named {
                name: "chosen".to_owned(),
            }
        );
    }

    #[test]
    fn a_rename_falls_back_to_the_prompt_only_when_the_name_is_cleared() {
        assert_eq!(
            SessionTitle::renamed("", Some("fix")),
            SessionTitle::FromFirstPrompt
        );
        assert_eq!(SessionTitle::renamed("", None), SessionTitle::Untitled);
        assert_eq!(
            SessionTitle::renamed("chosen", Some("fix")),
            SessionTitle::Named {
                name: "chosen".to_owned(),
            }
        );
    }

    #[test]
    fn only_a_message_from_a_person_or_the_model_moves_the_conversation() {
        let when = "2025-09-01T10:00:00.000Z";
        for role in ["user", "assistant"] {
            let entry = json!({
                "type": "message",
                "timestamp": when,
                "message": { "role": role, "content": "hi" },
            });

            assert!(message_activity(&entry).is_some(), "{role}");
        }

        for entry in [
            json!({ "type": "message", "timestamp": when, "message": { "role": "system", "content": "x" } }),
            json!({ "type": "message", "timestamp": when, "message": { "role": "toolResult", "content": "x" } }),
            json!({ "type": "message", "timestamp": when, "message": { "role": "user" } }),
            json!({ "type": "session_info", "timestamp": when }),
        ] {
            assert_eq!(message_activity(&entry), None, "{entry}");
        }
    }

    #[test]
    fn a_message_time_comes_from_milliseconds_or_from_text() {
        let millis = 1_757_000_000_000_i64;
        let entry = json!({
            "type": "message",
            "message": { "role": "user", "content": "hi", "timestamp": millis },
        });
        assert_eq!(
            message_activity(&entry),
            jiff::Timestamp::from_millisecond(millis).ok()
        );

        let entry = json!({
            "type": "message",
            "timestamp": "2025-09-01T10:00:00.000Z",
            "message": { "role": "user", "content": "hi" },
        });
        assert_eq!(
            message_activity(&entry),
            Some("2025-09-01T10:00:00Z".parse().expect("a timestamp"))
        );

        let entry = json!({
            "type": "message",
            "message": { "role": "user", "content": "hi", "timestamp": i64::MAX },
        });
        assert_eq!(message_activity(&entry), None);
    }

    #[test]
    fn a_prompt_reads_text_and_text_parts_and_ignores_the_rest() {
        let text = json!({
            "type": "message",
            "message": { "role": "user", "content": "  fix the bug  " },
        });
        assert_eq!(user_prompt(&text).as_deref(), Some("fix the bug"));

        let parts = json!({
            "type": "message",
            "message": {
                "role": "user",
                "content": [
                    { "type": "image" },
                    { "type": "text", "text": "  from a part  " },
                ],
            },
        });
        assert_eq!(user_prompt(&parts).as_deref(), Some("from a part"));

        for entry in [
            json!({ "type": "message", "message": { "role": "user", "content": "   " } }),
            json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "image" }] } }),
            json!({ "type": "message", "message": { "role": "assistant", "content": "hello" } }),
            json!({ "type": "session_info", "message": { "role": "user", "content": "hello" } }),
        ] {
            assert_eq!(user_prompt(&entry), None, "{entry}");
        }
    }

    #[tokio::test]
    async fn a_name_beyond_the_tail_window_is_not_found() {
        let long = "x".repeat(70 * 1024);
        let long_message =
            format!(r#"{{"type":"message","message":{{"role":"assistant","content":"{long}"}}}}"#);
        let (_dir, mut file, len) = file_of_lines(&[
            r#"{"type":"session_info","name":"old"}"#,
            long_message.as_str(),
            r#"{"type":"message","timestamp":"2025-09-01T10:00:00.000Z","message":{"role":"assistant","content":"done"}}"#,
        ])
        .await;

        let tail = scan_tail_in_chunks(&mut file, len, 16 * 1024)
            .await
            .expect("a readable file");

        assert_eq!(tail.name, TailName::Unknown);
        assert!(
            tail.last_activity.is_some(),
            "the last message is still read"
        );
    }

    #[test]
    fn a_header_without_an_id_is_no_session() {
        for entry in [
            json!({ "type": "session" }),
            json!({ "type": "session", "id": "" }),
            json!({ "type": "session", "id": 7 }),
        ] {
            assert!(session_header(&entry, OsFamily::Unix).is_none(), "{entry}");
        }
    }

    fn recorded(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/sessions")
            .join(name);

        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read `{}`: {error}", path.display()))
    }

    #[tokio::test]
    async fn a_recorded_mock_session_reads_its_header_and_name() {
        let content = recorded("mock/hello.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.id.as_str(), "01a19fc3-dfe6-7702-ad80-d5d9ca4d049b");
        assert_eq!(
            head.cwd.as_ref().map(|cwd| cwd.as_str()),
            Some("/home/pi/work")
        );
        assert_eq!(head.first_prompt.as_deref(), Some("hello"));

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Named("hello".to_owned()));
        assert!(tail.last_activity.is_some());
    }

    #[tokio::test]
    async fn a_recorded_tool_session_keeps_the_result_out_of_the_prompt() {
        let content = recorded("mock/tool.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.first_prompt.as_deref(), Some("tool"));

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Named("tool".to_owned()));
        assert!(tail.last_activity.is_some());
        assert!(
            content.contains(r#""role":"toolResult""#),
            "the fixture holds a tool result"
        );
    }

    #[tokio::test]
    async fn a_recorded_swe_bench_session_reads_as_a_long_run() {
        let content = recorded("real/axios-formdata.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.id.as_str(), "01a1a009-7c26-7230-ad6d-1c6ccf0e64ed");
        assert_eq!(
            head.cwd.as_ref().map(|cwd| cwd.as_str()),
            Some("/home/pi/work/axios-5316")
        );
        assert!(
            head.first_prompt.as_deref().is_some_and(
                |prompt| prompt.starts_with("The repository has a failing regression test")
            ),
            "{:?}",
            head.first_prompt
        );

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        // The session's only `session_info` sits at the head, beyond the 64 KiB
        // tail window, so the catalog falls back to the first prompt.
        assert_eq!(tail.name, TailName::Unknown);
        assert!(tail.last_activity.is_some());

        let mut user_turns = 0;
        let mut tools = Vec::new();
        let mut thinking = None;
        for line in content.lines() {
            let entry: Value = serde_json::from_str(line).expect("a record");
            if entry.get("type").and_then(Value::as_str) == Some("thinking_level_change") {
                thinking = entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            if entry.pointer("/message/role").and_then(Value::as_str) == Some("user") {
                user_turns += 1;
            }
            let Some(items) = entry.pointer("/message/content").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("toolCall")
                    && let Some(name) = item.get("name").and_then(Value::as_str)
                {
                    tools.push(name.to_owned());
                }
            }
        }

        assert_eq!(user_turns, 1);
        assert!(tools.len() >= 40, "{} tool calls", tools.len());
        assert!(tools.iter().any(|tool| tool == "bash"), "{tools:?}");
        assert_eq!(thinking.as_deref(), Some("xhigh"));
        assert!(content.contains("SpecCompliant FormData"));
        assert!(content.contains("1 passing"));
    }

    #[tokio::test]
    async fn a_late_rename_wins_over_the_first_prompt() {
        let content = recorded("mock/renamed.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.first_prompt.as_deref(), Some("hello"));

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Named("renamed".to_owned()));
    }

    #[tokio::test]
    async fn a_cleared_name_falls_back_to_the_first_prompt() {
        let content = recorded("edge/cleared-name.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.first_prompt.as_deref(), Some("hello"));

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Cleared);
    }

    #[tokio::test]
    async fn a_forked_session_keeps_its_parent() {
        let content = recorded("mock/forked.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert!(
            head.parent_path
                .as_ref()
                .is_some_and(|parent| parent.as_str().ends_with(".jsonl")),
            "{:?}",
            head.parent_path
        );
        assert_eq!(head.first_prompt.as_deref(), Some("hello"));

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Named("forked".to_owned()));
    }

    #[tokio::test]
    async fn a_header_only_session_has_no_prompt() {
        let content = recorded("edge/header-only.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(
            head.cwd.as_ref().map(|cwd| cwd.as_str()),
            Some("/home/pi/work")
        );
        assert_eq!(head.first_prompt, None);

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Unknown);
        assert_eq!(tail.last_activity, None);
    }

    #[tokio::test]
    async fn a_truncated_tail_line_is_dropped() {
        let content = recorded("edge/truncated.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.first_prompt.as_deref(), Some("hello"));

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Named("hello".to_owned()));
        assert!(tail.last_activity.is_some());

        let last = content.lines().last().expect("a last line");
        assert!(
            serde_json::from_str::<Value>(last).is_err(),
            "the fixture ends mid-line"
        );
    }

    #[tokio::test]
    async fn a_recorded_ask_session_keeps_the_tool_result_out_of_the_prompt() {
        let content = recorded("mock/ask.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.first_prompt.as_deref(), Some("ask"));

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Named("ask".to_owned()));
        assert!(content.contains(r#""name":"ask_user""#));
        assert!(content.contains(r#""role":"toolResult""#));
    }

    #[tokio::test]
    async fn a_recorded_vue_vpre_session_reads_as_a_long_run() {
        let content = recorded("real/vue-vpre.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(
            head.cwd.as_ref().map(|cwd| cwd.as_str()),
            Some("/home/pi/work/vue-11915")
        );
        assert!(
            head.first_prompt
                .as_deref()
                .is_some_and(|prompt| prompt.starts_with("Read ISSUE.md")),
            "{:?}",
            head.first_prompt
        );

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Unknown);
        assert!(tail.last_activity.is_some());

        let mut tools = 0;
        let mut thinking = None;
        for line in content.lines() {
            let entry: Value = serde_json::from_str(line).expect("a record");
            if entry.get("type").and_then(Value::as_str) == Some("thinking_level_change") {
                thinking = entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            let Some(items) = entry.pointer("/message/content").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("toolCall") {
                    tools += 1;
                }
            }
        }

        assert!(tools >= 30, "{tools} tool calls");
        assert_eq!(thinking.as_deref(), Some("xhigh"));
        assert!(content.contains("3 passed"));
        assert!(content.contains("636"));
    }

    #[tokio::test]
    async fn a_recorded_vue_watch_session_reads_as_a_long_run() {
        let content = recorded("real/vue-watch.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(
            head.cwd.as_ref().map(|cwd| cwd.as_str()),
            Some("/home/pi/work/vue-11589")
        );
        assert!(
            head.first_prompt
                .as_deref()
                .is_some_and(|prompt| prompt.starts_with("Read ISSUE.md")),
            "{:?}",
            head.first_prompt
        );

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Unknown);
        assert!(tail.last_activity.is_some());

        let mut tools = 0;
        let mut thinking = None;
        for line in content.lines() {
            let entry: Value = serde_json::from_str(line).expect("a record");
            if entry.get("type").and_then(Value::as_str) == Some("thinking_level_change") {
                thinking = entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            let Some(items) = entry.pointer("/message/content").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("toolCall") {
                    tools += 1;
                }
            }
        }

        assert!(tools >= 20, "{tools} tool calls");
        assert_eq!(thinking.as_deref(), Some("xhigh"));
        assert!(content.contains("should be executed correctly"));
        assert!(content.contains("1 passed"));
    }

    #[tokio::test]
    async fn a_recorded_vue_ssr_session_reads_as_a_long_run() {
        let content = recorded("real/vue-ssr.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(
            head.cwd.as_ref().map(|cwd| cwd.as_str()),
            Some("/home/pi/work/vue-ssr")
        );
        assert!(
            head.first_prompt
                .as_deref()
                .is_some_and(|prompt| prompt.starts_with("Read ISSUE.md")),
            "{:?}",
            head.first_prompt
        );

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Unknown);
        assert!(tail.last_activity.is_some());

        let mut tools = 0;
        let mut thinking = None;
        for line in content.lines() {
            let entry: Value = serde_json::from_str(line).expect("a record");
            if entry.get("type").and_then(Value::as_str) == Some("thinking_level_change") {
                thinking = entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            let Some(items) = entry.pointer("/message/content").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("toolCall") {
                    tools += 1;
                }
            }
        }

        assert!(tools >= 30, "{tools} tool calls");
        assert_eq!(thinking.as_deref(), Some("xhigh"));
        assert!(content.contains("escape css var name"));
        assert!(content.contains("90 passed"));
    }

    #[tokio::test]
    async fn a_recorded_regex_chess_session_reads_as_a_long_run() {
        let content = recorded("real/regex-chess.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(head.cwd.as_ref().map(|cwd| cwd.as_str()), Some("/app"));
        assert!(
            head.first_prompt
                .as_deref()
                .is_some_and(|prompt| prompt.starts_with("Read /app/TASK.md")),
            "{:?}",
            head.first_prompt
        );

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Unknown);
        assert!(tail.last_activity.is_some());

        let mut tools = 0;
        let mut users = 0;
        let mut thinking = None;
        for line in content.lines() {
            let entry: Value = serde_json::from_str(line).expect("a record");
            if entry.get("type").and_then(Value::as_str) == Some("thinking_level_change") {
                thinking = entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            if entry.pointer("/message/role").and_then(Value::as_str) == Some("user") {
                users += 1;
            }
            let Some(items) = entry.pointer("/message/content").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("toolCall") {
                    tools += 1;
                }
            }
        }

        assert_eq!(users, 2, "the official-test follow-up is the second turn");
        assert!(tools >= 40, "{tools} tool calls");
        assert_eq!(thinking.as_deref(), Some("xhigh"));
        assert!(content.contains("official_test.py"));
        assert!(content.contains("4 passed"));
        assert!(content.contains("6,191"));
    }

    #[tokio::test]
    async fn a_recorded_multiturn_frontend_session_reads_as_a_long_run() {
        let content = recorded("real/kanban-frontend.jsonl");
        let (_dir, mut file, len) = file_of_bytes(content.as_bytes()).await;

        let head = scan_head(&mut file, OsFamily::Unix)
            .await
            .expect("a readable file")
            .expect("a session");
        assert_eq!(
            head.cwd.as_ref().map(|cwd| cwd.as_str()),
            Some("/home/pi/work/kanban")
        );
        assert!(
            head.first_prompt
                .as_deref()
                .is_some_and(|prompt| prompt.starts_with("The Vite React + TypeScript scaffold")),
            "{:?}",
            head.first_prompt
        );

        let tail = scan_tail(&mut file, len).await.expect("a readable file");
        assert_eq!(tail.name, TailName::Unknown);
        assert!(tail.last_activity.is_some());

        let mut tools = 0;
        let mut users = 0;
        let mut thinking = None;
        for line in content.lines() {
            let entry: Value = serde_json::from_str(line).expect("a record");
            if entry.get("type").and_then(Value::as_str) == Some("thinking_level_change") {
                thinking = entry
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            if entry.pointer("/message/role").and_then(Value::as_str) == Some("user") {
                users += 1;
            }
            let Some(items) = entry.pointer("/message/content").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("toolCall") {
                    tools += 1;
                }
            }
        }

        assert_eq!(users, 5, "the project ran for five turns");
        assert!(tools >= 70, "{tools} tool calls");
        assert_eq!(thinking.as_deref(), Some("xhigh"));
        assert!(content.contains("27 passed"));
        assert!(content.contains("README.md"));
        assert!(content.contains("aria-live"));
    }
}
