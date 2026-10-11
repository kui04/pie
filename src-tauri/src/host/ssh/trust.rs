//! The two questions pie asks about a host key, and who answers them.
//!
//! Reaching an SSH machine runs into a key nobody can verify from here: the
//! reach asks whether that key belongs to that host ([`HostKey`]), and pie
//! answers - with a store, a person, or a refusal. The policy that answers with
//! a person is [`KnownHosts`](super::known_hosts::KnownHosts), and the question
//! it puts to that person is [`AskHostKey`], which the app implements.
//!
//! [`Trust`] is the one value the reach is handed. It is a handle: a clone is
//! another hand on the same policy, and the handshake holds one while a person
//! reads a fingerprint.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::super::Result;
use russh::keys::PublicKeyOrCertificate;
use serde::Serialize;

/// The app's verdict on the key a host presented.
///
/// An implementation answers one question. It may wait for a person, read a
/// store, or refuse at once; it may not block the runtime.
pub trait HostKey: Send + Sync + 'static {
    /// Answers whether this key belongs to this host.
    ///
    /// `host` and `port` are the endpoint as the app named it, so a verifier can
    /// key its store without parsing the address back out. The login name is not
    /// part of it - what is being checked is the host, not who is logging in -
    /// so a failure of this step names a host and a port alone.
    ///
    /// # Errors
    ///
    /// Any error ends the handshake and surfaces from the connect unchanged.
    /// [`Error::HostKeyRejected`](super::super::Error::HostKeyRejected) is the refusal
    /// of a policy that will not trust the key.
    ///
    /// The future is boxed because the reach holds the policy as a shared
    /// handle: it runs once per connection, where the allocation is nothing.
    fn verify(
        &self,
        host: &str,
        port: u16,
        key: &PublicKeyOrCertificate,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;
}

/// A shared hand on the app's trust policy.
#[derive(Clone)]
pub struct Trust(Arc<dyn HostKey>);

impl std::fmt::Debug for Trust {
    /// The policy is the app's and has no data of its own to show; what a reader
    /// needs to know is that a policy is there.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Trust(<policy>)")
    }
}

impl Trust {
    /// Wraps the app's policy.
    pub fn new(policy: impl HostKey + 'static) -> Self {
        Self(Arc::new(policy))
    }
}

impl HostKey for Trust {
    fn verify(
        &self,
        host: &str,
        port: u16,
        key: &PublicKeyOrCertificate,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        self.0.verify(host, port, key)
    }
}
/// A key a host presented, in the terms a person can check it in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentedKey {
    /// Host as the user typed it.
    pub host: String,
    /// Port it was reached on.
    pub port: u16,
    /// Key type, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// OpenSSH-style fingerprint, e.g. `SHA256:9f3k...`.
    pub fingerprint: String,
}

/// Puts a key that is in no store to a person.
///
/// The question reaches the frontend and the answer comes back through a
/// command, so this is the one place where connecting waits on a human.
pub trait AskHostKey: Send + Sync + 'static {
    /// Returns `true` to trust this key and remember it.
    ///
    /// The question reaches a person, who may never answer: how long to wait is
    /// the implementation's decision, and an answer that does not arrive is a
    /// refusal - never an unbounded wait, which would hold the connection it is
    /// being asked about.
    fn ask(&self, presented: PresentedKey) -> Pin<Box<dyn Future<Output = bool> + Send + '_>>;
}
