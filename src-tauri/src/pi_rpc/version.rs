//! Pi version pinning.
//!
//! The crate version is the Pi release whose protocol this crate mirrors, so
//! [`PI_VERSION`] *is* the pin. Whether a mismatch is fatal is the app's call:
//! [`probe_version`] and [`check_version`] only report.

use std::ffi::OsStr;
use std::process::Stdio;

use tokio::process::Command;

use crate::pi_rpc::error::{Error, Result};

/// The Pi release this crate mirrors.
pub const PI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Runs `<program> --version` and returns the trimmed version it printed.
///
/// Use it before starting a session to catch a `pi` that is older or newer than
/// [`PI_VERSION`]; the protocol carries no compatibility guarantee.
///
/// # Errors
///
/// [`Error::Spawn`] when the program cannot be run at all, and
/// [`Error::VersionProbe`] when it exits non-zero or prints nothing usable.
pub async fn probe_version(program: impl AsRef<OsStr>) -> Result<String> {
    let program = program.as_ref();
    let output = Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|source| Error::Spawn {
            program: program.to_string_lossy().into_owned(),
            source,
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(Error::VersionProbe {
            program: program.to_string_lossy().into_owned(),
            message: if stdout.is_empty() {
                format!("exited with {}", output.status)
            } else {
                format!("exited with {}, printed `{stdout}`", output.status)
            },
        });
    }
    if stdout.is_empty() {
        return Err(Error::VersionProbe {
            program: program.to_string_lossy().into_owned(),
            message: "printed nothing on stdout".to_string(),
        });
    }
    Ok(stdout)
}

/// Compares a reported version with [`PI_VERSION`].
///
/// # Errors
///
/// [`Error::VersionMismatch`] when the probe reports anything but the pin;
/// whether that is fatal is the caller's decision.
pub fn check_version(found: impl AsRef<str>) -> Result<()> {
    let found = found.as_ref().trim();
    if found == PI_VERSION {
        return Ok(());
    }
    Err(Error::VersionMismatch {
        expected: PI_VERSION.to_string(),
        found: found.to_string(),
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

    #[tokio::test]
    async fn probe_version_reports_a_missing_binary() {
        let error = probe_version("pie-rpc-no-such-binary")
            .await
            .expect_err("a missing binary cannot report a version");

        assert!(matches!(error, Error::Spawn { .. }), "got {error:?}");
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
    /// (a wrapper script shadowing `pi`), so the branch is covered through an
    /// executable that ignores its arguments.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_version_reports_a_silent_command() {
        use std::os::unix::fs::PermissionsExt;

        let script = std::env::temp_dir().join(format!("pi-rpc-silent-{}", std::process::id()));
        std::fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = probe_version(&script)
            .await
            .expect_err("a silent command cannot report a version");
        std::fs::remove_file(&script).unwrap();

        match error {
            Error::VersionProbe { message, .. } => {
                assert_eq!(message, "printed nothing on stdout");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
