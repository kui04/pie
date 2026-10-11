//! What the frontend asks pie to connect to, and the label of the machine it
//! reaches.
//!
//! The shapes here are the wire contract of the connect screen: the frontend
//! sends a `transport` tag, and pie answers with an endpoint. Both are written
//! down once, here, so that a screen and the reach cannot drift apart silently.
//!
//! Credentials arrive here and go no further than the handshake. They are never
//! copied into pie's own storage, and their `Debug` removes them: this type
//! reaches logs.

use std::fmt::{Display, Formatter};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::Trust;

/// What the frontend asks pie to connect to.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum Spec {
    /// Pi on this machine, from `PATH`.
    Local,
    /// Pi on a host that pie reaches over SSH.
    Ssh {
        /// Hostname or address.
        host: String,
        /// The SSH port; 22 if the connect screen omits it.
        #[serde(default)]
        port: Option<u16>,
        /// Login name.
        user: String,
        /// How to authenticate.
        auth: Auth,
    },
}

/// The credentials as the connect screen collected them.
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Auth {
    /// A password.
    Password {
        /// The password itself.
        password: String,
    },
    /// A private key, as the text a key file holds.
    Key {
        /// The key itself. Pie never copies secret material into its own storage.
        key: String,
        /// The passphrase, if the key is encrypted.
        #[serde(default)]
        passphrase: Option<String>,
    },
}

impl std::fmt::Debug for Auth {
    /// This function removes the secrets. This type arrives from the frontend
    /// and reaches the logs.
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password { .. } => formatter.write_str("Password(<redacted>)"),
            Self::Key { key, passphrase } => formatter
                .debug_struct("Key")
                .field("bytes", &key.len())
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

/// The label of a machine pie reaches.
///
/// `local` on this machine, and `user@host:port` on a host pie reaches over SSH.
/// The value is a label for a person and for a log line, not a parsed address:
/// who to reach is decided by [`Spec`], and the label only says who that was.
/// Therefore any string is an endpoint, and building one is not fallible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Endpoint(String);

impl Endpoint {
    /// Names a machine by its label.
    pub fn new(label: impl Into<String>) -> Self {
        Self(label.into())
    }

    /// This machine.
    pub(crate) fn local() -> Self {
        Self::new("local")
    }

    /// The label, for a log field or a message.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for Endpoint {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// What a connect needs from the app that asked for it.
///
/// The app builds one for each connect, because each of these comes from it: the
/// home that a local session starts in, and the policy that answers whether a
/// host key belongs to a host.
#[derive(Debug, Clone)]
pub struct Options {
    /// The home directory of this machine: the start of a local session if the
    /// frontend does not say. `None` leaves pi in the directory of the app. That
    /// is the result on a platform without a home directory.
    pub home: Option<PathBuf>,
    /// The host-key policy for the SSH handshake.
    pub trust: Trust,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spec_without_a_key_passphrase_is_still_a_key() {
        let spec: Spec = serde_json::from_str(
            r#"{"transport":"ssh","host":"example.com","user":"pi","auth":{"type":"key","key":"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"}}"#,
        )
        .expect("the connect screen may leave the passphrase out");
        match spec {
            Spec::Ssh { port, auth, .. } => {
                assert_eq!(port, None);
                assert!(matches!(auth, Auth::Key { passphrase: None, .. }));
            }
            other => panic!("unexpected spec: {other:?}"),
        }
    }

    #[test]
    fn credentials_never_reach_a_log() {
        let password = Auth::Password {
            password: "hunter2".to_string(),
        };
        let key = Auth::Key {
            key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----".to_string(),
            passphrase: Some("letmein".to_string()),
        };

        for (spec, secret) in [(password, "hunter2"), (key, "letmein")] {
            let rendered = format!("{spec:?}");
            assert!(!rendered.contains(secret), "got `{rendered}`");
            assert!(!rendered.contains("AAAA"), "the key itself reached a log: `{rendered}`");
            assert!(rendered.contains("<redacted>"), "got `{rendered}`");
        }
    }

    #[test]
    fn an_endpoint_is_the_label_it_was_given() {
        assert_eq!(Endpoint::local().to_string(), "local");
        assert_eq!(
            serde_json::to_value(Endpoint::local()).expect("an endpoint serializes"),
            serde_json::json!("local"),
            "the frontend reads a plain string"
        );
    }
}
