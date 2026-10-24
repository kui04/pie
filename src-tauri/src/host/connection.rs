//! The reach to a machine: opening it, keeping it, and closing it.

use std::fmt;

use super::Endpoint;

/// The reach to one machine.
///
/// This trait owns the connection and its liveness. It does not know files,
/// programs, sessions, or the app. [`Host`](super::Host) composes it with the
/// other machine capabilities.
#[async_trait::async_trait]
pub trait Connection: fmt::Debug + Send + Sync + 'static {
    /// Establishes or re-establishes the reach to the machine.
    async fn connect(&self) -> anyhow::Result<()>;

    /// Whether the reach to the machine is still open.
    fn is_open(&self) -> bool;

    /// The label of this machine: `local`, or `user@host:port`.
    fn endpoint(&self) -> Endpoint;

    /// Ends the reach to the machine.
    async fn close(&self);
}
