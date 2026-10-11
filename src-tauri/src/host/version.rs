//! Pi version pinning.
//!
//! The app version is the Pi release whose protocol pie mirrors, so
//! [`PI_VERSION`] *is* the pin. Whether a mismatch is fatal is the app's call:
//! [`probe_version`] and [`check_version`] only report.

use std::ffi::OsStr;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::spec::Endpoint;
use super::ssh::ExecOutput;
use super::{Error, Result};
use crate::channel::Termination;

/// The Pi release this crate mirrors.
pub const PI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How long `<program> --version` may take.
///
/// A probe that prints a version and exits takes milliseconds; a program that
/// never does - a wrapper waiting on input, a hung package manager - would hold
/// whoever asked it, so the probe is bounded the same way the SSH transport
/// bounds its steps: nothing here has a handle to cancel the wait with, so the
/// wait has to end by itself.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How many times a probe may be started again while the program is still busy.
const SPAWN_ATTEMPTS: usize = 5;

/// Pause between those attempts; long enough for the kernel to release a
/// program that is being written or executed elsewhere.
const SPAWN_RETRY_DELAY: Duration = Duration::from_millis(20);

/// Runs `<program> --version` and returns the trimmed version it printed.
///
/// Use it before starting a session to catch a `pi` that is older or newer than
/// [`PI_VERSION`]; the protocol carries no compatibility guarantee.
///
/// # Errors
///
/// [`Error::VersionProbe`] when the program cannot be run at all (a missing `pi`), when
/// it exits non-zero, prints nothing usable, or does not answer within
/// `VERSION_PROBE_TIMEOUT`.
pub async fn probe_version(program: impl AsRef<OsStr>) -> Result<String> {
    probe_version_within(program, VERSION_PROBE_TIMEOUT).await
}

/// [`probe_version`], with the bound the caller needs.
async fn probe_version_within(program: impl AsRef<OsStr>, timeout: Duration) -> Result<String> {
    let program = program.as_ref();
    let name = program.to_string_lossy().into_owned();
    let mut child = None;
    let mut spawn_error = None;
    // `ETXTBSY` means the program is being written or executed right now; the
    // kernel clears it a moment after the writer goes, so a brief retry settles
    // it. Reporting it instead would make "the file was just written" a failure
    // of the probe.
    for attempt in 0..SPAWN_ATTEMPTS {
        match Command::new(program)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(spawned) => {
                child = Some(spawned);
                break;
            }
            Err(source) if source.kind() == std::io::ErrorKind::ExecutableFileBusy && attempt + 1 < SPAWN_ATTEMPTS => {
                tokio::time::sleep(SPAWN_RETRY_DELAY).await;
            }
            Err(source) => {
                spawn_error = Some(source);
                break;
            }
        }
    }
    let mut child = match child {
        Some(child) => child,
        None => {
            let source = spawn_error.expect("a failed spawn has an error");
            return Err(Error::VersionProbe {
                program: name,
                message: format!("could not be started: {source}"),
            });
        }
    };

    // Read while waiting, the way `wait_with_output` does it. A program that
    // prints more than a pipe holds blocks in `write`, so waiting first would
    // time out on a child that was answering the whole time - and taking the
    // handles here changes nothing about that: the buffer is the kernel's.
    let mut out = child.stdout.take().expect("stdout is piped above");
    let mut err = child.stderr.take().expect("stderr is piped above");
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    let joined = tokio::time::timeout(timeout, async {
        tokio::join!(child.wait(), out.read_to_end(&mut stdout), err.read_to_end(&mut stderr),)
    })
    .await;

    // Nothing is read once the bound has expired: a grandchild that inherited
    // the pipe's write end would keep the read open indefinitely, and the point
    // of a bound is that this call returns whatever the program does.
    let (status, ..) = match joined {
        Ok(joined) => joined,
        Err(_elapsed) => {
            let _ = child.kill().await;
            return Err(Error::VersionProbe {
                program: name,
                message: format!("printed no version within {timeout:?}"),
            });
        }
    };
    let status = status.map_err(|source| Error::VersionProbe {
        program: name.clone(),
        message: format!("could not be waited for: {source}"),
    })?;

    let stdout = String::from_utf8_lossy(&stdout);
    let stdout = stdout.trim();
    // What the program said about itself, when it said anything: a wrapper
    // explaining why it cannot answer is the reason worth passing on.
    let stderr = String::from_utf8_lossy(&stderr);
    let said = stderr
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim();
    let said = said.chars().take(200).collect::<String>();

    if !status.success() {
        let printed = if stdout.is_empty() {
            String::new()
        } else {
            format!(", printed `{stdout}`")
        };
        let said = if said.is_empty() {
            String::new()
        } else {
            format!(", said `{said}`")
        };
        return Err(Error::VersionProbe {
            program: name.clone(),
            message: format!("exited with {status}{printed}{said}"),
        });
    }
    if stdout.is_empty() {
        return Err(Error::VersionProbe {
            program: name,
            message: if said.is_empty() {
                "printed nothing on stdout".to_string()
            } else {
                format!("printed nothing on stdout, said `{said}`")
            },
        });
    }
    Ok(stdout.to_string())
}

