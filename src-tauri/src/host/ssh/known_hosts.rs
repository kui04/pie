//! What pie remembers about host keys, and what it asks when it remembers
//! nothing.
//!
//! Trust on first use: the first key a host presents goes to a person, whose
//! answer is then remembered. After that the same key is accepted without a
//! word, and a *different* one ends the connection instead of being asked
//! about - a host key that changed is what a machine-in-the-middle looks like,
//! and a dialog is exactly what an attacker wants the user to click through.
//! The failure message says which store to fix.
//!
//! What counts as different, and what counts as unknown, follows OpenSSH's own
//! `hostfile.c` where it can:
//!
//! * A key that is *on record* is trusted, whatever else the file says about the
//!   host: `ssh` accepts a match even with a leftover line next to it, and a
//!   store that refused because of the leftover would be stricter than `ssh`.
//! * A record for the host that is *not* this key ends the connection. For a key
//!   of the same type that is a changed host key; for a type the records do not
//!   carry it is a key `ssh` would refuse too - it can then try another of the
//!   host's keys, where pie is handed one and stops.
//! * A host the store never mentions is the only question. A store that cannot
//!   be read at all is *not* that case: an unreadable store, or a record that
//!   cannot be parsed, ends the connection, so no malformed line or changed
//!   permission can quietly turn a decision into a click-through.
//!
//! Two stores are read, one is written. Pie's own file is where an answer is
//! recorded; the user's OpenSSH `known_hosts` is read too, because whoever ran
//! `ssh` against a host has already made this decision. That file is never
//! written to: it belongs to their `ssh`, and pie does not offer to replace a
//! key that changed in either store.
//!
//! One consequence of leaning on OpenSSH's format through `russh`: hashed host
//! entries (`|1|...`) are understood, but marker lines (`@cert-authority`,
//! `@revoked`) are skipped - a line's first field is read as the host pattern,
//! and OpenSSH's markers sit before the host names, so a marker names no host
//! pie verifies. A host its owner revocated there is therefore treated as a
//! first contact rather than refused, which is weaker than `ssh`.

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use anyhow::{Context as _, Result};
use russh::keys::{
    HashAlg, PublicKeyOrCertificate, known_hosts::learn_known_hosts_path, ssh_key::PublicKey as HostPublicKey,
};

use super::trust::{AskHostKey, HostKey, PresentedKey};

/// Host keys pie trusts, and who it asks about the ones it does not.
pub struct KnownHosts {
    /// Pie's own store: where a trusted key is remembered.
    own: PathBuf,
    /// The user's OpenSSH store, read for keys already trusted elsewhere.
    borrowed: Option<PathBuf>,
    asker: Arc<dyn AskHostKey>,
}

impl std::fmt::Debug for KnownHosts {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KnownHosts")
            .field("own", &self.own)
            .field("borrowed", &self.borrowed)
            .finish_non_exhaustive()
    }
}

/// What a store says about the key a host presented.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// The same key is already recorded here.
    Trusted,
    /// This host is recorded with a different key.
    Changed { line: usize },
    /// This host has a record here that could not be read.
    Broken { error: String },
    /// The store itself could not be opened.
    Inaccessible { error: String },
    /// This store has nothing to say about the host.
    Unknown,
}

impl KnownHosts {
    /// Trusts what `own` and `borrowed` hold, and puts the rest to `asker`.
    pub fn new(own: impl Into<PathBuf>, borrowed: Option<PathBuf>, asker: impl AskHostKey + 'static) -> Self {
        Self {
            own: own.into(),
            borrowed,
            asker: Arc::new(asker),
        }
    }

