//! [`Connection`](pie_lib::connection::Connection) against real hosts.
//!
//! Ignored by default: the local tests need `pi` on `PATH`, and the SSH ones
//! need the container from `tests/scripts/ssh-fixture.sh`:
//!
//! ```text
//! eval "$(tests/scripts/ssh-fixture.sh start)"
//! cargo test --test connection -- --ignored --test-threads=1
//! ```
//!
//! What these add over `tests/ssh.rs` is the app's half: a session is started
//! and stopped, and a host key goes through the whole policy - asked about
//! once, remembered, and refused when it changes.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::TempDir;

use pie_lib::connection::{
    AskHostKey, ConnectOptions, ConnectSpec, Connection, KnownHosts, PresentedKey, SessionSummary, SshAuthSpec,
};
use pie_lib::error::PieError;
use pie_lib::pi_rpc::protocol::{Command, CommandKind, SessionState};

/// An asker for tests: answers with a fixed verdict, and panics if it is asked
/// when a store should have answered instead.
#[derive(Debug)]
struct Answering {
    verdict: Option<bool>,
    asked: Mutex<usize>,
}

impl Answering {
    fn trusting(trusted: bool) -> Arc<Self> {
        Arc::new(Self {
            verdict: Some(trusted),
            asked: Mutex::new(0),
        })
    }

    fn never() -> Arc<Self> {
        Arc::new(Self {
            verdict: None,
            asked: Mutex::new(0),
        })
    }

    fn questions(&self) -> usize {
        *self.asked.lock().expect("not poisoned")
    }
}

impl AskHostKey for Answering {
    fn ask(&self, _presented: PresentedKey) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        *self.asked.lock().expect("not poisoned") += 1;
        let verdict = self.verdict.expect("nothing should have been asked");
        Box::pin(async move { verdict })
    }
}

/// What `ssh-fixture.sh start` prints, as these tests need it.
struct Fixture {
    host: String,
    port: u16,
    user: String,
    password: String,
    key: PathBuf,
}

impl Fixture {
    fn from_env() -> Self {
        let address = std::env::var("PIE_SSH_TEST_ADDR")
            .unwrap_or_else(|_| panic!("set PIE_SSH_TEST_ADDR: eval \"$(tests/scripts/ssh-fixture.sh start)\""));
        let (host, port) = address.rsplit_once(':').expect("PIE_SSH_TEST_ADDR is host:port");
        Self {
            host: host.to_string(),
            port: port.parse().expect("PIE_SSH_TEST_ADDR ends in a port"),
            user: std::env::var("PIE_SSH_TEST_USER").expect("PIE_SSH_TEST_USER"),
            password: std::env::var("PIE_SSH_TEST_PASSWORD").expect("PIE_SSH_TEST_PASSWORD"),
            key: PathBuf::from(std::env::var("PIE_SSH_TEST_KEY").expect("PIE_SSH_TEST_KEY")),
        }
    }

    fn spec(&self) -> ConnectSpec {
        ConnectSpec::Ssh {
            host: self.host.clone(),
            port: Some(self.port),
            user: self.user.clone(),
            auth: SshAuthSpec::Password {
                password: self.password.clone(),
            },
        }
    }

    /// The same host, authenticating with the fixture key instead.
    fn key_spec(&self) -> ConnectSpec {
        ConnectSpec::Ssh {
            host: self.host.clone(),
            port: Some(self.port),
            user: self.user.clone(),
            auth: SshAuthSpec::Key {
                key: std::fs::read_to_string(&self.key).expect("the fixture key is readable"),
                passphrase: None,
            },
        }
    }

    /// Connects with a host-key policy over `store`, asking `asker`.
    async fn connect(
        &self,
        store: &Path,
        borrowed: Option<PathBuf>,
        asker: Arc<dyn AskHostKey>,
    ) -> Result<Connection, PieError> {
        self.connect_with(&self.spec(), store, borrowed, asker).await
    }

    /// Connects with `spec`, and a host-key policy over `store`.
    async fn connect_with(
        &self,
        spec: &ConnectSpec,
        store: &Path,
        borrowed: Option<PathBuf>,
        asker: Arc<dyn AskHostKey>,
    ) -> Result<Connection, PieError> {
        let options = ConnectOptions {
            home: None,
            host_key: Arc::new(KnownHosts::new(store, borrowed, asker)),
        };
        Connection::connect("test", spec, &options).await
    }
}

