//! The conversations of an SSH host, read by the host itself.
//!
//! One command for each project directory asks the host: `head`, `awk`, `grep`
//! and `tail` at their locations, or PowerShell on Windows, or the tools that the
//! host already has. The reply contains the three lines of each summary and
//! nothing else, so the file never travels. If the host answers in no shell that
//! pie can use, the fallback reads fragments over sftp: the head up to the first
//! user turn, and the name backwards from the end. Pi appends a rename, so the
//! last rename meets the scan first. Only then is the name approximate: pie
//! misses a name in the middle of a large file, and never replaces it with an
//! older name.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt};

use crate::channel::Termination;
use crate::error::PieError;
use crate::host::files::{is_no_such_file, sftp, sftp_is_dir, unreadable_there};
use crate::host::quote;
use crate::host::{Error, SshHost};

use super::{READ_CHUNK, SessionSummary, SessionSummaryLines, expand_home, first_text, name_in, newest_first, rfc3339};

/// One host's conversations, as the tools of that host report them.
pub(crate) struct Ssh {
    /// The host the connection reached, as a handle of the same reach that the
    /// host itself holds. The listing runs over its channels: one exec for each
    /// project directory, and the sftp channel of the same reach.
    host: Arc<SshHost>,
}

impl Ssh {
    /// The reader of one host.
    pub(super) fn new(host: Arc<SshHost>) -> Self {
        Self { host }
    }

    /// Every conversation that pi wrote on this host, the newest first.
    ///
    /// # Errors
    ///
    /// [`Error::UnreadableRemote`] when a directory or a file cannot be read, and
    /// the failure of the reach itself. A path at fault names itself in the
    /// message.
    pub(super) async fn summaries(&self) -> Result<Vec<SessionSummary>, PieError> {
        let sftp = sftp(&self.host).await?;
        match self.list(&sftp).await {
            Ok(summaries) => Ok(summaries),
            Err(error) => {
                // A failed listing must not keep a dead channel in the cache.
                self.host.forget_sftp(&sftp);
                Err(error.into())
            }
        }
    }