    /// Sorts out one presented key and returns the verdict to the handshake.
    async fn decide(&self, host: String, port: u16, key: HostPublicKey) -> Result<()> {
        let endpoint = format!("{host}:{port}");
        let own = check(&self.own, &host, port, &key);
        let borrowed = self
            .borrowed
            .as_ref()
            .map(|path| (path, check(path, &host, port, &key)));

        // A key either store accepts is accepted: whoever ran `ssh` against this
        // host has made the decision already, and the key is the host's, not the
        // file's.
        if own == Verdict::Trusted || matches!(borrowed, Some((_, Verdict::Trusted))) {
            return Ok(());
        }

        // Neither store vouches for this key, so what is on record decides. A
        // key that changed, or a record that cannot be read, ends the
        // connection: asking a person about a host their own stores have an
        // opinion on is the click-through this policy exists to prevent.
        if let Some((path, verdict)) = &borrowed
            && let Some(refusal) = refusal(verdict, path, &endpoint)
        {
            return Err(refusal);
        }
        if let Some(refusal) = refusal(&own, &self.own, &endpoint) {
            return Err(refusal);
        }

        let presented = PresentedKey {
            host: host.clone(),
            port,
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        };
        if !self.asker.ask(presented).await {
            return Err(anyhow::anyhow!(
                "the host key of {endpoint} was not accepted: the key it presented was not trusted"
            ));
        }

        learn_known_hosts_path(&host, port, &key, &self.own).with_context(|| {
            format!(
                "the host key of {endpoint} was trusted but could not be remembered in {}",
                self.own.display()
            )
        })?;
        Ok(())
    }
}

impl HostKey for KnownHosts {
    fn verify(
        &self,
        host: &str,
        port: u16,
        key: &PublicKeyOrCertificate,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        // The key is taken out of the certificate it may have arrived in: what
        // is remembered, and compared, is the key the host proves it holds.
        let key = key.public_key();
        let host = host.to_string();
        Box::pin(async move { self.decide(host, port, key).await })
    }
}

/// Asks one store what it knows about this host's key.
///
/// Comparing the records here rather than letting `russh` judge them, because
/// `russh` answers a coarser question: it stops at the first record that does
/// not match, so one leftover line for a host would veto the line that does
/// match it. `ssh` accepts a host key that is on record, whatever else is there
/// (`hostfile.c`, `check_hostkeys_by_key_or_type`: a match returns `HOST_OK` and
/// ends the search), and so does this.
///
/// A store that cannot be opened is told apart from one that does not exist:
/// `russh` reports both as "nothing recorded", and reading a refusal as a first
/// contact is exactly the downgrade this policy exists to prevent.
fn check(path: &Path, host: &str, port: u16, key: &HostPublicKey) -> Verdict {
    match std::fs::File::open(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Verdict::Unknown,
        Err(error) => {
            return Verdict::Inaccessible {
                error: error.to_string(),
            };
        }
    }

    let recorded = match russh::keys::known_hosts::known_host_keys_path(host, port, path) {
        Ok(recorded) => recorded,
        Err(error) => {
            return Verdict::Broken {
                error: error.to_string(),
            };
        }
    };

    if recorded.iter().any(|(_, recorded)| recorded == key) {
        return Verdict::Trusted;
    }
    // Nothing matches, so every record for this host disagrees with this key -
    // including a record of the same type, which is the shape of a host key
    // that changed. The line is reported so there is something to remove.
    match recorded.first() {
        Some((line, _)) => Verdict::Changed { line: *line },
        None => Verdict::Unknown,
    }
}

/// The refusal a verdict amounts to, if it amounts to one.
///
/// [`Verdict::Unknown`] is the only verdict that leaves a question open: it is
/// what a store says about a host it has never heard of.
fn refusal(verdict: &Verdict, path: &Path, endpoint: &str) -> Option<anyhow::Error> {
    match verdict {
        // A record for this host that is not this key. `ssh` treats this as the
        // host having changed and refuses as well - for the key it presented;
        // it can try another of the host's keys, which a one-key verifier
        // cannot, so a host whose other records do match is the case that
        // matters here.
        Verdict::Changed { line } => Some(anyhow::anyhow!(
            "the host key of {endpoint} was not accepted: {} line {line} records a different key for this host; if the host was rebuilt, or that line is a leftover, remove it and connect again",
            path.display()
        )),
        Verdict::Broken { error } => Some(anyhow::anyhow!(
            "the host key of {endpoint} was not accepted: the record for this host in {} could not be read ({error}), so pie cannot tell whether this key is the one on record; repair or remove that record and connect again",
            path.display()
        )),
        // The store itself could not be opened: what it holds for this host is
        // unknown, and unknown is the answer that must not be guessed at.
        Verdict::Inaccessible { error } => Some(anyhow::anyhow!(
            "the host key of {endpoint} was not accepted: pie cannot read {} ({error}), so it cannot tell whether this host is one already trusted there; make that file readable, or remove it, and connect again",
            path.display()
        )),
        Verdict::Trusted | Verdict::Unknown => None,
    }
}

