//! What can go wrong while starting a program, or on the bytes it exchanges.
//!
//! The variants report what happened. [`PieError`](crate::error::PieError)
//! carries this enum whole. Serde sends the name of the variant that failed as
//! `kind`, and the frontend branches on that name. The sentence for a person is
//! the task of [`Display`](std::fmt::Display). Therefore a failure has a name in
//! one place here, not in every place that reports it.
//!
//! What the reach to a machine fails on is not here: that is
//! [`host::Error`](crate::host::Error), which owns the handshake, the trust and
//! the files. This enum holds the bytes and the process behind them.

use serde::Serialize;
use thiserror::Error;

/// Result alias for the channel layer.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A failure of the bytes between pie and a program it started.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// The start of the program failed (a missing binary, permission denied, ...).
    #[error("failed to start `{program}`: {source}")]
    Spawn {
        /// The program that pie started.
        program: String,
        /// The failure below.
        #[serde(skip)]
        #[source]
        source: std::io::Error,
    },

    /// An i/o operation on an open channel failed.
    #[error("channel i/o failed: {0}")]
    Io(
        #[serde(skip)]
        #[from]
        std::io::Error,
    ),
}

impl Error {
    /// The failure of a pipe that a started process should hold.
    ///
    /// Every pipe is asked for at the start, so a missing one is a bug rather
    /// than a condition. The variant stays an error and not a panic because the
    /// release build aborts on a panic, and a command that fails to start is
    /// better than an app that stops.
    pub(crate) fn missing_pipe(name: &str) -> Self {
        Self::Io(std::io::Error::other(format!(
            "the program's {name} pipe is not available"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_of_a_failure_is_what_the_frontend_reads() {
        let crossing = serde_json::to_value(Error::Spawn {
            program: "pi".to_string(),
            source: std::io::Error::other("not found"),
        })
        .expect("a failure serializes");

        assert_eq!(crossing["kind"], "spawn");
        assert_eq!(crossing["program"], "pi");
        assert!(
            crossing.get("source").is_none(),
            "an io::Error does not travel: {crossing}"
        );
        assert_eq!(
            Error::Spawn {
                program: "pi".to_string(),
                source: std::io::Error::other("not found"),
            }
            .to_string(),
            "failed to start `pi`: not found"
        );
    }
}
