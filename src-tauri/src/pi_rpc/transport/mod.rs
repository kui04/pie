//! Transports: where the protocol bytes come from and go to.
//!
//! One protocol layer, two ways to reach pi: a local child process and an SSH
//! exec channel. A transport only produces a byte stream pair and a lifecycle
//! handle; it never looks at the protocol.

mod local;

mod ssh;

pub use local::{LocalControl, LocalProcess, LocalTransport};
pub use ssh::{HostKey, PublicKey, SshAuth, SshControl, SshTarget, SshTransport};

use std::future::Future;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::pi_rpc::error::Result;

/// A byte-oriented connection to a running `pi --mode rpc`.
///
/// Split it once to get the protocol streams and the lifecycle handle. Reaching
/// pi over SSH means implementing this trait, nothing else.
pub trait Transport: Send + 'static {
    /// Reads pi's stdout.
    type Reader: AsyncRead + Unpin + Send + 'static;
    /// Writes pi's stdin.
    ///
    /// Contract: the peer must see EOF on its stdin once this is shut down -
    /// that is pi's graceful exit signal. Dropping the writer alone does not
    /// have to deliver it: a local pipe happens to, an SSH channel does not
    /// (dropping its writer sends nothing, which is why the client shuts down
    /// before dropping). An implementation that only delivers EOF on drop
    /// therefore hangs pi's exit, so shutdown is the one to rely on.
    type Writer: AsyncWrite + Unpin + Send + 'static;
    /// Owns the process or session behind the streams.
    type Control: Control;

    /// Takes the streams and the lifecycle handle.
    ///
    /// # Errors
    ///
    /// The transport's own failure: for a local process, [`Error::Spawn`](crate::pi_rpc::Error::Spawn)
    /// when the binary cannot be started.
    fn split(self) -> Result<TransportParts<Self::Reader, Self::Writer, Self::Control>>;
}

/// The three things a [`Transport`] hands to the client.
pub struct TransportParts<R, W, C> {
    /// pi's stdout.
    pub reader: R,
    /// pi's stdin.
    pub writer: W,
    /// Lifecycle handle for the peer.
    pub control: C,
    /// Non-protocol diagnostics - pi logs to stderr - to be drained and logged.
    pub diagnostics: Option<Box<dyn AsyncRead + Unpin + Send + 'static>>,
}

impl<R, W, C> std::fmt::Debug for TransportParts<R, W, C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportParts")
            .field("diagnostics", &self.diagnostics.as_ref().map(|_| "<stream>"))
            .finish_non_exhaustive()
    }
}

/// Lifecycle of the peer behind a transport.
///
/// Contract: once [`Control::wait`] resolves, the transport's reader reaches EOF
/// too, so the client can drain whatever the peer wrote before it exited. A
/// local process satisfies this by closing its stdout when it exits;
/// [`Control::terminate`] does not depend on it.
pub trait Control: Send + 'static {
    /// Abruptly tears the peer down. For a process: kill and reap.
    fn terminate(&mut self) -> impl Future<Output = Result<()>> + Send;

    /// Waits for the peer to exit and reports how it ended.
    fn wait(&mut self) -> impl Future<Output = Result<Termination>> + Send;
}

/// How a peer stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Termination {
    /// The peer exited with this status.
    Exited {
        /// Exit code.
        code: i32,
        /// Whether the code counts as success.
        success: bool,
    },
    /// The peer was killed by this signal.
    Signalled {
        /// Signal number.
        signal: i32,
    },
    /// The peer ended without a status this crate can read.
    Unknown,
}