#[cfg(test)]
mod tests {
    use std::{os::unix::fs::PermissionsExt, sync::Mutex};

    use russh::keys::{PublicKey, parse_public_key_base64};
    use tempfile::TempDir;

    use super::*;

    /// The host key of `ed25519.rsa.example.com` as far as these tests care: a
    /// fixed key so the assertions are about policy, not about key material.
    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    /// Another ed25519 key, for the case where a host presents a different one.
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G2sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";

    fn key(base64: &str) -> PublicKey {
        parse_public_key_base64(base64).expect("a valid key")
    }

    /// An asker that remembers being asked and always answers the same way.
    #[derive(Debug, Clone)]
    struct Answering {
        trust: bool,
        asked: Arc<Mutex<Vec<PresentedKey>>>,
    }

    impl Answering {
        fn new(trust: bool) -> Self {
            Self {
                trust,
                asked: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn questions(&self) -> usize {
            self.asked.lock().expect("not poisoned").len()
        }
    }

    impl AskHostKey for Answering {
        fn ask(&self, presented: PresentedKey) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
            self.asked.lock().expect("not poisoned").push(presented);
            let trust = self.trust;
            Box::pin(async move { trust })
        }
    }

    /// A known-hosts store of this test's own, in a directory that goes away
    /// with it.
    struct Store(TempDir);

    impl Store {
        fn new() -> Self {
            Self(TempDir::new().expect("a temp directory"))
        }

        /// The store's path: the file itself appears once something writes to
        /// it, and a store that does not exist yet is a store that knows
        /// nothing.
        fn path(&self) -> PathBuf {
            self.0.path().join("known_hosts")
        }

        fn write(&self, contents: &str) {
            std::fs::write(self.path(), contents).expect("the store is writable");
        }

        fn read(&self) -> String {
            std::fs::read_to_string(self.path()).unwrap_or_default()
        }
    }

    async fn verify(policy: &KnownHosts, key: &PublicKey) -> Result<()> {
        policy.verify("host.example.com", 22, &key.clone().into()).await
    }

    #[tokio::test]
    async fn a_remembered_key_is_accepted_without_asking() {
        let store = Store::new();
        store.write(&format!("host.example.com ssh-ed25519 {KEY_A}\n"));
        let asker = Answering::new(false);
        let policy = KnownHosts::new(store.path(), None, asker.clone());

        verify(&policy, &key(KEY_A)).await.expect("the recorded key is trusted");
        assert_eq!(asker.questions(), 0, "a known host is not a question");
    }

    #[tokio::test]
    async fn an_unseen_key_is_asked_about_and_then_remembered() {
        let store = Store::new();
        let asker = Answering::new(true);
        let policy = KnownHosts::new(store.path(), None, asker.clone());

        verify(&policy, &key(KEY_A)).await.expect("the answer was yes");
        assert_eq!(asker.questions(), 1);
        let presented = asker.asked.lock().expect("not poisoned")[0].clone();
        assert_eq!(presented.host, "host.example.com");
        assert_eq!(presented.port, 22);
        assert_eq!(presented.algorithm, "ssh-ed25519");
        assert!(presented.fingerprint.starts_with("SHA256:"), "got {presented:?}");

        verify(&policy, &key(KEY_A)).await.expect("it is remembered now");
        assert_eq!(asker.questions(), 1, "the second connection is not a second question");
        assert!(
            store.read().contains(&format!("ssh-ed25519 {KEY_A}")),
            "got {}",
            store.read()
        );
    }

    #[tokio::test]
    async fn a_refused_key_ends_the_handshake_and_is_not_remembered() {
        let store = Store::new();
        let asker = Answering::new(false);
        let policy = KnownHosts::new(store.path(), None, asker.clone());

        let error = verify(&policy, &key(KEY_A)).await.expect_err("the answer was no");
        assert!(error.to_string().contains("not accepted"), "got {error}");
        assert_eq!(asker.questions(), 1);
        assert_eq!(store.read(), "", "a refused key is not written down");
    }

    #[tokio::test]
    async fn a_key_that_changed_is_refused_rather_than_asked_about() {
        let store = Store::new();
        store.write(&format!("host.example.com ssh-ed25519 {KEY_A}\n"));
        let asker = Answering::new(true);
        let policy = KnownHosts::new(store.path(), None, asker.clone());

        let error = verify(&policy, &key(KEY_B))
            .await
            .expect_err("a different key is not the host");
        let reason = error.to_string();
        assert!(reason.contains("line 1"), "got `{reason}`");
        assert_eq!(asker.questions(), 0, "a changed key is not something to click through");
    }

