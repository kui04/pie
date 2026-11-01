//! The keys of the hosts pie reached, and the one question a new key asks.

use std::fmt::Debug;
use std::time::Duration;

use anyhow::Context as _;
use camino::Utf8PathBuf;
use hostaddr::HostAddr;
use russh::keys::PublicKey;
use serde::{Deserialize, Serialize};

use crate::bus::{Ask, Bus};
use crate::host::HostId;

/// What pie knows about the key a host offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trust {
    /// A key for this host is recorded, and it is the key the host offered.
    Trusted,
    /// No key for this host is recorded.
    Unknown,
    /// A key for this host is recorded, and the host offered another one.
    Changed {
        /// The line of the recorded key in the file pie keeps.
        line: usize,
    },
}

/// Where pie remembers the keys of the hosts it reached.
///
/// The file holds one line per host in the OpenSSH known_hosts format, so the
/// answer pie gives can be read, compared, and revoked with the tools a person
/// already has.
#[derive(Debug, Clone)]
pub struct KnownHosts {
    path: Utf8PathBuf,
}

impl KnownHosts {
    pub fn new(path: Utf8PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Utf8PathBuf {
        &self.path
    }

    /// What this file holds for the key `host` offers now.
    pub fn verdict(&self, host: &HostAddr<String>, key: &PublicKey) -> anyhow::Result<Trust> {
        let address = host.host().to_string();
        let port = host.port().unwrap_or(22);

        match russh::keys::check_known_hosts_path(&address, port, key, self.path.as_std_path()) {
            Ok(true) => Ok(Trust::Trusted),
            Ok(false) => Ok(Trust::Unknown),
            Err(russh::keys::Error::KeyChanged { line }) => Ok(Trust::Changed { line }),
            Err(error) => {
                Err(error).with_context(|| format!("cannot read the host keys in `{}`", self.path))
            }
        }
    }

    /// Records the key `host` offers now, so the next connect trusts the host without a question.
    pub fn remember(&self, host: &HostAddr<String>, key: &PublicKey) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent()
            && !parent.as_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("cannot create `{parent}` for the host keys"))?;
        }
        let address = host.host().to_string();
        let port = host.port().unwrap_or(22);

        russh::keys::known_hosts::learn_known_hosts_path(
            &address,
            port,
            key,
            self.path.as_std_path(),
        )
        .with_context(|| format!("cannot record the host key in `{}`", self.path))
    }
}

/// The question pie asks before it trusts a host it has never met.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustAsk {
    /// The connection the question belongs to, named as every other payload names
    /// it. A connect asks before the connection is registered, so this is the only
    /// way the frontend can tell two of them apart.
    pub host: HostId,
    /// The machine, written `host` or `host:port` as the file writes it.
    pub endpoint: String,
    /// The key type the machine offers, such as `ssh-ed25519`.
    pub algorithm: String,
    /// The SHA-256 fingerprint a person can compare with the machine itself.
    pub fingerprint: String,
}

impl Ask for TrustAsk {
    type Answer = TrustAnswer;
    const EVENT_NAME: &'static str = "pi://ask/host_key";
}

/// The person's answer to one host-key question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TrustAnswer {
    /// The offered key is the key of that machine; record it.
    Trusted,
    /// The offered key is not the key of that machine; refuse it.
    Refused,
}

/// How long a host-key question waits for the person.
const TRUST_PATIENCE: Duration = Duration::from_secs(5 * 60);

/// Asks the frontend whether this machine is trusted, and answers the dialog it shows.
pub(crate) struct TrustPrompt {
    bus: Bus,
    host: HostId,
    endpoint: HostAddr<String>,
    known_hosts: KnownHosts,
}

impl TrustPrompt {
    pub(crate) fn new(
        bus: Bus,
        host: HostId,
        endpoint: HostAddr<String>,
        known_hosts: KnownHosts,
    ) -> Self {
        Self {
            bus,
            host,
            endpoint,
            known_hosts,
        }
    }

