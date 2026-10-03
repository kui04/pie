//! The host's files, as pie reads them.
//!
//! pi keeps its sessions as JSONL files under `~/.pi/agent/sessions/` and has
//! no command to list them, so pie reads them itself. What a summary needs is
//! three things - the header line, the first thing the user said, and the
//! latest name - and each is extracted where the file already is, so a listing
//! moves those lines and nothing else:
//!
//! - **here**, the filesystem is read whole, the way pi's own scan reads it
//!   (pinned `core/session-manager.ts`, `buildSessionInfo`): exact, and local
//!   reads cost nothing;
//! - **over SSH**, one command per project directory asks the host itself -
//!   `head`, `awk`, `grep` and `tail` where those live, PowerShell on Windows,
//!   the tools the host already has - and comes back with just those lines.
//!   The file never travels;
//! - when that host answers in no shell pie can use, the fallback reads
//!   fragments over sftp: the head up to the first user turn, and the name
//!   backwards from the end (pi appends renames, so the last one meets the
//!   scan first). Then and only then is the name approximate - a name in the
//!   middle of a large file is missed, never replaced by an older one.
//!
//! `modified` is when the file last grew. pi computes the greatest message
//! time over the whole file; the file's last write is that time or later (pi
//! appends), it comes free with the listing, and it never mis-sorts.

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, BufReader};

use crate::error::PieError;
use crate::pi_rpc::protocol::{AgentMessage, SessionEntry, UserContent, UserContentPart};
use crate::pi_rpc::transport::{SshSession, SubsystemStream, Termination};

/// How much of a session file's head the fallback reads at most. The read
/// stops earlier when the first user turn is in hand: pi writes its system
/// entry, every tool definition it has loaded, before that turn, and one line
/// of that size outruns any small window.
const HEAD_BYTES: usize = 1024 * 1024;

/// How far back from a file's end the fallback's name scan goes before giving
/// up. pi appends renames, so the last one usually sits near the end; one that
/// misses the budget comes back as no name at all.
const NAME_SCAN_BYTES: u64 = 1024 * 1024;

/// One block of a backward name scan.
const NAME_BLOCK: usize = 16 * 1024;

/// One read of the head scan.
const READ_CHUNK: usize = 8 * 1024;

/// How much of one line the host-side extraction will print.
///
/// A first message is usually a sentence; one that is pasted code can be
/// enormous, and a summary line that big is not worth its bytes. A truncated
/// line parses as nothing, so such a session lists without a first message.
const SCRIPT_TEXT_CAP: usize = 64 * 1024;

/// How many `"role":"user"` lines the host-side extraction prints as
/// candidates for the first message.
///
/// The script picks lines, not the answer: whether a candidate says anything
/// is the reader's call, as it is for the local read. That matters twice over
/// (a first turn can be an image with no words in it, and a line can look like
/// a user turn without being one), and a script that stopped at the first
/// candidate it liked would lose the real first message to either. Four
/// covers the turns that say nothing in front of one that does; past that the
/// first message is left out rather than guessed at.
const SCRIPT_FIRST_CANDIDATES: usize = 4;

/// Where pi keeps its sessions on a host reached over SSH, relative to the
/// login home - an sftp session starts there, and pi's own `.pi` root follows
/// `HOME` (pinned `core/config.ts`, `CONFIG_DIR_NAME`). This is the default
/// pi resolves when neither of its environment overrides is set.
pub(crate) const REMOTE_SESSIONS_ROOT: &str = ".pi/agent/sessions";

/// Where pi keeps the sessions it started on this machine.
///
/// pi resolves its sessions root in one order (pinned `main.ts`): the
/// `--session-dir` flag, which pie never passes, then the two environment
/// variables, then the default under the home. The names are pi's package name
/// uppercased (`config.ts`, `ENV_AGENT_DIR`); the standard package spells them
/// `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. A user who moved
/// their sessions has said so in one of them, and a listing that quietly showed
/// none is the worst way to find out.
///
/// The leg before the flag - pi's own `settings.json` `sessionDir` - is not
/// read here; a user who set only that still sees an empty listing.
///
/// The home itself resolves the way pi resolves it - `$HOME`, else the login
/// entry, the rule Node's `os.homedir()` and [`dirs::home_dir`] share.
pub(crate) fn local_sessions_root() -> Option<PathBuf> {
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
    // `PI_CODING_AGENT_SESSION_DIR` names the sessions root itself;
    // `PI_CODING_AGENT_DIR` names pi's agent root, and the sessions live under
    // it (pinned `getAgentDir`, `getDefaultSessionDirPath`).
    if let Some(dir) = session_dir {
        return Some(expand_home(dir, home.as_deref()));
    }
    if let Some(dir) = agent_dir {
        return Some(expand_home(dir, home.as_deref()).join("sessions"));
    }
    Some(home?.join(".pi").join("agent").join("sessions"))
}

/// pi expands a leading `~` in these paths (pinned `expandTildePath`); a value
/// without one stands as it is, home or not.
fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
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

/// One session pi has written, as its own lines tell it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// Where the file is, as the host sees it.
    pub path: String,
    /// pi's id for the session, from the file's header.
    pub id: String,
    /// Where the session was started. Empty for files pi predates the field in.
    pub cwd: String,
    /// The display name the user last gave it, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The session this one was forked from, when it was forked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,
    /// When pi started the session (the header's timestamp, RFC3339).
    pub created: String,
    /// When the file last grew, RFC3339.
    pub modified: String,
    /// What the user first said, when the file gets that far.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_message: Option<String>,
}

/// One directory level, as the directory picker walks it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    /// Name within the directory.
    pub name: String,
    /// Where the entry is, as the host sees it. Absolute, so the picker walks
    /// with these and never builds a path of its own - pie resolves nothing
    /// relative to wherever it happens to be running.
    pub path: String,
    /// Whether the entry is a directory itself - a link to one counts, because
    /// that is what a directory picker needs to walk.
    pub is_dir: bool,
}

/// The first line of a session file: pi's `SessionHeader` (pinned
/// `core/session-manager.ts`).
///
/// The header is the only place the working directory lives. pi also encodes a
/// cwd into the directory name, but lossily - the encoding replaces `/` and
/// `:` alike, so `/home/pie` and `/home-pie` collide - which is why nothing
/// here decodes a directory name back into one.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHeader {
    /// The entry kind. pi decides a file is a session by this being `session`,
    /// and so does this reader: anything with an id and a timestamp would
    /// otherwise pass for a header.
    #[serde(rename = "type")]
    kind: String,
    /// pi's session id.
    id: String,
    /// When pi started the session, ISO.
    timestamp: String,
    /// Where the session was started; missing in files older than the field.
    #[serde(default)]
    cwd: String,
    /// The session this one was forked from, when it was forked.
    #[serde(default)]
    parent_session: Option<String>,
}

/// The three lines a summary is built from, wherever they were read.
#[derive(Debug, Default, Clone)]
struct Extract {
    /// The file's header line.
    header: Option<String>,
    /// The first thing the user said, as pi reads it.
    first: Option<String>,
    /// The latest display name the file carries, a clear included.
    name: Option<String>,
}