    #[tokio::test]
    async fn a_known_host_in_the_users_store_is_trusted_and_left_alone() {
        const LINE: &str =
            "host.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n";
        let borrowed = Store::new();
        borrowed.write(LINE);
        let own = Store::new();
        let asker = Answering::new(false);
        let policy = KnownHosts::new(own.path(), Some(borrowed.path()), asker.clone());

        verify(&policy, &key(KEY_A))
            .await
            .expect("the user's store already decided this");
        assert_eq!(asker.questions(), 0);
        assert_eq!(borrowed.read(), LINE, "the user's store is read, never written");
    }

    #[tokio::test]
    async fn a_new_key_is_written_to_pies_own_store_even_when_the_users_store_exists() {
        let borrowed = Store::new();
        borrowed.write(
            "other.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G2sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X\n",
        );
        let own = Store::new();
        let asker = Answering::new(true);
        let policy = KnownHosts::new(own.path(), Some(borrowed.path()), asker);

        verify(&policy, &key(KEY_A)).await.expect("the answer was yes");
        assert!(own.read().contains(KEY_A), "pie remembers it in its own store");
        assert!(!borrowed.read().contains(KEY_A), "and not in the user's");
    }

    #[tokio::test]
    async fn a_hashed_entry_is_understood() {
        // The entry OpenSSH writes with `HashKnownHosts yes`, for example.com:
        // the host is not readable in the line, only provable by hashing it.
        let borrowed = Store::new();
        borrowed.write("|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF\n");
        let asker = Answering::new(false);
        let own = Store::new();
        let policy = KnownHosts::new(own.path(), Some(borrowed.path()), asker.clone());

        policy
            .verify(
                "example.com",
                22,
                &key("AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF").into(),
            )
            .await
            .expect("a hashed entry for this host is a decision too");
        assert_eq!(asker.questions(), 0);
    }

    #[tokio::test]
    async fn a_line_about_another_host_is_not_this_hosts_business() {
        // Even a line that cannot be parsed is about the host it names: nothing
        // here contradicts anything about the host being verified.
        let borrowed = Store::new();
        borrowed.write("other.example.com ssh-ed25519 not-a-key\n");
        let asker = Answering::new(true);
        let own = Store::new();
        let policy = KnownHosts::new(own.path(), Some(borrowed.path()), asker.clone());

        verify(&policy, &key(KEY_A))
            .await
            .expect("another host's record says nothing about this one");
        assert_eq!(asker.questions(), 1, "so this host is a first contact");
    }

    #[tokio::test]
    async fn a_record_for_this_host_that_cannot_be_read_ends_the_connection() {
        // Only a line whose host matched is parsed, so a failure here is about
        // *this* host: a store that has an opinion which cannot be checked.
        // Asking would offer a person the chance to trust a key their own store
        // contradicts, which is the one thing this policy exists to prevent.
        let store = Store::new();
        store.write("host.example.com ssh-ed25519 not-a-key\n");
        let asker = Answering::new(true);
        let policy = KnownHosts::new(store.path(), None, asker.clone());

        let error = verify(&policy, &key(KEY_A)).await.expect_err("it cannot be compared");
        let reason = error.to_string();
        assert!(reason.contains("could not be read"), "got `{reason}`");
        assert!(
            reason.contains(&store.path().display().to_string()),
            "and names the file to fix: `{reason}`"
        );
        assert_eq!(asker.questions(), 0, "a record that exists is not a question");
        assert!(!store.read().contains(KEY_A), "and nothing is written over it");
    }

    #[tokio::test]
    async fn a_borrowed_record_for_this_host_that_cannot_be_read_also_ends_it() {
        let own = Store::new();
        let borrowed = Store::new();
        borrowed.write("host.example.com ssh-ed25519 not-a-key\n");
        let asker = Answering::new(true);
        let policy = KnownHosts::new(own.path(), Some(borrowed.path()), asker.clone());

        let error = verify(&policy, &key(KEY_A))
            .await
            .expect_err("it cannot be compared either");
        let reason = error.to_string();
        assert!(reason.contains("could not be read"), "got `{reason}`");
        assert_eq!(asker.questions(), 0);
    }