    /// The decision for the key `key`, which is the key this connection offered.
    pub(crate) async fn decide(&self, key: &PublicKey) -> anyhow::Result<bool> {
        match self.known_hosts.verdict(&self.endpoint, key)? {
            Trust::Trusted => Ok(true),
            Trust::Changed { line } => {
                tracing::warn!(
                    endpoint = %self.endpoint,
                    path = %self.known_hosts.path(),
                    line,
                    "the host key changed; the connection is refused"
                );
                anyhow::bail!(
                    "the host key for `{}` changed (conflicts with `{}` line {line})",
                    self.endpoint,
                    self.known_hosts.path()
                )
            }
            Trust::Unknown => {
                let ask = TrustAsk {
                    host: self.host.clone(),
                    endpoint: self.endpoint.to_string(),
                    algorithm: key.algorithm().as_str().to_owned(),
                    fingerprint: key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
                };

                match self.bus.ask::<TrustAsk>(ask, TRUST_PATIENCE).await {
                    Ok(TrustAnswer::Trusted) => {
                        if let Err(error) = self.known_hosts.remember(&self.endpoint, key) {
                            tracing::warn!(
                                endpoint = %self.endpoint,
                                %error,
                                "the trusted key could not be recorded; the connection is refused"
                            );
                            return Ok(false);
                        }
                        Ok(true)
                    }
                    Ok(TrustAnswer::Refused) => Ok(false),
                    Err(error) => {
                        tracing::warn!(
                            endpoint = %self.endpoint,
                            %error,
                            "the host-key question was not answered; the connection is refused"
                        );
                        Ok(false)
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_key_asks_one_question_with_what_a_person_must_compare() {
        let ask = TrustAsk {
            host: HostId::new("work"),
            endpoint: "example.test:2222".to_owned(),
            algorithm: "ssh-ed25519".to_owned(),
            fingerprint: "SHA256:abc".to_owned(),
        };

        let wire = serde_json::to_value(&ask).expect("a question serializes");

        assert_eq!(
            wire,
            serde_json::json!({
                "host": "work",
                "endpoint": "example.test:2222",
                "algorithm": "ssh-ed25519",
                "fingerprint": "SHA256:abc",
            })
        );
        assert_eq!(TrustAsk::EVENT_NAME, "pi://ask/host_key");
    }

    #[test]
    fn an_answer_is_tagged_and_carries_no_other_field() {
        let trusted: TrustAnswer =
            serde_json::from_str(r#"{"type":"trusted"}"#).expect("an answer");
        let refused: TrustAnswer =
            serde_json::from_str(r#"{"type":"refused"}"#).expect("an answer");

        assert_eq!(trusted, TrustAnswer::Trusted);
        assert_eq!(refused, TrustAnswer::Refused);
    }

    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOOvO1fZB07gk6Ic0BeByjyNBY9LFEX3CpL3c0PFWmUB";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFX6lVzG/84qBnmj4ttSIQtscQ/Sq0+mTSyFYJrIjceG";

    fn key(text: &str) -> PublicKey {
        PublicKey::from_openssh(text).expect("a public key")
    }

    fn host() -> HostAddr<String> {
        HostAddr::try_from(("example.test", 2222)).expect("a host address")
    }

    fn store(directory: &tempfile::TempDir) -> KnownHosts {
        let path = directory.path().join("known_hosts");
        KnownHosts::new(Utf8PathBuf::from_path_buf(path).expect("a UTF-8 path"))
    }

    #[test]
    fn a_host_never_met_is_unknown() {
        let directory = tempfile::tempdir().expect("a temporary directory");

        let verdict = store(&directory)
            .verdict(&host(), &key(KEY_A))
            .expect("a verdict");

        assert_eq!(verdict, Trust::Unknown);
    }

    #[test]
    fn a_recorded_key_is_trusted_on_the_next_connect() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let store = store(&directory);

        store
            .remember(&host(), &key(KEY_A))
            .expect("the key is recorded");
        let verdict = store.verdict(&host(), &key(KEY_A)).expect("a verdict");

        assert_eq!(verdict, Trust::Trusted);
        let file = std::fs::read_to_string(store.path()).expect("the file is read");
        assert!(file.contains("[example.test]:2222 "), "{file}");
        assert!(file.ends_with('\n'), "{file}");
    }

    #[test]
    fn another_key_for_one_host_is_a_change_and_names_its_line() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let store = store(&directory);

        store
            .remember(&host(), &key(KEY_A))
            .expect("the key is recorded");
        let verdict = store.verdict(&host(), &key(KEY_B)).expect("a verdict");

        // `learn_known_hosts_path` ends an empty file with a line feed before it
        // writes, so the first entry of a file pie created sits on line 2.
        assert_eq!(verdict, Trust::Changed { line: 2 });
    }

    #[test]
    fn a_key_of_another_host_is_not_this_host() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let store = store(&directory);
        let other = HostAddr::try_from(("other.test", 22)).expect("a host address");

        store
            .remember(&host(), &key(KEY_A))
            .expect("the key is recorded");

        assert_eq!(
            store.verdict(&other, &key(KEY_A)).expect("a verdict"),
            Trust::Unknown
        );
    }
}