    /// The sessions root of this host, as pi itself resolves it there, or `None`
    /// when the host answers with none.
    ///
    /// The question goes to the login shell that also starts pi itself. Therefore
    /// the answer is the environment that pi sees.
    async fn sessions_root(&self) -> Option<String> {
        for command in [posix_root_script(), windows_root_command()] {
            if let Ok(output) = self.host.session().output(command).await
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

    /// Runs one summary script on this host and reads its blocks, one per file.
    ///
    /// `None` if the host does not run it: no such shell, or no such tools. Then
    /// the caller tries the other script.
    async fn summary(&self, dir: &str, command: String) -> Option<HashMap<String, SessionSummaryLines>> {
        match self.host.session().output(command).await {
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

    /// The listing of this host, over the channels the connection already holds.
    ///
    /// The host extracts the summary lines, with one command for each project
    /// directory. Therefore a listing moves those lines and nothing else. A host
    /// with a shell that pie cannot use falls back to fragments over sftp.
    async fn list(&self, sftp: &SftpSession) -> Result<Vec<SessionSummary>, Error> {
        let mut summaries = Vec::new();
        let root = self
            .sessions_root()
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

            let found = match self.summary(&dir, posix_summary_script(&dir)).await {
                Some(found) if !found.is_empty() => found,
                // A Windows host has no POSIX shell. PowerShell gives the same three
                // lines before pie falls back to the read of fragments.
                _ => self
                    .summary(&dir, windows_summary_command(&dir))
                    .await
                    .unwrap_or_default(),
            };
            // This is not what either script printed, or neither script ran. Pie
            // reads the fragments of the file over sftp and does not drop the row. It
            // says so one time, so a host with scripts that stopped without a message
            // is not a host with nothing to show.
            if found.is_empty() {
                tracing::warn!(path = %dir, "no summary script ran on this host; its sessions are read over sftp instead");
            }

            for (path, modified) in times {
                let lines = match found.get(&path) {
                    Some(lines) => lines.clone(),
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
                            Ok(lines) => lines,
                            Err(error) => {
                                tracing::warn!(path = %path, %error, "skipping a session file pie cannot read");
                                continue;
                            }
                        }
                    }
                };
                if let Some(summary) = SessionSummary::of(&path, lines, modified) {
                    summaries.push(summary);
                }
            }
        }
        newest_first(&mut summaries);
        Ok(summaries)
    }
}

/// The largest part of the head of a session file that the fallback reads. The
/// read stops earlier if the first user turn is present. Pi writes its system
/// entry, with all tool definitions that it loaded, before that turn. One line
/// of that size is larger than a small window.
const HEAD_BYTES: usize = 1024 * 1024;

/// The distance from the end of a file that the name scan of the fallback
/// covers before it stops. Pi appends renames. Therefore the last rename is
/// usually near the end. A scan that exceeds this limit returns no name.
///
/// The listing of this machine uses these two values as the distance a name can
/// sit behind, to prove that its own read is not limited by them.
pub(super) const NAME_SCAN_BYTES: u64 = 1024 * 1024;

/// One block of a name scan that moves backwards.
pub(super) const NAME_BLOCK: usize = 16 * 1024;

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
const REMOTE_SESSIONS_ROOT: &str = ".pi/agent/sessions";

/// The shell that extracts the summary lines of one project directory on the
/// host.
///
/// One pass for each file: the header, the latest name, and the first lines that
/// look like user turns. [`first_text`] decides which of those turns say
/// something, as the local read does. Every POSIX system ships `sh`, `printf`,
/// `head`, `awk`, `grep`, and `tail`. The guard turns a host without them into a
/// clear failure. Then the Windows command or the sftp fallback gets its turn. The
/// session file names come from pi (`<timestamp>_<id>.jsonl`). Therefore a plain
/// glob is safe over them.
fn posix_summary_script(dir: &str) -> String {
    format!(
        r#"command -v head awk grep tail >/dev/null 2>&1 || exit 127
        for f in {dir}/*.jsonl; do
            [ -f "$f" ] || continue
            printf '=== %s\n' "${{f##*/}}"
            head -n 1 "$f"
            printf -- '---\n'
            awk '/"role":"user"/ {{ print substr($0, 1, {cap}); n++; if (n >= {cands}) exit }}' "$f"
            printf -- '---\n'
            grep '"type":"session_info"' "$f" | tail -n 1
            printf -- '---\n'
        done
        :"#,
        dir = quote(dir),
        cap = SCRIPT_TEXT_CAP,
        cands = SCRIPT_FIRST_CANDIDATES,
    )
}

/// The same extraction as [`posix_summary_script`], for a Windows host.
///
/// Windows ships no POSIX shell; every supported Windows ships PowerShell, and
/// the same three lines come back in the same shape. Pie builds the script here,
/// and it travels as its own encoded parameter (see [`powershell_command`]).
/// Therefore the directory that the user selected never passes through the
/// quoting rules of a shell. The script sets the console encoding to UTF-8:
/// without that step, Windows PowerShell prints in the OEM code page, and a name
/// with a character outside ASCII returns as unwanted characters.
fn windows_summary_command(dir: &str) -> String {
    powershell_command(&format!(
        r#"[Console]::OutputEncoding = [Text.Encoding]::UTF8
        $d = '{dir}'
        Get-ChildItem -LiteralPath $d -Filter *.jsonl -File | ForEach-Object {{
            Write-Output ('=== ' + $_.Name)
            Get-Content -LiteralPath $_.FullName -TotalCount 1
            Write-Output '---'
            $first = Select-String -LiteralPath $_.FullName -Pattern '"role":"user"' | Select-Object -First {cands}
            foreach ($m in $first) {{ $l = $m.Line; Write-Output $l.Substring(0, [Math]::Min({cap}, $l.Length)) }}
            Write-Output '---'
            $name = Select-String -LiteralPath $_.FullName -Pattern '"type":"session_info"' | Select-Object -Last 1
            if ($name) {{ Write-Output $name.Line }}
            Write-Output '---'
        }}"#,
        dir = dir.replace('\'', "''"),
        cap = SCRIPT_TEXT_CAP,
        cands = SCRIPT_FIRST_CANDIDATES,
    ))
}