    #[tokio::test]
    async fn a_store_that_cannot_be_read_at_all_ends_the_connection() {
        // A directory where the store should be: opening it works and reading a
        // line does not, which is the unreadable half of the same policy.
        let directory = TempDir::new().expect("a temp directory");
        let asker = Answering::new(true);
        let policy = KnownHosts::new(directory.path(), None, asker.clone());

        let error = verify(&policy, &key(KEY_A)).await.expect_err("it cannot be read");
        let reason = error.to_string();
        assert!(reason.contains("could not be read"), "got `{reason}`");
        assert_eq!(asker.questions(), 0, "a store that cannot be read is not a question");
    }

    #[tokio::test]
    async fn a_leftover_record_does_not_hide_the_record_that_matches() {
        // A host that was rebuilt and left an old line behind has both keys on
        // record. `ssh` accepts what it finds (`hostfile.c` returns HOST_OK for
        // a match whatever else the file says), so asking a person, or refusing,
        // because of the other line would be stricter than the tool whose file
        // this is.
        let store = Store::new();
        store.write(&format!(
            "host.example.com ssh-ed25519 {KEY_B}\nhost.example.com ssh-ed25519 {KEY_A}\n"
        ));
        let asker = Answering::new(false);
        let policy = KnownHosts::new(store.path(), None, asker.clone());

        verify(&policy, &key(KEY_A)).await.expect("the key is on record");
        verify(&policy, &key(KEY_B)).await.expect("and so is the other one");
        assert_eq!(asker.questions(), 0, "neither is a question");
    }

    #[tokio::test]
    async fn a_store_that_cannot_be_opened_ends_the_connection() {
        // A store that exists and cannot be read is not a store that knows
        // nothing: `russh` reports both the same way, so this is checked before
        // it ever sees the file.
        let store = Store::new();
        store.write(&format!("host.example.com ssh-ed25519 {KEY_A}\n"));
        std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::File::open(store.path()).is_ok() {
            // Running as root, where nothing is unreadable: nothing to check.
            return;
        }

        let asker = Answering::new(true);
        let policy = KnownHosts::new(store.path(), None, asker.clone());
        let error = verify(&policy, &key(KEY_A)).await.expect_err("it cannot be read");
        let reason = error.to_string();
        assert!(reason.contains("cannot read"), "got `{reason}`");
        assert_eq!(asker.questions(), 0, "an unreadable store is not a question");
    }

    #[tokio::test]
    async fn a_revoked_marker_is_not_a_record_for_a_host() {
        // OpenSSH puts the marker first (`hostfile.c` reads markers before the
        // host names), and `russh` reads a line's first field as the host - so a
        // marker line names no host pie verifies and is skipped. The host is a
        // first contact, which is *weaker* than `ssh`, where a revoked key is
        // refused outright.
        let store = Store::new();
        store.write(&format!("@revoked host.example.com ssh-ed25519 {KEY_A}\n"));
        let asker = Answering::new(true);
        let policy = KnownHosts::new(store.path(), None, asker.clone());

        verify(&policy, &key(KEY_A))
            .await
            .expect("the marker is not read as a host");
        assert_eq!(asker.questions(), 1, "so this host is a first contact");
    }

    #[tokio::test]
    async fn a_trusted_key_that_cannot_be_saved_is_reported() {
        // A store whose parent is a file rather than a directory: reading it is
        // the same as reading nothing, so the host is a first contact - and
        // writing the answer down fails, which the user has to hear about
        // instead of being asked the same question every time.
        let directory = TempDir::new().expect("a temp directory");
        let mut permissions = std::fs::metadata(directory.path())
            .expect("the directory exists")
            .permissions();
        permissions.set_mode(0o555);
        std::fs::set_permissions(directory.path(), permissions).expect("chmod");
        let store = directory.path().join("known_hosts");
        if std::fs::File::create(&store).is_ok() {
            // Running as root, which ignores the mode: nothing to check.
            return;
        }

        let asker = Answering::new(true);
        let policy = KnownHosts::new(store, None, asker);

        let error = verify(&policy, &key(KEY_A)).await.expect_err("it cannot be remembered");
        let reason = error.to_string();
        assert!(reason.contains("could not be remembered"), "got `{reason}`");
    }
}