/// Builds a summary from one file's extracted lines.
fn summary_of(path: &str, extract: Extract, modified: Option<String>) -> Option<SessionSummary> {
    let header: FileHeader = serde_json::from_str(extract.header.as_deref()?).ok()?;
    if header.kind != "session" {
        return None;
    }
    Some(SessionSummary {
        path: path.to_string(),
        id: header.id,
        cwd: header.cwd,
        name: extract.name,
        parent_session_path: header.parent_session,
        modified: modified.unwrap_or_else(|| header.timestamp.clone()),
        created: header.timestamp,
        first_message: extract.first,
    })
}

/// A session name as pi stores it: trimmed, and empty means unnamed. pi's
/// scan takes the latest `session_info` entry whatever it says, an empty one
/// included, because renaming to nothing is how a name is cleared.
fn cleaned_name(name: Option<&str>) -> Option<String> {
    let name = name?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// What one line says about the display name.
///
/// `Some(None)` is an explicit clear - pi drops a name by renaming to nothing,
/// and a scan stops there rather than reading an older one.
fn name_in(line: &[u8]) -> Option<Option<String>> {
    let entry: SessionEntry = serde_json::from_slice(line).ok()?;
    let SessionEntry::SessionInfo(info) = entry else {
        return None;
    };
    Some(cleaned_name(info.name.as_deref()))
}

/// What one line says the user said, in the shape pi's own scan takes it: a
/// user message with any text in it (pinned `extractTextContent`).
///
/// One deliberate difference from pi's scan, which keeps a blank first turn:
/// `if (!textContent) continue` is false for a non-empty string like `" "`, so
/// that turn becomes pi's first message (pinned `session-manager.ts:840`).
/// This reader looks for a turn that says something and keeps going - the
/// difference is what the session drawer shows for a session that opened with
/// a stray space, and skipping it is the answer worth showing.
fn first_text(line: &[u8]) -> Option<String> {
    let entry: SessionEntry = serde_json::from_slice(line).ok()?;
    let SessionEntry::Message(message) = entry else {
        return None;
    };
    let AgentMessage::User(user) = message.message else {
        return None;
    };
    let text = text_of(&user.content);
    (!text.trim().is_empty()).then_some(text)
}

/// The text of a message's content: a plain string as it is, otherwise the
/// text parts joined with a space, the way pi reads it back.
fn text_of(content: &UserContent) -> String {
    match content {
        UserContent::Text(text) => text.clone(),
        UserContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                UserContentPart::Text(text) => Some(text.text.as_str()),
                UserContentPart::Image(_) => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// Formats a file time the way pi's own ISO strings read (`toISOString()`,
/// three fractional digits always), so timestamps compare and sort in one
/// order.
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

/// Reads a session file whole, the way pi's own listing does - line by line,
/// so the file's size is never its size in memory.
///
/// Lines are split on bytes and decoded leniently: pi reads through a decoder
/// that replaces whatever is not UTF-8 with U+FFFD and carries on, so a file
/// with one bad byte still lists. Failing the whole file on it would be
/// stricter than the reader it mirrors.
async fn read_whole<F>(file: F) -> std::io::Result<Extract>
where
    F: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut extract = Extract::default();
    while lines.read_until(b'\n', &mut buffer).await? > 0 {
        let line = String::from_utf8_lossy(&buffer);
        let line = line.trim_end_matches(['\n', '\r']);
        if extract.header.is_none() {
            extract.header = Some(line.to_string());
        }
        if extract.first.is_none()
            && let Some(text) = first_text(line.as_bytes())
        {
            extract.first = Some(text);
        }
        // The latest name wins, a clear included: pi appends a `session_info`
        // entry on every rename and reads the last one.
        if let Some(name) = name_in(line.as_bytes()) {
            extract.name = name;
        }
        buffer.clear();
    }
    Ok(extract)
}

/// The shell that extracts a project directory's summary lines on the host.
///
/// One pass per file: the header, the latest name, and the first few lines
/// that look like user turns - which ones of those the user actually said
/// anything in is [`first_text`]'s call, the same one the local read makes.
/// `sh`, `printf`, `head`, `awk`, `grep` and `tail` are what every POSIX system
/// ships; the guard turns a host that has not into a clear failure, so the
/// Windows script or the sftp fallback gets its turn. Session file names are
/// pi's own (`<timestamp>_<id>.jsonl`), so a plain glob is safe over them.
fn posix_summary_script(dir: &str) -> String {
    format!(
        "command -v head awk grep tail >/dev/null 2>&1 || exit 127; \
         for f in {dir}/*.jsonl; do [ -f \"$f\" ] || continue; \
         printf '=== %s\\n' \"${{f##*/}}\"; \
         head -n 1 \"$f\"; printf -- '---\\n'; \
         awk '/\"role\":\"user\"/ {{ print substr($0, 1, {cap}); n++; if (n >= {cands}) exit }}' \"$f\"; \
         printf -- '---\\n'; \
         grep '\"type\":\"session_info\"' \"$f\" | tail -n 1; printf -- '---\\n'; \
         done; :",
        dir = quote(dir),
        cap = SCRIPT_TEXT_CAP,
        cands = SCRIPT_FIRST_CANDIDATES,
    )
}

/// The same extraction in PowerShell, for a Windows host.
///
/// Windows ships no POSIX shell, but every supported Windows ships this, and
/// the same three lines come back in the same shape. The script is built here
/// and travels as its own parameter - see [`windows_summary_command`] - so the
/// directory the user picked never has to survive anyone's quoting rules.
fn windows_summary_script(dir: &str) -> String {
    format!(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
         $d = '{dir}'; \
         Get-ChildItem -LiteralPath $d -Filter *.jsonl -File | ForEach-Object {{ \
         Write-Output ('=== ' + $_.Name); \
         Get-Content -LiteralPath $_.FullName -TotalCount 1; \
         Write-Output '---'; \
         $first = Select-String -LiteralPath $_.FullName -Pattern '\"role\":\"user\"' | Select-Object -First {cands}; \
         foreach ($m in $first) {{ $l = $m.Line; Write-Output $l.Substring(0, [Math]::Min({cap}, $l.Length)) }}; \
         Write-Output '---'; \
         $name = Select-String -LiteralPath $_.FullName -Pattern '\"type\":\"session_info\"' | Select-Object -Last 1; \
         if ($name) {{ Write-Output $name.Line }}; \
         Write-Output '---' }}",
        dir = dir.replace('\'', "''"),
        cap = SCRIPT_TEXT_CAP,
        cands = SCRIPT_FIRST_CANDIDATES,
    )
}

/// How [`windows_summary_script`] is run: `powershell` with the script as its
/// own encoded parameter.
///
/// `-EncodedCommand` takes base64 of UTF-16LE, which PowerShell decodes
/// itself - so the script's own quoting is the only quoting in the world here.
/// The console encoding is set to UTF-8 inside the script because Windows
/// PowerShell otherwise prints in the OEM code page, and a name with any
/// non-ASCII character would come back as mojibake.
fn windows_summary_command(dir: &str) -> String {
    format!(
        "powershell -NoProfile -NonInteractive -EncodedCommand {}",
        base64_utf16le(&windows_summary_script(dir))
    )
}

/// base64 of `script` as UTF-16LE, the one encoding `-EncodedCommand` wants.
fn base64_utf16le(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// What one summary block of [`posix_summary_script`]'s output carries.
struct Extracted {
    /// Where the file is: `dir` and the name the block was stamped with, the
    /// same join the sftp listing makes, so the two match by path.
    path: String,
    extract: Extract,
}

/// Asks the host where pi keeps its sessions, for a host that was told to keep
/// them somewhere else.
///
/// The question goes to the very login shell pi itself is started through, so
/// the answer is the environment pi itself would see. With neither override
/// set the host still answers - with the default - so `None` means the host
/// would not answer at all, which is the one case the caller falls back on its
/// own default. A leading `~` is finished here rather than in the shell, against
/// the home the host reported (pi expands it too, pinned `expandTildePath`);
/// without that a `~/pi-sessions` would be taken for a missing path and the
/// listing would come back empty with nothing said.
async fn host_sessions_root(session: &SshSession) -> Option<String> {
    for command in [posix_root_script(), windows_root_command()] {
        if let Ok(output) = session.output(command).await
            && matches!(output.termination, Termination::Exited { code: 0, success: true })
        {
            let printed_all = String::from_utf8_lossy(&output.stdout);
            let mut lines = printed_all.lines();
            let printed = lines.next()?.trim();
            if !printed.is_empty() {
                let home = lines.next().map(str::trim).filter(|home| !home.is_empty());
                return Some(expand_home(printed, home.map(Path::new)).to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// The shell that asks the host where its sessions are, in the same order
/// [`sessions_root_from`] reads them: the sessions root, else the agent root
/// plus `sessions`, else the default under the home.
///
/// Two lines come back - the value and the host's home - because pi expands a
/// leading `~` in these paths (pinned `expandTildePath`) and a shell expands
/// nothing inside a variable: the value keeps its `~`, and pie finishes the job
/// against the home the host itself reported.
fn posix_root_script() -> String {
    "if [ -n \"$PI_CODING_AGENT_SESSION_DIR\" ]; then printf '%s\\n' \"$PI_CODING_AGENT_SESSION_DIR\"; \
     elif [ -n \"$PI_CODING_AGENT_DIR\" ]; then printf '%s\\n' \"$PI_CODING_AGENT_DIR/sessions\"; \
     else printf '%s\\n' \"$HOME/.pi/agent/sessions\"; fi; printf '%s\\n' \"$HOME\""
        .to_string()
}

/// The same question in PowerShell, for a Windows host: the value, then the
/// home, on two lines - the same two lines [`posix_root_script`] sends.
fn windows_root_command() -> String {
    format!(
        "powershell -NoProfile -NonInteractive -EncodedCommand {}",
        base64_utf16le(
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
             if ($env:PI_CODING_AGENT_SESSION_DIR) { $env:PI_CODING_AGENT_SESSION_DIR } \
             elseif ($env:PI_CODING_AGENT_DIR) { \"$($env:PI_CODING_AGENT_DIR)\\sessions\" } \
             else { \"$HOME\\.pi\\agent\\sessions\" }; Write-Output $HOME"
        )
    )
}

/// Runs one summary script on the host and reads its blocks back.
///
/// `None` when the host would not run it at all - no such shell, no such
/// tools - which is the caller's cue to try the other one.
async fn host_summary(session: &SshSession, dir: &str, command: String) -> Option<Vec<Extracted>> {
    match session.output(command).await {
        Ok(output) if output.termination == Termination::Exited { code: 0, success: true } => {
            Some(parse_summary_output(dir, &String::from_utf8_lossy(&output.stdout)))
        }
        Ok(output) => {
            tracing::warn!(path = %dir, termination = ?output.termination, "the host ran no summary script");
            None
        }
        Err(error) => {
            tracing::warn!(path = %dir, %error, "the host ran no summary script");
            None
        }
    }
}

/// Reads [`posix_summary_script`]'s output back into per-file lines.
///
/// Three `---`-separated slots per `=== ` file block: header, candidates for
/// the first message, name. An empty slot is an absent one - the host prints
/// the separators either way - and the first slot may hold several candidate
/// lines: the first one [`first_text`] can use is the first message, which is
/// how a turn with no words in it does not swallow the one after it.
fn parse_summary_output(dir: &str, output: &str) -> Vec<Extracted> {
    let mut extracted = Vec::new();
    let mut current: Option<(String, Extract, usize)> = None;
    for line in output.lines() {
        if let Some(name) = line.strip_prefix("=== ") {
            if let Some((name, extract, _)) = current.take() {
                extracted.push(Extracted {
                    path: format!("{dir}/{name}"),
                    extract,
                });
            }
            current = Some((name.to_string(), Extract::default(), 0));
            continue;
        }
        if line == "---" {
            if let Some(slot) = current.as_mut() {
                slot.2 += 1;
            }
            continue;
        }
        let Some((_, extract, slot)) = current.as_mut() else {
            continue;
        };
        match slot {
            0 if line.trim().is_empty() => {}
            0 => extract.header = Some(line.to_string()),
            1 => {
                if extract.first.is_none()
                    && let Some(text) = first_text(line.as_bytes())
                {
                    extract.first = Some(text);
                }
            }
            2 => {
                if let Some(name) = name_in(line.as_bytes()) {
                    extract.name = name;
                }
            }
            _ => {}
        }
    }
    if let Some((name, extract, _)) = current.take() {
        extracted.push(Extracted {
            path: format!("{dir}/{name}"),
            extract,
        });
    }
    extracted
}

/// Reads the fallback's two fragments of one session file.
///
/// The head up to the first user turn, the name backwards from the end. Both
/// are bounded whatever the file does; what only a whole file can show - a
/// name in its middle - comes back as no name rather than a guess.
async fn read_fragments<F>(file: &mut F, size: Option<u64>) -> std::io::Result<Extract>
where
    F: AsyncRead + AsyncSeek + Unpin,
{
    let mut head = Vec::new();
    let mut scan = HeadScan::default();
    let mut chunk = [0u8; READ_CHUNK];
    while head.len() < HEAD_BYTES {
        let room = (HEAD_BYTES - head.len()).min(READ_CHUNK);
        let read = file.read(&mut chunk[..room]).await?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
        if first_turn_is_whole(&head, &mut scan) {
            break;
        }
    }

    let name = name_backwards(file, size).await?;
    let lossy = String::from_utf8_lossy(&head);
    let mut lines = lossy.lines().map(str::to_string);
    let header = lines.next();
    let mut first = None;
    for line in lines {
        if let Some(text) = first_text(line.as_bytes()) {
            first = Some(text);
            break;
        }
    }
    Ok(Extract { header, first, name })
}

/// How far the head scan has got inside the line it is still reading.
#[derive(Default)]
struct HeadScan {
    /// Where the last completed line ended, so the current one starts here.
    line_start: usize,
    /// How far into the current line the literal has already been looked for.
    searched: usize,
}

/// Whether the head read holds a whole user turn to stop at.
///
/// Only what arrived since the last call is looked at: pi's system entry is one
/// line long enough to span the whole head, and rescanning it per chunk would
/// cost more than reading it did. The literal is what a serialized user message
/// always carries; the reverse risk is real but was in none of the real
/// sessions checked - a lookalike inside some tool's arguments would stop the
/// scan early and lose the first message. Wrong by omission, never by
/// invention.
fn first_turn_is_whole(head: &[u8], scan: &mut HeadScan) -> bool {
    // Every line the new bytes completed, not just the first: the head is a
    // byte budget, and a chunk of short lines must not advance the scan one
    // line at a time.
    let mut found = false;
    while !found {
        let fresh = &head[scan.searched..];
        let Some(at) = fresh.iter().position(|byte| *byte == b'\n') else {
            // Still inside one line: note how far it has been read and wait
            // for its end rather than looking at the same bytes again.
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

/// The display name, read backwards from the end of the file.
///
/// pi appends a `session_info` entry whenever a session is renamed and takes
/// the last one (pinned `buildSessionInfo`), so scanning back from the end
/// meets exactly that one first. The scan stops at the first entry it meets -
/// usually a line or two in - at [`NAME_SCAN_BYTES`], or at the file's start.
/// A name that misses the budget comes back as no name; an earlier one is
/// never shown in its place.
async fn name_backwards<F>(file: &mut F, size: Option<u64>) -> std::io::Result<Option<String>>
where
    F: AsyncRead + AsyncSeek + Unpin,
{
    // The listing usually carries the size; a host that kept it back is asked
    // directly rather than skipped.
    let size = match size {
        Some(size) => size,
        None => file.seek(SeekFrom::End(0)).await?,
    };
    let budget = size.min(NAME_SCAN_BYTES);
    let mut position = size;
    let mut scanned = 0u64;
    // The half line at the left edge of the scanned suffix: it continues into
    // the block read next.
    let mut carry: Vec<u8> = Vec::new();

    while scanned < budget {
        let block = NAME_BLOCK.min((budget - scanned) as usize);
        position -= block as u64;
        file.seek(SeekFrom::Start(position)).await?;

        let mut suffix = vec![0u8; block];
        let mut filled = 0;
        while filled < block {
            let read = file.read(&mut suffix[filled..]).await?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        suffix.truncate(filled);
        suffix.extend_from_slice(&carry);
        scanned += block as u64;

        // Whole lines first, newest one first; whatever is left over at the
        // left edge carries into the next round.
        let mut end = suffix.len();
        loop {
            let Some(line_end) = suffix[..end].iter().rposition(|byte| *byte == b'\n') else {
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

/// The sessions pi has written under a local `sessions` directory.
///
/// A file or a project directory pie cannot read is skipped rather than
/// failing the listing: one damaged part must not hide the rest (pi's own scan
/// drops unreadable entries the same way).
pub(crate) async fn list_local(root: &Path) -> Result<Vec<SessionSummary>, PieError> {
    let mut summaries = Vec::new();
    let mut projects = match tokio::fs::read_dir(root).await {
        Ok(projects) => projects,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(summaries),
        Err(error) => return Err(unreadable(&root.display().to_string(), error)),
    };
    while let Some(project) = next_entry(&mut projects, &root.display().to_string()).await? {
        let project_path = project.path();
        let shown_project = project_path.display().to_string();
        // The free `metadata` follows links (a `DirEntry`'s own `metadata`
        // does not): a project directory reached through one is still a
        // project directory.
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
            let shown = path.to_string_lossy().into_owned();
            let modified = file
                .metadata()
                .await
                .ok()
                .and_then(|stats| rfc3339(stats.modified().ok()?));
            match tokio::fs::File::open(&path).await {
                Ok(opened) => match read_whole(opened).await {
                    Ok(extract) => {
                        if let Some(summary) = summary_of(&shown, extract, modified) {
                            summaries.push(summary);
                        }
                    }
                    Err(error) => tracing::warn!(path = %shown, %error, "skipping a session file pie cannot read"),
                },
                Err(error) => tracing::warn!(path = %shown, %error, "skipping a session file pie cannot read"),
            }
        }
    }
    newest_first(&mut summaries);
    Ok(summaries)
}

/// The same listing over SSH.
///
/// The summary lines are extracted on the host, one command per project
/// directory, so a listing moves those lines and nothing else. A host whose
/// shell pie cannot use falls back to fragments over sftp.
pub(crate) async fn list_remote(session: &SshSession, sftp: &SftpSession) -> Result<Vec<SessionSummary>, PieError> {
    let mut summaries = Vec::new();
    let root = host_sessions_root(session)
        .await
        .unwrap_or_else(|| REMOTE_SESSIONS_ROOT.to_string());
    let root = match sftp.canonicalize(&root).await {
        Ok(root) => root,
        // A host pi has not run on yet has no such directory; that is a host
        // with no sessions, not a listing that failed.
        Err(error) if is_no_such_file(&error) => return Ok(summaries),
        Err(error) => return Err(unreadable(&root, error)),
    };
    let projects = sftp.read_dir(&root).await.map_err(|error| unreadable(&root, error))?;
    for project in projects {
        if !sftp_is_dir(sftp, &project).await {
            continue;
        }
        let dir = project.path();
        let files = match sftp.read_dir(&dir).await {
            Ok(files) => files,
            Err(error) => {
                tracing::warn!(path = %dir, %error, "skipping a project directory pie cannot read");
                continue;
            }
        };
        let mut times = Vec::new();
        for file in files {
            if file.file_name().ends_with(".jsonl") {
                times.push((file.path(), file.metadata().modified().ok().and_then(rfc3339)));
            }
        }
        if times.is_empty() {
            continue;
        }

        let extracted = match host_summary(session, &dir, posix_summary_script(&dir)).await {
            Some(extracted) if !extracted.is_empty() => extracted,
            // A Windows host has no POSIX shell: the same three lines come
            // back from PowerShell before pie falls to reading fragments.
            _ => host_summary(session, &dir, windows_summary_command(&dir))
                .await
                .unwrap_or_default(),
        };
        // Not what either script printed - or neither ran: read the file's
        // fragments over sftp rather than drop the row, and say so once, so a
        // host whose scripts silently stopped working is not mistaken for a
        // host with nothing to show.
        let found: std::collections::HashMap<String, Extract> =
            extracted.into_iter().map(|item| (item.path, item.extract)).collect();
        if found.is_empty() {
            tracing::warn!(path = %dir, "no summary script ran on this host; its sessions are read over sftp instead");
        }

        for (path, modified) in times {
            let extract = match found.get(&path) {
                Some(extract) => Extract {
                    header: extract.header.clone(),
                    first: extract.first.clone(),
                    name: extract.name.clone(),
                },
                // Not what the script said it would print: read the file's
                // fragments over sftp rather than drop the row.
                None => {
                    let mut opened = match sftp.open_with_flags(&path, OpenFlags::READ).await {
                        Ok(opened) => opened,
                        Err(error) => {
                            tracing::warn!(path = %path, %error, "skipping a session file pie cannot read");
                            continue;
                        }
                    };
                    let size = sftp.metadata(&path).await.ok().and_then(|attrs| attrs.size);
                    match read_fragments(&mut opened, size).await {
                        Ok(extract) => extract,
                        Err(error) => {
                            tracing::warn!(path = %path, %error, "skipping a session file pie cannot read");
                            continue;
                        }
                    }
                }
            };
            if let Some(summary) = summary_of(&path, extract, modified) {
                summaries.push(summary);
            }
        }
    }
    newest_first(&mut summaries);
    Ok(summaries)
}

/// One directory level on the local filesystem, for the directory picker.
///
/// Paths are absolute and belong to the host: pie resolves nothing relative to
/// its own directory, which on a phone is not anyone's home. `path` is `None`
/// for the home directory the connection was told about - the app's own home,
/// which is not looked up again here.
pub(crate) async fn list_dirs_local(home: Option<&Path>, path: Option<&str>) -> Result<Vec<DirEntryInfo>, PieError> {
    let path = match path {
        None => home.map(Path::to_path_buf).ok_or_else(|| PieError::Transport {
            message: "there is no home directory to browse".to_string(),
        })?,
        Some(path) => {
            if !Path::new(path).is_absolute() {
                return Err(not_absolute(path));
            }
            PathBuf::from(path)
        }
    };
    let shown = path.display().to_string();
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| unreadable(&shown, error))?;
    let mut rows = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|error| unreadable(&shown, error))? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        // The free `metadata` follows links (a `DirEntry`'s own `metadata`
        // does not): a picker that cannot walk into a linked directory has lost
        // half of some home directories. A link that leads nowhere is still a
        // row - it just is not a directory.
        let is_dir = match tokio::fs::metadata(entry.path()).await {
            Ok(target) => target.is_dir(),
            Err(error) => {
                tracing::warn!(path = %entry.path().display(), %error, "an entry pie cannot follow");
                false
            }
        };
        rows.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(rows)
}

/// The same directory level over an sftp channel. `None` asks for the login
/// home, which is where an sftp session starts.
pub(crate) async fn list_dirs_remote(sftp: &SftpSession, path: Option<&str>) -> Result<Vec<DirEntryInfo>, PieError> {
    let base = match path {
        None => sftp
            .canonicalize(".")
            .await
            .map_err(|error| unreadable("the login home", error))?,
        Some(path) => {
            if !is_absolute_on_the_host(path) {
                // The host's paths, not this machine's: over sftp they are
                // whatever the host speaks, POSIX or Windows, and neither is
                // pie's own directory.
                return Err(not_absolute(path));
            }
            path.to_string()
        }
    };
    let entries = sftp.read_dir(&base).await.map_err(|error| unreadable(&base, error))?;
    let mut rows = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        rows.push(DirEntryInfo {
            is_dir: sftp_is_dir(sftp, &entry).await,
            name,
            path: entry.path(),
        });
    }
    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(rows)
}

/// Whether an sftp entry is a directory a picker can walk, links included.
///
/// sftp reports what the link is, not what it points at; a picker needs the
/// target, so a link is asked about on its own (one round trip for the links,
/// none for everything else).
async fn sftp_is_dir(sftp: &SftpSession, entry: &russh_sftp::client::fs::DirEntry) -> bool {
    if !entry.file_type().is_symlink() {
        return entry.file_type().is_dir();
    }
    match sftp.metadata(entry.path()).await {
        Ok(target) => is_dir(&target),
        Err(error) => {
            tracing::warn!(path = %entry.path(), %error, "a link pie cannot follow");
            false
        }
    }
}

/// [`FileAttributes::is_dir`], named for the `?` to read well.
fn is_dir(attrs: &FileAttributes) -> bool {
    attrs.is_dir()
}

/// The sftp channel over an SSH session, opened on first use and kept.
///
/// On first use rather than at connect: a host whose sshd serves no `sftp`
/// subsystem still runs pi fine, and only its file listing is lost. Shared by
/// pointer because a channel is one thing the session answers on and a listing
/// reads it from several places at once; and shared behind a slot rather than
/// fixed, because a channel can die under a live connection - see
/// [`forget_sftp`].
pub(crate) async fn sftp(
    session: &SshSession,
    cell: &Mutex<Option<Arc<SftpSession>>>,
) -> Result<Arc<SftpSession>, PieError> {
    let cached = cell.lock().unwrap_or_else(PoisonError::into_inner).clone();
    if let Some(sftp) = cached {
        return Ok(sftp);
    }
    let stream: SubsystemStream = session.subsystem("sftp").await?;
    let opened = SftpSession::new(stream).await.map_err(|error| PieError::Transport {
        message: format!("the sftp subsystem on {} did not answer: {error}", session.endpoint()),
    })?;
    let opened = Arc::new(opened);
    // A failed open leaves the slot empty, so the next listing tries again -
    // a host may simply not serve sftp yet.
    *cell.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&opened));
    Ok(opened)
}

/// Drops the cached sftp channel after a listing failed over it - but only
/// when it is the very channel that listing used.
///
/// A listing that raced another one may be reporting a failure over a channel
/// the other has already replaced with a fresh, healthy one; clearing that
/// would throw away a working channel over a failure that had nothing to do
/// with it. The identity check keeps each listing responsible for its own.
pub(crate) fn forget_sftp(cell: &Mutex<Option<Arc<SftpSession>>>, used: &Arc<SftpSession>) {
    drop_if_same(&mut cell.lock().unwrap_or_else(PoisonError::into_inner), used);
}

/// Clears `slot` when it still holds the very thing `used` points at.
///
/// Generic so the identity rule can be told apart from the sftp handshake it
/// guards: the question is "is this the same one", not "is this one alive".
fn drop_if_same<T>(slot: &mut Option<Arc<T>>, used: &Arc<T>) -> bool {
    if slot.as_ref().is_some_and(|cached| Arc::ptr_eq(cached, used)) {
        *slot = None;
        true
    } else {
        false
    }
}

/// Newest conversation first, the order the session list reads in.
fn newest_first(summaries: &mut [SessionSummary]) {
    summaries.sort_by(|a, b| b.modified.cmp(&a.modified));
}

/// A path pie cannot read surfaces like any other reach failure: the frontend
/// offers the same retry, and the message names the path that is at fault.
fn unreadable(path: &str, error: impl std::fmt::Display) -> PieError {
    PieError::Transport {
        message: format!("cannot read {path}: {error}"),
    }
}

/// A relative path is the frontend's mistake, not the host's failure.
///
/// Asked for by name so a caller holding a connection can reject such a path
/// before it spends a channel handshake on it.
pub(crate) fn not_absolute(path: &str) -> PieError {
    PieError::Internal {
        message: format!("`{path}` is not absolute; pie resolves no path against its own directory"),
    }
}

/// Whether `path` is absolute on the host it names: POSIX or Windows style.
///
/// The host's conventions, not this machine's - pie runs on one and reads the
/// other, so both spellings are the host's own. Asked for by name so a caller
/// holding a connection can reject a relative path before it spends a channel
/// handshake on it.
pub(crate) fn is_absolute_on_the_host(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with("\\\\")
        || matches!(
            path.as_bytes(),
            [drive, b':', sep, ..] if drive.is_ascii_alphabetic() && matches!(sep, b'\\' | b'/')
        )
}

/// Whether an sftp failure is simply "there is no such path".
fn is_no_such_file(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

/// Reads the next directory entry, naming the directory being listed when one
/// of its entries cannot be read.
async fn next_entry(entries: &mut tokio::fs::ReadDir, shown: &str) -> Result<Option<tokio::fs::DirEntry>, PieError> {
    entries.next_entry().await.map_err(|error| unreadable(shown, error))
}

/// Quotes `text` for a POSIX shell, so it reaches the remote command unmangled.
///
/// The same quoting lives in `pi_rpc`'s transport, which cannot share it across
/// the module boundary; the two encode different things - a directory the user
/// picked, here, a remote command there - so a change to one is a change to
/// both.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session file's first line, the way pi writes it.
    const HEADER: &str =
        r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-10-02T13:45:12.345Z","cwd":"/home/pie"}"#;

    fn user_line(id: &str, timestamp: &str, millis: i64, text: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":null,"timestamp":"{timestamp}","message":{{"role":"user","content":"{text}","timestamp":{millis}}}}}"#
        )
    }

    fn name_line(id: &str, name: &str) -> String {
        format!(
            r#"{{"type":"session_info","id":"{id}","parentId":null,"timestamp":"2026-10-02T13:50:00.000Z","name":"{name}"}}"#
        )
    }

    fn system_line(fill: &str) -> String {
        format!(
            r#"{{"type":"message","id":"sys","parentId":null,"timestamp":"2026-10-02T13:45:12.900Z","message":{{"role":"system","content":"","sections":{{"tools":"{fill}"}},"timestamp":1790948712900}}}}"#
        )
    }

    async fn on_disk(content: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().expect("a temp directory");
        let path = directory.path().join("s.jsonl");
        std::fs::write(&path, content).expect("the session file");
        (directory, path)
    }

    async fn extracted(path: &std::path::Path) -> Extract {
        let opened = tokio::fs::File::open(path).await.expect("the file");
        read_whole(opened).await.expect("the read")
    }

    #[test]
    fn a_summary_reads_its_header_and_first_message() {
        let extract = Extract {
            header: Some(HEADER.to_string()),
            first: Some("hello there".to_string()),
            name: Some("Renamed".to_string()),
        };

        let summary =
            summary_of("/x/s.jsonl", extract, Some("2026-10-02T13:45:20.000Z".to_string())).expect("a session file");

        assert_eq!(summary.id, "s1");
        assert_eq!(summary.cwd, "/home/pie");
        assert_eq!(summary.name.as_deref(), Some("Renamed"));
        assert_eq!(summary.created, "2026-10-02T13:45:12.345Z");
        assert_eq!(summary.modified, "2026-10-02T13:45:20.000Z");
        assert_eq!(summary.first_message.as_deref(), Some("hello there"));
    }

    #[test]
    fn the_file_time_is_what_modified_falls_back_to() {
        let extract = Extract {
            header: Some(HEADER.to_string()),
            ..Extract::default()
        };

        let summary = summary_of("/x/s.jsonl", extract, None).expect("a session file");

        assert_eq!(
            summary.modified, summary.created,
            "no file time leaves the header's own"
        );
    }

    #[test]
    fn a_file_without_a_session_header_is_not_a_session() {
        let extract = Extract {
            header: Some(user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi")),
            ..Extract::default()
        };

        assert!(
            summary_of("/x/s.jsonl", extract, None).is_none(),
            "pi's own scan drops files whose first entry is not a header"
        );
    }

    #[test]
    fn the_sessions_root_follows_pis_own_order() {
        // pi resolves flag, then `PI_CODING_AGENT_SESSION_DIR`, then
        // `PI_CODING_AGENT_DIR` plus `sessions`, then the default (pinned
        // `main.ts`, `getAgentDir`). pie never passes the flag.
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
    async fn a_file_with_a_bad_byte_still_lists() {
        // pi reads through a decoder that replaces whatever is not UTF-8 with
        // U+FFFD and carries on; a whole file skipped over one bad byte would
        // be stricter than the reader it mirrors.
        let directory = tempfile::tempdir().expect("a temp directory");
        let path = directory.path().join("s.jsonl");
        let mut content: Vec<u8> = Vec::new();
        content.extend_from_slice(HEADER.as_bytes());
        content.push(b'\n');
        // The one bad byte is a real byte in the file, spliced into the line
        // rather than written as an escape: `\xff` inside a raw string is four
        // characters, and JSON has no such escape. A lone 0xFF is never valid
        // UTF-8, which is the point.
        let mut line: Vec<u8> =
            String::from(r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":"hi "#)
                .into_bytes();
        line.push(0xFF);
        line.extend_from_slice(r#" there","timestamp":1790948713000}}"#.as_bytes());
        content.extend_from_slice(&line);
        content.push(b'\n');
        std::fs::write(&path, content).expect("the session file");

        let extract = extracted(&path).await;

        assert_eq!(
            extract.first.as_deref(),
            Some("hi \u{fffd} there"),
            "the one bad byte became a replacement character, not a missing session"
        );
    }

    #[test]
    fn the_first_slot_takes_the_first_candidate_the_reader_can_use() {
        // The script prints candidates, not the answer: a turn that says
        // nothing (an image, a lookalike line) must not swallow the message
        // after it.
        let image_turn = r#"{"type":"message","id":"m0","parentId":null,"timestamp":"2026-10-02T13:45:12.600Z","message":{"role":"user","content":[{"type":"image","data":"AAAA","mimeType":"image/png"}],"timestamp":1790948712600}}"#;
        let real = r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":"the real first words","timestamp":1790948713000}}"#;
        let output = format!("=== a.jsonl\n{HEADER}\n---\n{image_turn}\n{real}\n---\n---\n");

        let extracted = parse_summary_output("/x", &output);

        assert_eq!(
            extracted[0].extract.first.as_deref(),
            Some("the real first words"),
            "a turn with no words in it does not consume the slot"
        );
    }

    #[tokio::test]
    async fn the_whole_file_read_meets_the_last_rename_last() {
        // pi takes the latest `session_info` entry however the file grew; a
        // whole read sees them in order and keeps the last.
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}\n{}",
            name_line("n1", "First"),
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi"),
            name_line("n2", "Last"),
        ))
        .await;

        let extract = extracted(&path).await;

        assert_eq!(extract.name.as_deref(), Some("Last"));
    }

    #[tokio::test]
    async fn renaming_to_nothing_clears_the_name() {
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}",
            name_line("n1", "Named"),
            name_line("n2", ""),
        ))
        .await;

        let extract = extracted(&path).await;

        assert_eq!(
            extract.name, None,
            "pi clears a name by renaming to nothing; an older one is never shown in its place"
        );
    }

    #[tokio::test]
    async fn the_first_message_is_what_the_user_said_not_what_is_in_the_way() {
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}\n{}",
            // Not a message at all.
            r#"{"type":"usage","id":"u1","parentId":null,"timestamp":"2026-10-02T13:45:12.500Z","kind":"cache_warm"}"#,
            // A message, but nothing a user said.
            r#"{"type":"message","id":"m0","parentId":null,"timestamp":"2026-10-02T13:45:12.600Z","message":{"role":"user","content":[{"type":"image","data":"AAAA","mimeType":"image/png"}],"timestamp":1790948712600}}"#,
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "the real first words"),
        ))
        .await;

        let extract = extracted(&path).await;

        assert_eq!(
            extract.first.as_deref(),
            Some("the real first words"),
            "an image-only turn is not what the user said"
        );
    }

    #[tokio::test]
    async fn text_parts_are_joined_the_way_pi_reads_them() {
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}",
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":[{"type":"text","text":"one"},{"type":"image","data":"AAAA","mimeType":"image/png"},{"type":"text","text":"two"}],"timestamp":1790948713000}}"#
        ))
        .await;

        let extract = extracted(&path).await;

        assert_eq!(extract.first.as_deref(), Some("one two"));
    }

    #[test]
    fn the_host_script_quotes_the_directory_it_walks() {
        let script = posix_summary_script("/home/o'brien/.pi/agent/sessions/--x--");

        // The directory is a path the user picked; it must reach the host as
        // data, never as shell.
        assert!(
            script.contains("for f in '/home/o'\\''brien/.pi/agent/sessions/--x--'/*.jsonl"),
            "got `{script}`"
        );
    }

    #[test]
    fn the_host_scripts_output_parses_back_into_lines() {
        let user = r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":"hi","timestamp":1790948713000}}"#;
        let name = r#"{"type":"session_info","id":"n1","parentId":null,"timestamp":"2026-10-02T13:50:00.000Z","name":"bugfix"}"#;
        let output = format!(
            "=== a.jsonl\n{HEADER}\n---\n{user}\n---\n{name}\n---\n\
             === b.jsonl\n{HEADER}\n---\n---\n---\n"
        );

        let extracted = parse_summary_output("/home/u/.pi/agent/sessions/--x--", &output);

        assert_eq!(extracted.len(), 2);
        assert_eq!(extracted[0].path, "/home/u/.pi/agent/sessions/--x--/a.jsonl");
        assert_eq!(extracted[0].extract.name.as_deref(), Some("bugfix"));
        assert_eq!(extracted[0].extract.first.as_deref(), Some("hi"));
        assert_eq!(extracted[1].extract.name, None, "an empty slot is an absent one");
    }

    #[test]
    fn the_windows_script_travels_as_its_own_encoded_parameter() {
        // `-EncodedCommand` is base64 of UTF-16LE: the script's quoting is the
        // only quoting in the world, whatever shells sit between pie and it.
        assert_eq!(base64_utf16le("abc"), "YQBiAGMA");

        let command = windows_summary_command(r"C:\Users\o'brien\sessions\--x--");

        assert!(
            command.starts_with("powershell -NoProfile -NonInteractive -EncodedCommand "),
            "got `{command}`"
        );
        let encoded = command.rsplit(' ').next().expect("the parameter");
        assert!(
            encoded
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='),
            "the script travels as base64, not as anyone's shell text: {encoded}"
        );
    }

    #[test]
    fn the_windows_script_escapes_the_directory_the_windows_way() {
        // PowerShell doubles a single quote inside a single-quoted string -
        // the one rule its own quoting has.
        let script = windows_summary_script(r"C:\Users\o'brien\sessions");

        assert!(script.contains(r"$d = 'C:\Users\o''brien\sessions'"), "got `{script}`");
    }

    #[test]
    fn a_hosts_absolute_paths_come_in_both_spellings() {
        // pie runs on one machine and reads another: both conventions are the
        // host's own, and a Windows host speaks neither pie's cwd nor POSIX.
        for path in ["/home/u/.pi", r"C:\Users\u\.pi", r"d:/sessions", r"\\server\share"] {
            assert!(is_absolute_on_the_host(path), "{path} is absolute on its host");
        }
        for path in [".pi", "sessions", "C:x", "C:sessions\\x"] {
            assert!(!is_absolute_on_the_host(path), "{path} is not");
        }
    }

    #[test]
    fn the_modified_time_formats_the_way_pi_stores_it() {
        // pi's own ISO strings and pie's file times have to land in one order
        // for the list to sort.
        assert_eq!(
            rfc3339_of_millis(1790948713000).as_deref(),
            Some("2026-10-02T13:45:13.000Z")
        );
    }

    #[tokio::test]
    async fn the_fallback_reads_past_the_system_entry_to_the_first_turn() {
        // pi writes its system entry - every tool definition it has loaded -
        // before the first turn, as one line no fixed window outruns. The
        // fallback's head read stops at the turn instead.
        let mut content = format!("{HEADER}\n{}\n", system_line(&"x".repeat(200_000)));
        content.push_str(&user_line(
            "m1",
            "2026-10-02T13:45:13.000Z",
            1790948713000,
            "past the wall",
        ));
        content.push('\n');
        let (_keep, path) = on_disk(&content).await;

        let mut opened = tokio::fs::File::open(&path).await.expect("the file");
        let extract = read_fragments(&mut opened, Some(0)).await.expect("the fragments");

        assert_eq!(
            extract.first.as_deref(),
            Some("past the wall"),
            "the head read has to pass the system entry to reach the first turn"
        );
    }

    #[test]
    fn the_scan_finds_a_turn_split_across_its_own_calls() {
        // Only what arrived since the last call is looked at, so a literal half
        // at the end of one call and half at the start of the next must still
        // stop the scan.
        let mut scan = HeadScan::default();
        let mut head = br#"{"type":"message","id":"m1","message":{"role":"us"#.to_vec();
        assert!(!first_turn_is_whole(&head, &mut scan), "half a turn is not a turn");

        head.extend_from_slice(b"er\"}}\n");
        assert!(first_turn_is_whole(&head, &mut scan), "the whole one is");
    }

    #[tokio::test]
    async fn the_fallbacks_head_read_stays_within_its_budget() {
        let (_keep, path) = on_disk(&format!("{HEADER}\n{}", system_line(&"x".repeat(HEAD_BYTES * 2)))).await;

        let mut opened = tokio::fs::File::open(&path).await.expect("the file");
        let mut scan = HeadScan::default();
        let mut head = Vec::new();
        let mut chunk = [0u8; READ_CHUNK];
        while head.len() < HEAD_BYTES {
            let room = (HEAD_BYTES - head.len()).min(READ_CHUNK);
            let read = tokio::io::AsyncReadExt::read(&mut opened, &mut chunk[..room])
                .await
                .expect("the read");
            if read == 0 {
                break;
            }
            head.extend_from_slice(&chunk[..read]);
            if first_turn_is_whole(&head, &mut scan) {
                break;
            }
        }

        assert!(head.len() <= HEAD_BYTES, "got {} bytes", head.len());
    }

    #[tokio::test]
    async fn the_fallbacks_name_scan_meets_the_last_rename_first() {
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}\n{}",
            name_line("n1", "First"),
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi"),
            name_line("n2", "Last"),
        ))
        .await;

        let mut opened = tokio::fs::File::open(&path).await.expect("the file");
        let size = opened.metadata().await.expect("the metadata").len();

        assert_eq!(
            name_backwards(&mut opened, Some(size))
                .await
                .expect("the scan")
                .as_deref(),
            Some("Last")
        );
    }

    #[tokio::test]
    async fn the_fallbacks_name_scan_crosses_its_block_boundaries_whole() {
        let filler = "y".repeat(NAME_BLOCK - 8);
        let (_keep, path) = on_disk(&format!(
            "{HEADER}\n{}\n{}",
            system_line(&filler),
            name_line("n1", "across the seam")
        ))
        .await;

        let mut opened = tokio::fs::File::open(&path).await.expect("the file");
        let size = opened.metadata().await.expect("the metadata").len();

        assert_eq!(
            name_backwards(&mut opened, Some(size))
                .await
                .expect("the scan")
                .as_deref(),
            Some("across the seam")
        );
    }

    #[tokio::test]
    async fn the_fallback_never_shows_a_name_the_file_does_not_hold_latest() {
        // The one thing the fallback owes when it cannot see the whole file:
        // a miss is no name, never an older one. The name sits past the head
        // and before the tail window - the gap a mid-size file really has.
        let mut content = format!("{HEADER}\n{}\n", system_line(&"x".repeat(HEAD_BYTES)));
        content.push_str(&name_line("n1", "early"));
        content.push('\n');
        content.push_str(&"z".repeat(NAME_SCAN_BYTES as usize + NAME_BLOCK * 2));
        content.push('\n');
        let (_keep, path) = on_disk(&content).await;

        let mut opened = tokio::fs::File::open(&path).await.expect("the file");
        let size = opened.metadata().await.expect("the metadata").len();
        let extract = read_fragments(&mut opened, Some(size)).await.expect("the fragments");

        assert_eq!(
            extract.name, None,
            "the early name is out of both windows and stays out"
        );
    }

    #[test]
    fn a_forgotten_channel_leaves_the_slot_ready_for_a_new_one() {
        // The one thing a cached channel owes: after a listing failed over it,
        // the slot must be empty so the next listing builds a fresh one.
        // Building a channel itself needs a real sftp handshake - the fixture
        // tests cover that half - so what is under test here is the identity
        // rule, told apart from the handshake with a stand-in type.
        let installed = Arc::new(());
        let mut slot = Some(Arc::clone(&installed));

        assert!(
            !drop_if_same(&mut slot, &Arc::new(())),
            "another listing's channel stays"
        );
        assert!(
            slot.is_some(),
            "the healthy one another listing installed is not thrown away"
        );

        assert!(drop_if_same(&mut slot, &installed), "the very channel that failed goes");
        assert!(slot.is_none(), "so the next listing opens a fresh one");
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
        // Neither a directory nor a session file: ignored by both kinds.
        std::fs::write(root.join("stray.txt"), HEADER).expect("the stray");

        let summaries = list_local(&root).await.expect("the listing");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "s1");
        assert_eq!(summaries[0].path, file.to_string_lossy());
    }

    #[tokio::test]
    async fn a_local_listing_of_nothing_is_not_a_failure() {
        let directory = tempfile::tempdir().expect("a temp directory");

        let summaries = list_local(&directory.path().join("no-such-dir"))
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
            // Running as root ignores the mode; the skip has nothing to prove.
            return;
        }

        let summaries = list_local(root.path()).await.expect("the listing");

        assert_eq!(summaries.len(), 1, "the readable project is still listed");
        assert_eq!(summaries[0].id, "s1");
    }

    #[tokio::test]
    async fn the_local_picker_rows_put_directories_first_and_carry_full_paths() {
        let directory = tempfile::tempdir().expect("a temp directory");
        std::fs::create_dir(directory.path().join("b-dir")).expect("the directory");
        std::fs::create_dir(directory.path().join("a-dir")).expect("the directory");
        std::fs::write(directory.path().join("z-file"), "").expect("the file");

        let rows = list_dirs_local(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing");

        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["a-dir", "b-dir", "z-file"]);
        assert_eq!(rows.iter().filter(|row| row.is_dir).count(), 2);
        for row in &rows {
            assert!(
                Path::new(&row.path).is_absolute(),
                "rows carry whole paths: {}",
                row.path
            );
        }
    }

    #[tokio::test]
    async fn the_local_picker_follows_a_link_to_a_directory() {
        // A picker that cannot walk into a linked directory has lost half of
        // some home directories.
        let directory = tempfile::tempdir().expect("a temp directory");
        let target = directory.path().join("elsewhere");
        std::fs::create_dir(&target).expect("the target");
        std::os::unix::fs::symlink(&target, directory.path().join("a-link")).expect("the link");

        let rows = list_dirs_local(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing");

        let link = rows
            .iter()
            .find(|row| row.name == "a-link")
            .expect("the link is listed");
        assert!(link.is_dir, "a link to a directory is a directory to a picker");
    }

    #[tokio::test]
    async fn a_broken_link_is_a_row_and_not_a_failure() {
        // Home directories full of stale dotfile links are the normal case,
        // not the exception; one of them must not take the listing down.
        let directory = tempfile::tempdir().expect("a temp directory");
        std::os::unix::fs::symlink(directory.path().join("nowhere"), directory.path().join("stale")).expect("the link");
        std::fs::write(directory.path().join("z-file"), "").expect("the file");

        let rows = list_dirs_local(None, Some(directory.path().to_str().expect("utf-8")))
            .await
            .expect("the listing");

        let stale = rows.iter().find(|row| row.name == "stale").expect("the link is listed");
        assert!(!stale.is_dir, "a link that leads nowhere is not a walkable directory");
    }

    #[tokio::test]
    async fn the_picker_takes_no_relative_path() {
        // pie resolves no path against its own directory: on a phone that is
        // not anyone's home, and the two reaches would not even agree on it.
        for path in [".", "..", "sessions", "./sessions"] {
            let error = list_dirs_local(None, Some(path))
                .await
                .expect_err("`{path}` is relative");
            assert!(matches!(error, PieError::Internal { .. }), "got {error:?}");
        }
    }

    /// The listings of this machine's real sessions, checked against pi's own
    /// way of reading a file: whole-file, latest name, first user words.
    ///
    /// Reads whatever sessions exist on the machine running it, so it is
    /// ignored here and run when the reading of real data matters.
    #[tokio::test]
    #[ignore = "reads whatever sessions exist on this machine"]
    async fn the_names_of_this_machines_sessions_all_come_out_right() {
        let root = local_sessions_root().expect("a home");
        let summaries = list_local(&root).await.expect("the listing");

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