/// How pie runs a script on a Windows host: `powershell` with the script as its
/// own encoded parameter.
///
/// `-EncodedCommand` takes base64 of UTF-16LE, the only encoding it accepts, and
/// PowerShell decodes it itself. Therefore the quoting of the script is the only
/// quoting of such a command.
fn powershell_command(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell -NoProfile -NonInteractive -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
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
    r#"if [ -n "$PI_CODING_AGENT_SESSION_DIR" ]; then printf '%s\n' "$PI_CODING_AGENT_SESSION_DIR"
        elif [ -n "$PI_CODING_AGENT_DIR" ]; then printf '%s\n' "$PI_CODING_AGENT_DIR/sessions"
        else printf '%s\n' "$HOME/.pi/agent/sessions"; fi
        printf '%s\n' "$HOME""#
        .to_string()
}

/// The same question in PowerShell, for a Windows host: the value, then the home,
/// on two lines. These are the same two lines that [`posix_root_script`] sends.
fn windows_root_command() -> String {
    powershell_command(
        r#"[Console]::OutputEncoding = [Text.Encoding]::UTF8
        if ($env:PI_CODING_AGENT_SESSION_DIR) { $env:PI_CODING_AGENT_SESSION_DIR }
        elseif ($env:PI_CODING_AGENT_DIR) { "$($env:PI_CODING_AGENT_DIR)\sessions" }
        else { "$HOME\.pi\agent\sessions" }
        Write-Output $HOME"#,
    )
}

/// Reads the output of [`posix_summary_script`] into the lines of each file, by
/// the path of that file.
///
/// Each `=== ` block has three slots, separated by `---`: the header, the
/// candidates for the first message, and the name. An empty slot is an absent
/// value; the host prints the separators in all cases. The first slot can hold
/// several candidate lines. The first line that [`first_text`] can use is the
/// first message. Therefore a turn without words does not consume the turn after
/// it.
///
/// The key is `dir` and the name of the block, joined as the sftp listing joins
/// them, so a caller can look a file up by the path that listing gave it.
fn parse_summary_output(dir: &str, output: &str) -> HashMap<String, SessionSummaryLines> {
    let mut found = HashMap::new();
    let mut current: Option<(String, SessionSummaryLines, usize)> = None;
    for line in output.lines() {
        if let Some(name) = line.strip_prefix("=== ") {
            if let Some((name, lines, _)) = current.take() {
                found.insert(format!("{dir}/{name}"), lines);
            }
            current = Some((name.to_string(), SessionSummaryLines::default(), 0));
            continue;
        }
        if line == "---" {
            if let Some(slot) = current.as_mut() {
                slot.2 += 1;
            }
            continue;
        }
        let Some((_, lines, slot)) = current.as_mut() else {
            continue;
        };
        match slot {
            0 if line.trim().is_empty() => {}
            0 => lines.header = Some(line.to_string()),
            1 => {
                if lines.first.is_none()
                    && let Some(text) = first_text(line.as_bytes())
                {
                    lines.first = Some(text);
                }
            }
            2 => {
                if let Some(name) = name_in(line.as_bytes()) {
                    lines.name = name;
                }
            }
            _ => {}
        }
    }
    if let Some((name, lines, _)) = current.take() {
        found.insert(format!("{dir}/{name}"), lines);
    }
    found
}

