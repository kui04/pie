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
}