/// Compares a reported version with [`PI_VERSION`].
///
/// A build of pi from upstream's release tarballs carries no version to bake
/// in and reports `0.0.0`: that is a probe that cannot say, not a version pie
/// can call wrong. The tradeoff is on the table: a packaged build that really
/// is the wrong release reports the same `0.0.0` and passes, so the version
/// check cannot catch that case at all - nothing on the wire tells a wrong
/// packaged build from a right one. What *can* be wrong is still caught,
/// loudly: a real number that is not the pin.
///
/// # Errors
///
/// [`Error::VersionMismatch`] when the probe reports a version other than the
/// pin; whether that is fatal is the caller's decision.
pub fn check_version(found: impl AsRef<str>) -> Result<()> {
    let found = found.as_ref().trim();
    if found == PI_VERSION || found == UNKNOWN_VERSION {
        return Ok(());
    }
    Err(Error::VersionMismatch {
        expected: PI_VERSION.to_string(),
        found: found.to_string(),
    })
}

/// What a packaged pi reports when its build had no version to bake in: not
/// "the wrong version", but "cannot tell".
const UNKNOWN_VERSION: &str = "0.0.0";

/// Reads the version that `pi --version` printed on a host.
///
/// This is [`check_version`] on a program that ran on another machine.
/// Therefore its failures name the endpoint, and the output of a wrapped pi is
/// the reason to pass on: a `pi` that printed a version pie does not speak is
/// [`Error::VersionMismatch`], and a probe with no answer is
/// [`Error::RemoteVersion`].
///
/// # Errors
///
/// [`Error::VersionMismatch`] for a real release that is not the pin, and
/// [`Error::RemoteVersion`] for a probe that ended without printing one.
pub(crate) fn check_remote_version(endpoint: &Endpoint, output: ExecOutput) -> Result<()> {
    let printed = String::from_utf8_lossy(&output.stdout);
    let printed = printed.trim();
    if let Termination::Exited { success: true, .. } = output.termination
        && !printed.is_empty()
    {
        check_version(printed)?;
        return Ok(());
    }

    let said = String::from_utf8_lossy(&output.stderr);
    let said = said
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim();
    let said = said.chars().take(200).collect::<String>();
    let said = if said.is_empty() {
        String::new()
    } else {
        format!(", said `{said}`")
    };
    let ended = match output.termination {
        Termination::Exited { code, success: true } => format!("printed nothing on stdout (exit {code})"),
        Termination::Exited { code, .. } => format!("exited with {code}"),
        Termination::Signalled { signal } => format!("was killed by signal {signal}"),
        Termination::Unknown => "ended without a status".to_string(),
    };
    Err(Error::RemoteVersion {
        endpoint: endpoint.to_string(),
        reported: format!("{ended}{said}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_version_accepts_the_pin_and_reports_a_mismatch() {
        assert!(check_version(PI_VERSION).is_ok());
        assert!(
            check_version(format!(" {PI_VERSION}\n")).is_ok(),
            "probe output arrives untrimmed"
        );

        match check_version("0.0.1").unwrap_err() {
            Error::VersionMismatch { expected, found } => {
                assert_eq!(expected, PI_VERSION);
                assert_eq!(found, "0.0.1");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn a_packaged_pi_that_cannot_say_its_version_is_not_a_mismatch() {
        // Upstream's release tarballs build pi with no version to bake in, so
        // 0.0.0 is "cannot tell" - refusing it would send the user hunting for
        // a pi that is already there.
        check_version(UNKNOWN_VERSION).expect("0.0.0 is a probe that cannot say");
    }

    #[test]
    fn a_host_probe_with_the_pin_passes_and_a_foreign_one_does_not() {
        let printed = |stdout: &[u8]| ExecOutput {
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
            termination: Termination::Exited { code: 0, success: true },
        };

        check_remote_version(&Endpoint::new("pi@host:22"), printed(PI_VERSION.as_bytes())).expect("the pin matches");

        match check_remote_version(&Endpoint::new("pi@host:22"), printed(b"0.84.2")).unwrap_err() {
            Error::VersionMismatch { found, .. } => assert_eq!(found, "0.84.2"),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn a_host_probe_that_cannot_answer_names_the_endpoint_and_why() {
        let output = ExecOutput {
            stdout: Vec::new(),
            stderr: b"pi: command not found\n".to_vec(),
            termination: Termination::Exited {
                code: 127,
                success: false,
            },
        };

        match check_remote_version(&Endpoint::new("pi@host:22"), output).unwrap_err() {
            Error::RemoteVersion { endpoint, reported } => {
                assert_eq!(endpoint, "pi@host:22");
                assert!(reported.contains("exited with 127"), "got `{reported}`");
                assert!(reported.contains("command not found"), "got `{reported}`");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_version_reports_a_missing_binary() {
        let error = probe_version("pie-rpc-no-such-binary")
            .await
            .expect_err("a missing binary cannot report a version");

        match error {
            Error::VersionProbe { program, message } => {
                assert_eq!(program, "pie-rpc-no-such-binary");
                assert!(message.contains("could not be started"), "got `{message}`");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_version_reports_a_failing_command() {
        // `false --version` exits non-zero without printing anything.
        let error = probe_version("false")
            .await
            .expect_err("a failing command cannot report a version");

        match error {
            Error::VersionProbe { program, message } => {
                assert_eq!(program, "false");
                assert!(message.contains("exited with"), "got `{message}`");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    /// A command that exits zero without printing a version is a real possibility
    /// (a wrapper script shadowing `pi`), so the branch is covered through a
    /// script that ignores its arguments.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_version_reports_a_silent_command() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("a temp directory");
        let script = directory.path().join("pi-silent");
        std::fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = probe_version(&script)
            .await
            .expect_err("a silent command cannot report a version");

        match error {
            Error::VersionProbe { message, .. } => {
                assert_eq!(message, "printed nothing on stdout");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    /// A program that answers `--version` by never answering at all would hold
    /// whoever asked it. The bound ends the wait, and the child does not outlive
    /// the question.
    ///
    /// A script rather than a sleeping binary: `sleep --version` is a version
    /// *answer* on a GNU system, which is the opposite of what is wanted here.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_probe_that_never_answers_is_given_up_on() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("a temp directory");
        let script = directory.path().join("pi-never-answers");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = probe_version_within(&script, Duration::from_millis(100))
            .await
            .expect_err("a program that never prints a version cannot report one");

        match error {
            Error::VersionProbe { message, .. } => {
                assert!(message.contains("printed no version within"), "got `{message}`");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    /// A program that is being written cannot be executed at all (`ETXTBSY`), which
    /// is a real condition for a `pi` someone is reinstalling underneath pie. The
    /// kernel clears it once the writer goes, so the probe waits rather than
    /// reporting "the program could not be run".
    #[cfg(unix)]
    #[tokio::test]
    async fn a_probe_waits_out_a_program_that_is_being_written() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("a temp directory");
        let script = directory.path().join("pi-being-written");
        std::fs::write(&script, "#!/bin/sh\necho 9.9.9\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Held open for writing while the probe runs: every exec is refused
        // until it is dropped.
        let writer = std::fs::OpenOptions::new().write(true).open(&script).expect("a writer");
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            drop(writer);
        });

        let found = probe_version_within(&script, Duration::from_secs(10))
            .await
            .expect("a program that stops being written can be run");
        release.join().expect("the writer is gone");

        assert_eq!(found, "9.9.9");
    }

    /// A probe that prints more than a pipe can hold must still be read. Waiting
    /// for the process without draining its pipes deadlocks the *other* way: the
    /// child blocks in `write`, the parent waits for an exit that cannot come,
    /// and the bound then reports the wrong reason.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_probe_that_prints_past_the_pipe_is_still_read() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("a temp directory");
        let script = directory.path().join("pi-chatty");
        // Well over the 64 KiB a pipe holds, then the version on its own line.
        std::fs::write(
            &script,
            "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' 'x'\necho 9.9.9\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let found = probe_version_within(&script, Duration::from_secs(10))
            .await
            .expect("a chatty program still answers");

        assert!(found.contains("9.9.9"), "got {found:.40}...");
    }
}
