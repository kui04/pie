//! The files of the host, as pie reads them.
//!
//! Pi keeps its sessions as JSONL files under `~/.pi/agent/sessions/` and has
//! no command to list them. Therefore pie reads them itself. A summary needs
//! three values: the header line, the first words of the user, and the latest
//! name. Pie reads each value at the place of the file. Therefore a listing
//! moves those lines and nothing else:
//!
//! - **Here**, pie reads the full filesystem, as the scan of pi reads it
//!   (pinned `core/session-manager.ts`, `buildSessionInfo`). This is exact, and
//!   local reads cost nothing.
//! - **Over SSH**, one command for each project directory asks the host itself:
//!   `head`, `awk`, `grep`, and `tail` at their locations, or PowerShell on
//!   Windows, or the tools that the host already has. The reply contains those
//!   lines only. The file never travels.
//! - If that host answers in no shell that pie can use, the fallback reads
//!   fragments over sftp: the head up to the first user turn, and the name
//!   backwards from the end. Pi appends a rename. Therefore the last rename meets
//!   the scan first. Only then is the name approximate: pie misses a name in the
//!   middle of a large file, and never replaces it with an older name.
//!
//! `modified` is the time of the last growth of the file. Pi computes the
//! greatest message time in the full file. The last write of the file is that
//! time or later (pi appends). The listing carries the value at no cost, and it
//! never puts the order wrong.

use std::io::SeekFrom;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt};
use tokio::task::JoinSet;

use crate::connection::Error;
use crate::error::PieError;
use crate::transport::{SshSession, SubsystemStream, Termination};

use pi_rpc::entry::Entry;
use pi_rpc::message::{Message, UserBlock, UserContent};

/// The number of session files that one listing reads at the same time. The
/// drawer of pi reads its own list with the same bound
/// (`MAX_CONCURRENT_SESSION_INFO_LOADS` of `core/session-manager.ts`, pinned).
const MAX_CONCURRENT_LOADS: usize = 10;

/// The largest part of the head of a session file that the fallback reads. The
/// read stops earlier if the first user turn is present. Pi writes its system
/// entry, with all tool definitions that it loaded, before that turn. One line
/// of that size is larger than a small window.
const HEAD_BYTES: usize = 1024 * 1024;

/// The distance from the end of a file that the name scan of the fallback
/// covers before it stops. Pi appends renames. Therefore the last rename is
/// usually near the end. A scan that exceeds this limit returns no name.
const NAME_SCAN_BYTES: u64 = 1024 * 1024;

/// One block of a name scan that moves backwards.
const NAME_BLOCK: usize = 16 * 1024;

/// One read of the head scan.
const READ_CHUNK: usize = 8 * 1024;

/// The maximum part of one line that the extraction on the host prints.
///
/// A first message is usually one sentence. A first message of pasted code can
/// be very large. A summary line of that size is too large for the value that it
/// gives. A truncated line parses as nothing. Therefore such a session has no
/// first message in the listing.
const SCRIPT_TEXT_CAP: usize = 64 * 1024;

/// The number of `"role":"user"` lines that the extraction on the host prints as
/// candidates for the first message.
///
/// The script selects lines, not the answer. The reader decides whether a
/// candidate says something, as for the local read. Two cases make this
/// important: a first turn can be an image without words, and a line can look
/// like a user turn but is not one. A script that stopped at the first
/// candidate of its choice would lose the true first message in both cases.
/// Four covers the turns without words before a turn with words. After that,
/// pie omits the first message and does not guess.
const SCRIPT_FIRST_CANDIDATES: usize = 4;

/// The place where pi keeps its sessions on a host reached over SSH, relative to
/// the login home. An sftp session starts there, and the `.pi` root of pi
/// follows `HOME` (pinned `core/config.ts`, `CONFIG_DIR_NAME`). This is the
/// default that pi resolves if neither environment override is set.
pub(crate) const REMOTE_SESSIONS_ROOT: &str = ".pi/agent/sessions";

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