/// Reads the two fragments of one session file for the fallback.
///
/// The head up to the first user turn, and the name backwards from the end. Both
/// reads have a limit, whatever the file does. Only a full file can show a name
/// in the middle. Such a name comes back as no name, not as a guess.
async fn read_fragments<F>(file: &mut F, size: Option<u64>) -> std::io::Result<SessionSummaryLines>
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
    Ok(SessionSummaryLines { header, first, name })
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

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;

    #[test]
    fn the_first_slot_takes_the_first_candidate_the_reader_can_use() {
        // The script prints candidates, not the answer. A turn that says nothing
        // (an image, or a similar line) must not consume the message after it.
        let image_turn = r#"{"type":"message","id":"m0","parentId":null,"timestamp":"2026-10-02T13:45:12.600Z","message":{"role":"user","content":[{"type":"image","data":"AAAA","mimeType":"image/png"}],"timestamp":1790948712600}}"#;
        let real = r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-02T13:45:13.000Z","message":{"role":"user","content":"the real first words","timestamp":1790948713000}}"#;
        let output = format!("=== a.jsonl\n{HEADER}\n---\n{image_turn}\n{real}\n---\n---\n");

        let found = parse_summary_output("/x", &output);

        assert_eq!(
            found["/x/a.jsonl"].first.as_deref(),
            Some("the real first words"),
            "a turn with no words in it does not consume the slot"
        );
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

        let found = parse_summary_output("/home/u/.pi/agent/sessions/--x--", &output);

        assert_eq!(found.len(), 2);
        let a = found
            .get("/home/u/.pi/agent/sessions/--x--/a.jsonl")
            .expect("the block of a.jsonl is found by the path of the file");
        assert_eq!(a.name.as_deref(), Some("bugfix"));
        assert_eq!(a.first.as_deref(), Some("hi"));
        let b = found
            .get("/home/u/.pi/agent/sessions/--x--/b.jsonl")
            .expect("the block of b.jsonl too");
        assert_eq!(b.name, None, "an empty slot is an absent one");
    }

    /// The script back out of what [`powershell_command`] encoded, which is the
    /// only way to read it: what pie sends is the encoded parameter.
    fn script_of(command: &str) -> String {
        use base64::Engine as _;
        let encoded = command.rsplit(' ').next().expect("the parameter");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("base64");
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16(&units).expect("utf-16")
    }

    #[test]
    fn the_windows_script_travels_as_its_own_encoded_parameter() {
        // `-EncodedCommand` takes base64 of UTF-16LE. The quoting of the script is
        // the only quoting, whatever shell is between pie and the script.
        assert_eq!(
            powershell_command("abc"),
            "powershell -NoProfile -NonInteractive -EncodedCommand YQBiAGMA"
        );

        let command = windows_summary_command(r"C:\Users\o'brien\sessions\--x--");

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
        let script = script_of(&windows_summary_command(r"C:\Users\o'brien\sessions"));

        assert!(script.contains(r"$d = 'C:\Users\o''brien\sessions'"), "got `{script}`");
    }

    #[cfg(unix)]
    #[test]
    fn the_posix_script_prints_the_blocks_that_the_reader_parses() {
        // The host's own shell runs this text. Running it here is the only way to
        // know that it is a script at all: an escape that a shell does not want
        // and a line that a statement cannot start both fail right here.
        let directory = tempfile::tempdir().expect("a temp directory");
        let content = format!(
            "{HEADER}\n{}\n{}\n",
            user_line("m1", "2026-10-02T13:45:13.000Z", 1790948713000, "hi"),
            name_line("n1", "Renamed")
        );
        std::fs::write(directory.path().join("s.jsonl"), content).expect("the session file");
        let dir = directory.path().display().to_string();

        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(posix_summary_script(&dir))
            .output()
            .expect("sh is on PATH");

        assert!(
            output.status.success(),
            "the guard finds every tool it asks for: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let found = parse_summary_output(&dir, &String::from_utf8_lossy(&output.stdout));
        let lines = found.get(&format!("{dir}/s.jsonl")).expect("the block of s.jsonl");
        assert_eq!(lines.first.as_deref(), Some("hi"));
        assert_eq!(lines.name.as_deref(), Some("Renamed"));
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
        let lines = read_fragments(&mut opened, Some(0)).await.expect("the fragments");

        assert_eq!(
            lines.first.as_deref(),
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
        let lines = read_fragments(&mut opened, Some(size)).await.expect("the fragments");

        assert_eq!(lines.name, None, "the early name is out of both windows and stays out");
    }
}
