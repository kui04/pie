//! Everything that can go wrong while talking to `pi --mode rpc`.
//!
//! The variants report what happened; sorting them into the categories the
//! frontend branches on is `src-tauri`'s job (`PieError`, see
//! `.agents/rules/architecture.md`), which is also where a failure is named
//! once rather than in every place that reports one.

use std::path::PathBuf;
use std::time::Duration;

use thiserror::Error;

/// Result alias for the protocol layer.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A protocol, transport, or process failure.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// Starting the peer failed (missing binary, permission denied, ...).
    #[error("failed to start `{program}`: {source}")]
    Spawn {
        /// Program that was being started.
        program: String,
        /// Underlying failure.
        #[source]
        source: std::io::Error,
    },

    /// An i/o operation on an established transport failed.
    #[error("transport i/o failed: {0}")]
    Io(#[from] std::io::Error),

    /// A record could not be serialized. Always a bug in this crate.
    #[error("failed to encode a protocol record: {0}")]
    Encode(#[source] serde_json::Error),

    /// `<program> --version` failed or printed nothing usable.
    #[error("`{program} --version` failed: {message}")]
    VersionProbe {
        /// Program that was probed.
        program: String,
        /// What went wrong, or what was printed instead.
        message: String,
    },

    /// The `pi` binary does not match the release this crate mirrors.
    #[error("pi version mismatch: expected {expected}, found {found}")]
    VersionMismatch {
        /// Version this crate mirrors.
        expected: String,
        /// Version reported by the probed binary.
        found: String,
    },

    /// The connection is closed, so the command was not sent.
    #[error("connection is closed")]
    Closed,

    /// [`Client::start`](crate::pi_rpc::Client::start) ran outside a Tokio runtime.
    #[error("no Tokio runtime is active; start the client from an async context")]
    NoRuntime,

    /// Pi answered a command with `success: false`.
    #[error("pi rejected `{command}`: {message}")]
    Rpc {
        /// Command name as echoed by pi.
        command: String,
        /// Message from pi.
        message: String,
    },

    /// No response arrived within the timeout the caller applied.
    #[error("`{command}` (id {id}) produced no response within {timeout:?}")]
    Timeout {
        /// Request id that stayed unanswered.
        id: String,
        /// Command that was sent.
        command: String,
        /// Timeout the caller applied.
        timeout: Duration,
    },

    /// A response carried a payload that did not match the mirrored type.
    #[error("unexpected `{command}` payload: {message}")]
    Payload {
        /// Command whose payload failed to decode.
        command: String,
        /// Decoding failure.
        message: String,
    },

    /// The host did not accept the TCP connection in time.
    #[error("connecting to {endpoint} timed out after {timeout:?}")]
    ConnectTimeout {
        /// Host that was being reached, `user@host:port`.
        endpoint: String,
        /// Limit that expired.
        timeout: Duration,
    },

    /// The TCP connection to the host failed.
    #[error("connecting to {endpoint} failed: {source}")]
    Connect {
        /// Host that was being reached, `user@host:port`.
        endpoint: String,
        /// Underlying failure.
        #[source]
        source: std::io::Error,
    },

    /// The SSH layer failed: handshake, channel, or session.
    #[error("ssh: {0}")]
    Ssh(#[from] russh::Error),

    /// A private key file could not be read or decrypted.
    #[error("reading the private key at {}: {source}", path.display())]
    SshKey {
        /// Key file that failed to load.
        path: PathBuf,
        /// Why it failed.
        #[source]
        source: russh::keys::Error,
    },

    /// The host refused the credentials.
    #[error("the host refused the credentials for {endpoint}")]
    Auth {
        /// Host that refused them, `user@host:port`.
        endpoint: String,
    },

    /// The host neither accepted nor refused the credentials.
    #[error("{endpoint} did not answer within {timeout:?}")]
    AuthTimeout {
        /// Host that stayed silent, `user@host:port`.
        endpoint: String,
        /// Limit that expired.
        timeout: Duration,
    },

    /// The host refused to run the command: a missing `pi`, usually.
    #[error("{endpoint} refused to run `{command}`")]
    Exec {
        /// Host that refused, `user@host:port`.
        endpoint: String,
        /// Command as it was sent.
        command: String,
    },

    /// The host accepted the connection but never answered the request to run
    /// the command.
    #[error("{endpoint} did not answer within {timeout:?} whether it can run `{command}`")]
    ExecTimeout {
        /// Host that stayed silent, `user@host:port`.
        endpoint: String,
        /// Command as it was sent.
        command: String,
        /// Limit that expired.
        timeout: Duration,
    },

    /// The host's key was not accepted, so the handshake was abandoned.
    #[error("the host key of {endpoint} was not accepted: {reason}")]
    HostKeyRejected {
        /// Host whose key was refused, as `host:port`. What is checked is the
        /// host, not who is logging in, so the app's policy does not know the
        /// login name here (unlike [`Error::Connect`], which does).
        endpoint: String,
        /// Why it was refused, phrased for a person.
        reason: String,
    },
}