/// Waits for pi to write the session file and for the listing to see it.
///
/// pi creates the file as the turn starts rather than when the prompt is
/// taken (its own `#10000` rule), so the row lands a beat after the response.
async fn wait_for_the_listing(connection: &Connection, id: &str) -> SessionSummary {
    for _ in 0..50 {
        let listed = connection.list_sessions().await.expect("the listing");
        if let Some(summary) = listed.into_iter().find(|summary| summary.id == id) {
            return summary;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("pi never wrote a session file for {id}");
}

#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_local_session_starts_in_the_home_it_was_given_and_stops_when_it_ends() {
    let home = TempDir::new().expect("a temp directory");
    let options = ConnectOptions {
        home: Some(home.path().to_path_buf()),
        // A local connection asks nobody: there is no host to verify.
        host_key: Arc::new(KnownHosts::new(
            home.path().join("known_hosts"),
            None,
            Answering::never(),
        )),
    };

    let connection = Connection::connect("local-test", &ConnectSpec::Local, &options)
        .await
        .expect("pi is on PATH");
    assert!(connection.is_alive(), "the session it started is running");
    assert_eq!(connection.endpoint(), "local");
    assert_eq!(connection.sessions().len(), 1, "one session per connection, for now");

    let session = &connection.sessions()[0];
    assert_eq!(session.id(), "local-test:1");
    assert_eq!(session.cwd(), Some(home.path()), "the session starts where pie said");
    let client = session.client().clone();

    // pi keeps its sessions under `HOME` whatever directory it starts in (its
    // own config root rule), and the listing reads the same files back. pi
    // creates a session file only once a conversation message exists - its own
    // `#10000` rule, so that opening pi and closing it leaves no file behind -
    // so this session says something before the listing.
    let state: SessionState = client
        .request(Command::new(CommandKind::GetState))
        .await
        .expect("pi answers")
        .decode()
        .expect("a state");
    client
        .request(Command::new(CommandKind::Prompt {
            message: "first words".to_string(),
            images: None,
            streaming_behavior: None,
        }))
        .await
        .expect("pi takes the prompt");
    let mine = wait_for_the_listing(&connection, &state.session_id).await;
    assert_eq!(
        Path::new(&mine.cwd),
        home.path(),
        "the file's header names where the session started"
    );
    assert_eq!(mine.first_message.as_deref(), Some("first words"));

    connection.disconnect().await;
    assert!(client.is_closed(), "disconnecting stops pi");
}

#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn a_host_key_nobody_trusted_ends_the_connection() {
    let fixture = Fixture::from_env();
    let home = TempDir::new().expect("a temp directory");
    let asker = Answering::trusting(false);

    let error = fixture
        .connect(&home.path().join("known_hosts"), None, asker.clone())
        .await
        .expect_err("a key nobody trusted is not a connection");

    assert!(matches!(error, PieError::HostKey { .. }), "got {error:?}");
    assert_eq!(asker.questions(), 1, "the key was put to the frontend");
    assert!(
        !home.path().join("known_hosts").exists(),
        "a refused key is not written down"
    );
}

#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn a_trusted_host_key_is_remembered_and_used_without_asking_again() {
    let fixture = Fixture::from_env();
    let home = TempDir::new().expect("a temp directory");
    let store = home.path().join("known_hosts");
    let asker = Answering::trusting(true);

    let connection = fixture
        .connect(&store, None, asker.clone())
        .await
        .expect("the key was trusted");
    assert_eq!(asker.questions(), 1, "first contact is a question");
    assert_eq!(connection.sessions().len(), 1);
    let endpoint = connection.endpoint();
    assert!(
        endpoint.contains(&fixture.host) && endpoint.ends_with(&fixture.port.to_string()),
        "got {endpoint}"
    );

    let recorded = std::fs::read_to_string(&store).expect("the key was remembered");
    assert!(recorded.contains(&fixture.host), "got {recorded}");
    connection.disconnect().await;

    // Second time around nobody may be asked: the answer is on record. The key
    // is, after all, about the host - it holds for another way in.
    let remembered = fixture
        .connect_with(&fixture.key_spec(), &store, None, Answering::never())
        .await
        .expect("the recorded key is trusted");
    assert!(remembered.is_alive());
    remembered.disconnect().await;
}