/// Pi expands a leading `~` in these paths (pinned `expandTildePath`). A value
/// without a `~` stays as it is, with or without a home.
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

/// One directory level, as the directory picker walks it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    /// The name in the directory.
    pub name: String,
    /// The place of the entry, as the host sees it. The value is absolute.
    /// Therefore the picker walks with these values and never builds a path.
    /// Pie resolves nothing relative to its own directory.
    pub path: String,
    /// Whether the entry is a directory. A link to a directory counts, because
    /// the picker must walk into it.
    pub is_dir: bool,
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
struct FileHeader {
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

/// The three lines for a summary, from any place of the read.
#[derive(Debug, Default, Clone)]
struct Extract {
    /// The header line of the file.
    header: Option<String>,
    /// The first words of the user, as pi reads them.
    first: Option<String>,
    /// The latest display name in the file, including a clear.
    name: Option<String>,
}

/// Builds a summary from the extracted lines of one file.
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

/// The shell that extracts the summary lines of one project directory on the
/// host.
///
/// One pass for each file: the header, the latest name, and the first lines that
/// look like user turns. [`first_text`] decides which of those turns say
/// something, as the local read does. Every POSIX system ships `sh`, `printf`,
/// `head`, `awk`, `grep`, and `tail`. The guard turns a host without them into a
/// clear failure. Then the Windows script or the sftp fallback gets its turn. The
/// session file names come from pi (`<timestamp>_<id>.jsonl`). Therefore a plain
/// glob is safe over them.
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
/// Windows ships no POSIX shell. Every supported Windows ships PowerShell, and
/// the same three lines come back in the same shape. Pie builds the script here.
/// It travels as its own parameter (see [`windows_summary_command`]). Therefore
/// the directory that the user selected never passes through the quoting rules
/// of a shell.
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

/// How pie runs [`windows_summary_script`]: `powershell` with the script as its
/// own encoded parameter.
///
/// `-EncodedCommand` takes base64 of UTF-16LE, and PowerShell decodes it itself.
/// Therefore the quoting of the script is the only quoting here. The script sets
/// the console encoding to UTF-8. Without that step, Windows PowerShell prints in
/// the OEM code page, and a name with a character outside ASCII returns as
/// unwanted characters.
fn windows_summary_command(dir: &str) -> String {
    format!(
        "powershell -NoProfile -NonInteractive -EncodedCommand {}",
        base64_utf16le(&windows_summary_script(dir))
    )
}

/// The base64 of `script` as UTF-16LE, the only encoding for `-EncodedCommand`.
fn base64_utf16le(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// What one summary block of the output of [`posix_summary_script`] carries.
struct Extracted {
    /// The place of the file: `dir` and the name of the block. This is the same
    /// join as the sftp listing makes, so the two agree by path.
    path: String,
    extract: Extract,
}

/// Asks the host where pi keeps its sessions, for a host with another location.
///
/// The question goes to the login shell that also starts pi itself. Therefore
/// the answer is the environment that pi sees. The host answers even with
/// neither override set, with the default. Therefore `None` means that the host
/// gives no answer at all. That is the only case where the caller uses its own
/// default. The function finishes a leading `~` here and not in the shell,
/// against the home that the host reported (pi expands it too, pinned
/// `expandTildePath`). Without that step, pie would take `~/pi-sessions` for a
/// path that is absent, and the listing would be empty with no message.
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

/// The shell that asks the host where its sessions are, in the same order as
/// [`sessions_root_from`] reads them: the sessions root, or the agent root plus
/// `sessions`, or the default under the home.
///
/// Two lines come back: the value, and the home of the host. Pi expands a leading
/// `~` in these paths (pinned `expandTildePath`), and a shell expands nothing in a
/// variable. Therefore the value keeps its `~`, and pie finishes the step against
/// the home that the host reported.
fn posix_root_script() -> String {
    "if [ -n \"$PI_CODING_AGENT_SESSION_DIR\" ]; then printf '%s\\n' \"$PI_CODING_AGENT_SESSION_DIR\"; \
     elif [ -n \"$PI_CODING_AGENT_DIR\" ]; then printf '%s\\n' \"$PI_CODING_AGENT_DIR/sessions\"; \
     else printf '%s\\n' \"$HOME/.pi/agent/sessions\"; fi; printf '%s\\n' \"$HOME\""
        .to_string()
}

/// The same question in PowerShell, for a Windows host: the value, then the home,
/// on two lines. These are the same two lines that [`posix_root_script`] sends.
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

/// Runs one summary script on the host and reads its blocks.
///
/// `None` if the host does not run it: no such shell, or no such tools. Then the
/// caller tries the other script.
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

/// Reads the output of [`posix_summary_script`] into lines for each file.
///
/// Each `=== ` block has three slots, separated by `---`: the header, the
/// candidates for the first message, and the name. An empty slot is an absent
/// value; the host prints the separators in all cases. The first slot can hold
/// several candidate lines. The first line that [`first_text`] can use is the
/// first message. Therefore a turn without words does not consume the turn after
/// it.
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

/// Reads the two fragments of one session file for the fallback.
///
/// The head up to the first user turn, and the name backwards from the end. Both
/// reads have a limit, whatever the file does. Only a full file can show a name
/// in the middle. Such a name comes back as no name, not as a guess.
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

/// The position of the head scan in the line that it still reads.
#[derive(Default)]
struct HeadScan {
    /// The end of the last line that is complete. The current line starts here.
    line_start: usize,
    /// The distance into the current line that pie already searched for the
    /// literal.
    searched: usize,
}

/// Whether the head read holds a full user turn to stop at.
///
/// The function reads only the bytes that arrived after the last call. The system
/// entry of pi is one line that can span the full head, and a new scan of it for
/// each chunk would cost more than the read. A serialized user message always
/// carries the literal. The opposite risk is real, but it was in none of the real
/// sessions that pie checked: a similar value in the arguments of a tool would
/// stop the scan early and lose the first message. The failure is an omission,
/// never an invention.
fn first_turn_is_whole(head: &[u8], scan: &mut HeadScan) -> bool {
    // All lines that the new bytes completed, not only the first. The head is a
    // budget of bytes. A chunk of short lines must not move the scan one line at
    // a time.
    let mut found = false;
    while !found {
        let fresh = &head[scan.searched..];
        let Some(at) = fresh.iter().position(|byte| *byte == b'\n') else {
            // The scan is still in one line. Record the distance read, and wait
            // for the end of the line. Do not read the same bytes again.
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
/// Pi appends a `session_info` entry at each rename of a session and takes the
/// last one (pinned `buildSessionInfo`). Therefore a scan backwards from the end
/// meets that entry first. The scan stops at the first entry that it meets,
/// usually one or two lines in, at [`NAME_SCAN_BYTES`], or at the start of the
/// file. A name beyond the limit comes back as no name. An older name never takes
/// its place.
async fn name_backwards<F>(file: &mut F, size: Option<u64>) -> std::io::Result<Option<String>>
where
    F: AsyncRead + AsyncSeek + Unpin,
{
    // The listing usually carries the size. Pie asks the host directly if the
    // host did not send it, and does not skip the file.
    let size = match size {
        Some(size) => size,
        None => file.seek(SeekFrom::End(0)).await?,
    };
    let budget = size.min(NAME_SCAN_BYTES);
    let mut position = size;
    let mut scanned = 0u64;
    // The half line at the left edge of the scanned part continues into the block
    // that pie reads next.
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

        // Full lines first, newest first. The part that remains at the left edge
        // continues into the next round.
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

/// The sessions that pi wrote under a local `sessions` directory.
///
/// Pie skips a file or a project directory that it cannot read, and does not fail
/// the listing. One damaged part must not hide the rest. The scan of pi also drops
/// unreadable entries.
pub(crate) async fn list_local(root: &Path) -> Result<Vec<SessionSummary>, Error> {
    let mut summaries = Vec::new();
    let mut candidates = Vec::new();
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
            candidates.push(SessionFile {
                shown: path.to_string_lossy().into_owned(),
                path,
            });
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
            let Some(file) = pending.next() else { break };
            reads.spawn_blocking(move || summary_of_file(file));
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

/// One file of the list that a walk of the sessions directory found.
struct SessionFile {
    /// The path as the host shows it, which is what a row carries (`summary_of`).
    shown: String,
    /// The path this machine opens.
    path: PathBuf,
}

/// The summary of one session file, or nothing if it is not one.
///
/// This runs on a blocking thread of the runtime: a listing reads many files, and
/// a file of a long conversation is not small. The failure of one file is the
/// loss of one row, not of the listing (`tracing::warn`).
fn summary_of_file(file: SessionFile) -> Option<SessionSummary> {
    let SessionFile { shown, path } = file;
    let modified = std::fs::metadata(&path)
        .ok()
        .and_then(|stats| stats.modified().ok())
        .and_then(rfc3339);
    let opened = match std::fs::File::open(&path) {
        Ok(opened) => opened,
        Err(error) => {
            tracing::warn!(path = %shown, %error, "skipping a session file pie cannot read");
            return None;
        }
    };
    match read_local(opened) {
        Ok(extract) => summary_of(&shown, extract, modified),
        Err(error) => {
            tracing::warn!(path = %shown, %error, "skipping a session file pie cannot read");
            None
        }
    }
}

/// The same listing over SSH.
///
/// The host extracts the summary lines, with one command for each project
/// directory. Therefore a listing moves those lines and nothing else. A host with
/// a shell that pie cannot use falls back to fragments over sftp.
pub(crate) async fn list_remote(session: &SshSession, sftp: &SftpSession) -> Result<Vec<SessionSummary>, Error> {
    let mut summaries = Vec::new();
    let root = host_sessions_root(session)
        .await
        .unwrap_or_else(|| REMOTE_SESSIONS_ROOT.to_string());
    let root = match sftp.canonicalize(&root).await {
        Ok(root) => root,
        // A host where pi did not run yet has no such directory. That is a host
        // without sessions, not a failed listing.
        Err(error) if is_no_such_file(&error) => return Ok(summaries),
        Err(error) => return Err(unreadable_there(&root, error)),
    };
    let projects = sftp
        .read_dir(&root)
        .await
        .map_err(|error| unreadable_there(&root, error))?;
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
            // A Windows host has no POSIX shell. PowerShell gives the same three
            // lines before pie falls back to the read of fragments.
            _ => host_summary(session, &dir, windows_summary_command(&dir))
                .await
                .unwrap_or_default(),
        };
        // This is not what either script printed, or neither script ran. Pie
        // reads the fragments of the file over sftp and does not drop the row. It
        // says so one time, so a host with scripts that stopped without a message
        // is not a host with nothing to show.
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
                // This is not what the script said it would print. Pie reads the
                // fragments of the file over sftp and does not drop the row.
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

/// Reads one session file of this machine for its summary.
///
/// The whole file goes through the reader, because the name of a session may be
/// anywhere in it: a rename that a long conversation followed sits far from the
/// end, and a listing that shows no name for it would be wrong. What the read
/// saves is the parse: only the three kinds of line that a summary needs are
/// parsed as JSON - the header, the first turn of the user, and a rename. Every
/// other line, which is the bulk of a long transcript, is searched for a
/// literal and dropped.
fn read_local(file: impl Read) -> std::io::Result<Extract> {
    let mut lines = BufReader::with_capacity(READ_CHUNK * 4, file);
    let mut buffer = Vec::new();
    let mut extract = Extract::default();
    loop {
        buffer.clear();
        if lines.read_until(b'\n', &mut buffer)? == 0 {
            break;
        }
        let line = buffer.trim_ascii_end();
        if extract.header.is_none() {
            extract.header = Some(String::from_utf8_lossy(line).into_owned());
            continue;
        }
        if extract.first.is_none() && holds(line, b"user") {
            // The line goes to the parser the way the reader of pi sees it: one bad
            // byte is a replacement character, not a line that says nothing. The
            // decode costs nothing for a line that is valid UTF-8, which is nearly
            // every line, and it happens only for a line this filter kept.
            let line = String::from_utf8_lossy(line);
            if let Some(text) = first_text(line.as_bytes()) {
                extract.first = Some(text);
            }
        }
        // The latest name wins, including a clear. Pi appends a `session_info`
        // entry at each rename, and the scan of pi reads the last one.
        if holds(line, b"session_info") {
            let line = String::from_utf8_lossy(line);
            if let Some(name) = name_in(line.as_bytes()) {
                extract.name = name;
            }
        }
    }
    Ok(extract)
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

/// One directory level on the local filesystem, for the directory picker.
///
/// The paths are absolute and belong to the host. Pie resolves nothing relative to
/// its own directory, which on a phone is not the home of a person. `path` is
/// `None` for the home directory of the connection: the home of the app, which
/// pie does not look up again here.
pub(crate) async fn list_dirs_local(home: Option<&Path>, path: Option<&str>) -> Result<Vec<DirEntryInfo>, Error> {
    let path = match path {
        None => home.map(Path::to_path_buf).ok_or(Error::NoHomeDirectory)?,
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
        rows.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(rows)
}

/// The same directory level over an sftp channel. `None` asks for the login home,
/// which is the start of an sftp session.
pub(crate) async fn list_dirs_remote(sftp: &SftpSession, path: Option<&str>) -> Result<Vec<DirEntryInfo>, Error> {
    let base = match path {
        None => sftp
            .canonicalize(".")
            .await
            .map_err(|error| unreadable_there("the login home", error))?,
        Some(path) => {
            if !is_absolute_on_the_host(path) {
                // These are the paths of the host, not the paths of this machine.
                // Over sftp they are as the host writes them, POSIX or Windows.
                // Neither is the directory of pie.
                return Err(not_absolute(path));
            }
            path.to_string()
        }
    };
    let entries = sftp
        .read_dir(&base)
        .await
        .map_err(|error| unreadable_there(&base, error))?;
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

/// Whether an sftp entry is a directory that a picker can walk, with links.
///
/// sftp reports what the link is, not where it points. The picker needs the
/// target. Therefore pie asks about a link on its own: one round trip for the
/// links, and no round trip for everything else.
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

/// [`FileAttributes::is_dir`], with a name so that the `?` reads well.
fn is_dir(attrs: &FileAttributes) -> bool {
    attrs.is_dir()
}

/// The sftp channel over an SSH session. Pie opens it at the first use and keeps
/// it.
///
/// The open happens at the first use, not at the connect. A host whose sshd serves
/// no `sftp` subsystem still runs pi correctly, and only the file listing is lost.
/// The value is shared by pointer: a channel is one object that the session answers
/// on, and a listing reads it from several places at the same time. The value is
/// also in a slot and not fixed, because a channel can die under a live connection
/// (see [`forget_sftp`]).
pub(crate) async fn sftp(
    session: &SshSession,
    cell: &Mutex<Option<Arc<SftpSession>>>,
) -> Result<Arc<SftpSession>, PieError> {
    let cached = cell.lock().unwrap_or_else(PoisonError::into_inner).clone();
    if let Some(sftp) = cached {
        return Ok(sftp);
    }
    let stream: SubsystemStream = session.subsystem("sftp").await?;
    let opened = SftpSession::new(stream).await.map_err(|source| Error::SftpUnanswered {
        endpoint: session.endpoint().to_string(),
        source,
    })?;
    let opened = Arc::new(opened);
    // A failed open leaves the slot empty. Therefore the next listing tries
    // again. A host can also serve no sftp yet.
    *cell.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&opened));
    Ok(opened)
}

/// Drops the cached sftp channel after a failed listing over it, but only if it is
/// the same channel that the listing used.
///
/// A listing that raced another listing can report a failure over a channel that
/// the other listing already replaced with a new channel in good condition. A clear
/// would throw away a channel in operation for a failure with no relation to it.
/// The identity check makes each listing responsible for its own channel.
pub(crate) fn forget_sftp(cell: &Mutex<Option<Arc<SftpSession>>>, used: &Arc<SftpSession>) {
    drop_if_same(&mut cell.lock().unwrap_or_else(PoisonError::into_inner), used);
}

/// Clears `slot` if it still holds the object that `used` points at.
///
/// The function is generic, so the identity rule is separate from the sftp
/// handshake that it guards. The question is "is this the same object", not "is
/// this object in operation".
fn drop_if_same<T>(slot: &mut Option<Arc<T>>, used: &Arc<T>) -> bool {
    if slot.as_ref().is_some_and(|cached| Arc::ptr_eq(cached, used)) {
        *slot = None;
        true
    } else {
        false
    }
}

/// The newest conversation first, the order of the session list.
fn newest_first(summaries: &mut [SessionSummary]) {
    summaries.sort_by(|a, b| b.modified.cmp(&a.modified));
}

/// A path on this machine that pie cannot read appears as any other failure of the
/// reach. The frontend offers the same retry, and the message names the path at
/// fault.
fn unreadable(path: &str, source: std::io::Error) -> Error {
    Error::UnreadableLocal {
        path: path.to_string(),
        source,
    }
}

/// The same for a path on the host, over sftp.
fn unreadable_there(path: &str, source: SftpError) -> Error {
    Error::UnreadableRemote {
        path: path.to_string(),
        source,
    }
}

/// A relative path is a mistake of the frontend, not a failure of the host.
///
/// The function has a name so that a caller with a connection can reject such a
/// path before the handshake of a channel.
pub(crate) fn not_absolute(path: &str) -> Error {
    Error::NotAbsolute { path: path.to_string() }
}

/// The path of a session file, or the mistake of a caller that handed in another.
///
/// A session file is named the way the listings hand it out: absolutely. pi resolves
/// a relative path against its own directory, which on a phone is not the home of a
/// person. The answer comes before any channel or process is touched.
///
/// # Errors
///
/// [`Error::NotAbsolute`].
pub(crate) fn checked_session_path(path: &str) -> Result<&str, Error> {
    if is_absolute_on_the_host(path) {
        Ok(path)
    } else {
        Err(not_absolute(path))
    }
}

/// Whether `path` is absolute on the host that it names: POSIX or Windows style.
///
/// These conventions belong to the host, not to this machine. Pie operates on one
/// machine and reads the other, so both spellings belong to the host. The function
/// has a name so that a caller with a connection can reject a relative path before
/// the handshake of a channel.
pub(crate) fn is_absolute_on_the_host(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with("\\\\")
        || matches!(
            path.as_bytes(),
            [drive, b':', sep, ..] if drive.is_ascii_alphabetic() && matches!(sep, b'\\' | b'/')
        )
}

/// Whether an sftp failure is only "there is no such path".
fn is_no_such_file(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

/// Reads the next directory entry. The function names the directory of the listing
/// if pie cannot read one of its entries.
async fn next_entry(entries: &mut tokio::fs::ReadDir, shown: &str) -> Result<Option<tokio::fs::DirEntry>, Error> {
    entries.next_entry().await.map_err(|error| unreadable(shown, error))
}

/// Quotes `text` for a POSIX shell, so that it reaches the remote command without
/// a change.
///
/// The same quoting is in the transport, which cannot share it across
/// the module boundary. The two encode different values: a directory that the user
/// selected here, and a remote command there. Therefore a change to one is a change
/// to both.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first line of a session file, as pi writes it.
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
        let opened = std::fs::File::open(path).expect("the file");
        read_local(opened).expect("the read")
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

        let extract = extracted(&path).await;

        assert_eq!(extract.name.as_deref(), Some("Far away"));
        assert_eq!(extract.first.as_deref(), Some("hi"));
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

        let extract = extracted(&path).await;

        assert_eq!(
            extract.first.as_deref(),
            Some("hi \u{fffd} there"),
            "the one bad byte became a replacement character, not a missing session"
        );
    }

    #[test]
    fn the_first_slot_takes_the_first_candidate_the_reader_can_use() {
        // The script prints candidates, not the answer. A turn that says nothing
        // (an image, or a similar line) must not consume the message after it.
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
        // Pi takes the latest `session_info` entry, whatever the growth of the
        // file. A full read sees the entries in order and keeps the last one.
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
            // This is not a message.
            r#"{"type":"usage","id":"u1","parentId":null,"timestamp":"2026-10-02T13:45:12.500Z","kind":"cache_warm"}"#,
            // This is a message, but the user said nothing.
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

        // The directory is a path that the user selected. It must reach the host
        // as data, never as shell text.
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
        // `-EncodedCommand` takes base64 of UTF-16LE. The quoting of the script is
        // the only quoting, whatever shell is between pie and the script.
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
        // PowerShell writes two single quotes for one single quote in a
        // single-quoted string. That is the only rule of its quoting.
        let script = windows_summary_script(r"C:\Users\o'brien\sessions");

        assert!(script.contains(r"$d = 'C:\Users\o''brien\sessions'"), "got `{script}`");
    }

    #[test]
    fn a_hosts_absolute_paths_come_in_both_spellings() {
        // Pie operates on one machine and reads another. Both conventions belong
        // to the host. A Windows host uses neither the cwd of pie nor POSIX.
        for path in ["/home/u/.pi", r"C:\Users\u\.pi", r"d:/sessions", r"\\server\share"] {
            assert!(is_absolute_on_the_host(path), "{path} is absolute on its host");
        }
        for path in [".pi", "sessions", "C:x", "C:sessions\\x"] {
            assert!(!is_absolute_on_the_host(path), "{path} is not");
        }
    }

    #[test]
    fn a_session_file_is_named_absolutely() {
        // The rule that `switch_session` answers with before it touches the client.
        assert_eq!(
            checked_session_path("/home/u/.pi/agent/sessions/x/one.jsonl").expect("absolute"),
            "/home/u/.pi/agent/sessions/x/one.jsonl"
        );
        assert!(matches!(
            checked_session_path("sessions/one.jsonl"),
            Err(Error::NotAbsolute { .. })
        ));
        assert!(matches!(checked_session_path(""), Err(Error::NotAbsolute { .. })));
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

    #[tokio::test]
    async fn the_fallback_reads_past_the_system_entry_to_the_first_turn() {
        // Pi writes its system entry, with all tool definitions that it loaded,
        // before the first turn, as one line that no fixed window covers. The head
        // read of the fallback stops at the turn instead.
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
        // The function reads only the bytes that arrived after the last call.
        // Therefore a literal with one half at the end of one call and one half at
        // the start of the next must still stop the scan.
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
        // The fallback cannot see the full file. It owes one result: a miss is no
        // name, never an older name. The name is beyond the head and before the
        // tail window. That is the gap of a file of middle size.
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
        // A cached channel owes one result: after a failed listing over it, the
        // slot must be empty so that the next listing builds a new channel. The
        // build of a channel needs a real sftp handshake. The fixture tests cover
        // that half. Therefore this test covers the identity rule, with a
        // stand-in type and no handshake.
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
        // This is neither a directory nor a session file. Both kinds ignore it.
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
            // A run as root ignores the mode. The skip has nothing to prove.
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
        // A picker that cannot walk into a linked directory loses half of some
        // home directories.
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
        // Home directories full of old dotfile links are the usual case, not the
        // exception. One of them must not stop the listing.
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
        // Pie resolves no path against its own directory: on a phone that
        // directory is not the home of a person, and the two paths would not even
        // agree on it.
        for path in [".", "..", "sessions", "./sessions"] {
            let error = list_dirs_local(None, Some(path))
                .await
                .expect_err("`{path}` is relative");
            assert!(matches!(error, Error::NotAbsolute { .. }), "got {error:?}");
        }
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