#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn a_host_key_that_changed_is_refused_and_says_which_store_to_fix() {
    let fixture = Fixture::from_env();
    let home = TempDir::new().expect("a temp directory");
    let store = home.path().join("known_hosts");
    // A key that is not the host's, recorded for the host: what a rebuilt
    // machine - or someone in the middle - looks like to pie.
    std::fs::write(
        &store,
        format!(
            "[{}]:{} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n",
            fixture.host, fixture.port
        ),
    )
    .expect("a store of this test's own");

    let error = fixture
        .connect(&store, None, Answering::never())
        .await
        .expect_err("a key that changed is not this host");

    match error {
        PieError::HostKey { message } => {
            // The message has to be one a person can act on: which file, which
            // line of it, and that connecting again is what follows.
            assert!(
                message.contains(&store.display().to_string()),
                "the message names the store: {message}"
            );
            assert!(message.contains("line 1"), "and the line: {message}");
            assert!(message.contains("connect again"), "and what to do: {message}");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn the_users_own_known_hosts_is_enough_to_connect() {
    let fixture = Fixture::from_env();
    let home = TempDir::new().expect("a temp directory");
    let own = home.path().join("known_hosts");

    // Trust the key once, which records it in pie's own store.
    let first = fixture
        .connect(&own, None, Answering::trusting(true))
        .await
        .expect("trusted");
    first.disconnect().await;

    // The same key, in the file the user's own `ssh` already trusts: pie takes
    // that decision as made, and writes nothing of its own.
    let borrowed = home.path().join("user-known_hosts");
    std::fs::copy(&own, &borrowed).expect("a copy of the store");
    std::fs::remove_file(&own).expect("pie's store is gone");

    let second = fixture
        .connect(&own, Some(borrowed), Answering::never())
        .await
        .expect("the user's store already decided this");
    assert!(second.is_alive());
    second.disconnect().await;

    assert!(!own.exists(), "reading another store does not write pie's own");
}

/// The sftp channel lists the sessions the host's pi writes: the same listing
/// the local path gives, read off the host over the very session pi runs on.
#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn the_host_session_listing_comes_back_over_sftp() {
    let fixture = Fixture::from_env();
    let store = TempDir::new().expect("a temp directory");
    let own = store.path().join("known_hosts");
    let connection = fixture
        .connect(&own, None, Answering::trusting(true))
        .await
        .expect("the host is reached");

    // pi writes its session file as the turn starts (its `#10000` rule), so
    // the session says something and the listing waits for the row.
    let session = &connection.sessions()[0];
    let state: SessionState = session
        .client()
        .request(Command::new(CommandKind::GetState))
        .await
        .expect("pi answers")
        .decode()
        .expect("a state");
    session
        .client()
        .request(Command::new(CommandKind::Prompt {
            message: "first words".to_string(),
            images: None,
            streaming_behavior: None,
        }))
        .await
        .expect("pi takes the prompt");

    let mine = wait_for_the_listing(&connection, &state.session_id).await;
    assert!(mine.path.contains(".pi/agent/sessions"), "got `{}`", mine.path);
    assert!(
        mine.cwd.ends_with(&fixture.user),
        "the file's header names the login home, got `{}`",
        mine.cwd
    );
    assert_eq!(mine.first_message.as_deref(), Some("first words"));
}

/// The directory picker walks the host over the same sftp channel.
#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn the_directory_picker_walks_the_host_over_sftp() {
    let fixture = Fixture::from_env();
    let store = TempDir::new().expect("a temp directory");
    let own = store.path().join("known_hosts");
    let connection = fixture
        .connect(&own, None, Answering::trusting(true))
        .await
        .expect("the host is reached");

    let home = connection.list_dirs(None).await.expect("the home directory lists");
    let pi_root = home
        .iter()
        .find(|row| row.name == ".pi" && row.is_dir)
        .expect("pi's own root is in the home directory");
    assert!(
        pi_root.path.starts_with('/'),
        "rows carry whole paths: {}",
        pi_root.path
    );

    // Walking on is done with the rows' own paths, never a path the picker
    // builds: the home of an sftp session is not pie's own directory.
    let sessions = format!("{}/agent/sessions", pi_root.path);
    let projects = connection
        .list_dirs(Some(&sessions))
        .await
        .expect("the sessions directory lists");
    assert!(!projects.is_empty(), "pi has written project directories: {projects:?}");

    let error = connection
        .list_dirs(Some(".pi/agent/sessions"))
        .await
        .expect_err("a relative path is not a path pie resolves");
    assert!(matches!(error, PieError::Internal { .. }), "got {error:?}");
}
