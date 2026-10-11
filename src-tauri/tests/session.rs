//! [`SessionManager`](pie_lib::session::SessionManager) against real hosts.
//!
//! These tests are ignored by default. The local tests need `pi` on `PATH`. The
//! SSH tests need the container from `tests/scripts/ssh-fixture.sh`:
//!
//! ```text
//! eval "$(tests/scripts/ssh-fixture.sh start)"
//! cargo test --test session -- --ignored --test-threads=1
//! ```
//!
//! These tests add the app's half to `tests/ssh.rs`: pie reaches a machine,
//! starts and stops a session, and a host key goes through the full policy. Pie
//! asks about the key one time, remembers it, and refuses it after a change.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::TempDir;

use pie_lib::error::{PieError, RpcFailure};
use pie_lib::host::{AskHostKey, Auth, Error as HostError, HostPath, KnownHosts, Options, PresentedKey, Spec, Trust};
use pie_lib::session::{Id, Session, SessionManager, SessionSummary};

use ::pi_rpc::command::{Command, NewSession};
use ::pi_rpc::entry::Entry;
use ::pi_rpc::message::{Message, UserBlock, UserContent};
use ::pi_rpc::response::{EntryList, SessionState};
use ::pi_rpc::types::ThinkingLevel;

/// An asker for tests. It answers with a fixed verdict. It panics if pie asks it
/// when a store must answer.
#[derive(Debug, Clone)]
struct Answering {
    verdict: Option<bool>,
    asked: Arc<Mutex<usize>>,
}

impl Answering {
    fn trusting(trusted: bool) -> Self {
        Self {
            verdict: Some(trusted),
            asked: Arc::new(Mutex::new(0)),
        }
    }

    fn never() -> Self {
        Self {
            verdict: None,
            asked: Arc::new(Mutex::new(0)),
        }
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

/// The values that `ssh-fixture.sh start` prints, as these tests need them.
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

    fn spec(&self) -> Spec {
        Spec::Ssh {
            host: self.host.clone(),
            port: Some(self.port),
            user: self.user.clone(),
            auth: Auth::Password {
                password: self.password.clone(),
            },
        }
    }

    /// The same host, with the fixture key for authentication.
    fn key_spec(&self) -> Spec {
        Spec::Ssh {
            host: self.host.clone(),
            port: Some(self.port),
            user: self.user.clone(),
            auth: Auth::Key {
                key: std::fs::read_to_string(&self.key).expect("the fixture key is readable"),
                passphrase: None,
            },
        }
    }

    /// Reaches the host with a host-key policy over `store`, asking `asker`.
    async fn connect(
        &self,
        store: &Path,
        borrowed: Option<PathBuf>,
        asker: impl AskHostKey + 'static,
    ) -> Result<SessionManager, PieError> {
        self.connect_with(&self.spec(), store, borrowed, asker).await
    }

    /// Reaches the host with `spec`, and a host-key policy over `store`.
    async fn connect_with(
        &self,
        spec: &Spec,
        store: &Path,
        borrowed: Option<PathBuf>,
        asker: impl AskHostKey + 'static,
    ) -> Result<SessionManager, PieError> {
        let options = Options {
            home: None,
            trust: Trust::new(KnownHosts::new(store, borrowed, asker)),
        };
        attached("test", spec, &options, 1).await
    }
}

/// Reaches `spec`. No pi starts here: a test that speaks calls [`started`].
async fn connected(id: &str, spec: &Spec, options: &Options) -> Result<SessionManager, PieError> {
    SessionManager::connect(Id::new(id).expect("a usable name"), spec, options).await
}

/// Reaches `spec` and starts a pi on it.
async fn attached(id: &str, spec: &Spec, options: &Options, number: u64) -> Result<SessionManager, PieError> {
    let sessions = connected(id, spec, options).await?;
    sessions.attach(number).await?;
    Ok(sessions)
}

/// A session of this machine, with pi started in `home`, and a policy that is
/// never asked: there is no host to verify here.
async fn local(name: &str, home: &Path, number: u64) -> Result<SessionManager, PieError> {
    let options = Options {
        home: Some(home.to_path_buf()),
        trust: Trust::new(KnownHosts::new(home.join("known_hosts"), None, Answering::never())),
    };
    attached(name, &Spec::Local, &options, number).await
}

/// Waits for pi to write the session file and for the listing to see it.
///
/// Pi creates the file at the start of the turn, not at the time of the prompt
/// (its own `#10000` rule). Therefore the row arrives a moment after the
/// response.
async fn wait_for_the_listing(sessions: &SessionManager, id: &str) -> SessionSummary {
    for _ in 0..50 {
        let listed = sessions.summaries().await.expect("the listing");
        if let Some(summary) = listed.into_iter().find(|summary| summary.id == id) {
            return summary;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("pi never wrote a session file for {id}");
}

/// Stops the pi of a connection when the test ends, passed or panicked.
///
/// A runtime that shuts down first cancels the task; then pi sees its stdin close
/// with this process, which is its own way out.
struct StopsPi(Arc<SessionManager>);

impl Drop for StopsPi {
    fn drop(&mut self) {
        let sessions = Arc::clone(&self.0);
        tokio::spawn(async move { sessions.close().await });
    }
}

#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_connect_starts_no_pi_and_an_attach_starts_one() {
    let home = TempDir::new().expect("a temp directory");
    let options = Options {
        home: Some(home.path().to_path_buf()),
        trust: Trust::new(KnownHosts::new(
            home.path().join("known_hosts"),
            None,
            Answering::never(),
        )),
    };

    // The reach is the machine. It is complete before any pi runs on it, and the
    // listing of the conversations needs no pi at all.
    let connection = connected("no-pi", &Spec::Local, &options).await.expect("this machine");
    assert!(connection.sessions().is_empty(), "a connect starts no pi");
    assert!(!connection.is_alive(), "and nothing of it is running");
    assert_eq!(connection.host().endpoint().to_string(), "local");
    connection.summaries().await.expect("the listing of the machine");

    let session = connection.attach(1).await.expect("pi is on PATH");
    assert_eq!(session.id().as_str(), "no-pi:1");
    assert!(session.handle().is_alive());
    assert_eq!(connection.sessions().len(), 1);

    let stops = StopsPi(Arc::new(connection));
    let _keep = stops;
}

#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_detach_ends_one_pi_and_leaves_the_machine() {
    let home = TempDir::new().expect("a temp directory");
    let connection = local("detach-test", home.path(), 1).await.expect("pi is on PATH");
    let second = connection.attach(2).await.expect("pi is on PATH");
    assert_eq!(connection.sessions().len(), 2, "two pis, one machine");

    connection.detach("detach-test:1").await.expect("the first session");

    assert_eq!(connection.sessions().len(), 1);
    assert_eq!(connection.sessions()[0].id().as_str(), "detach-test:2");
    assert!(
        connection.is_alive(),
        "the session that was not detached keeps the connection live"
    );
    assert!(second.handle().is_alive(), "the session that was not detached runs on");
    // The machine stayed: its conversations are still readable, and the one that
    // is left still answers.
    connection.summaries().await.expect("the listing of the machine");
    second.client().get_state().await.expect("the session that stayed");

    assert!(
        connection.detach("detach-test:1").await.is_err(),
        "a session that is gone cannot be detached again"
    );
    connection.close().await;
}

#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_local_session_starts_in_the_home_it_was_given_and_stops_when_it_ends() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("local-test", home.path(), 1).await.expect("pi is on PATH");
    assert!(connection.is_alive(), "the session it started is running");
    assert_eq!(connection.host().endpoint().to_string(), "local");
    assert_eq!(connection.sessions().len(), 1, "one session per connection, for now");

    let session = &connection.sessions()[0];
    assert_eq!(session.id().as_str(), "local-test:1");
    let started_in = home.path().to_string_lossy().into_owned();
    assert_eq!(
        session.cwd().map(HostPath::as_str),
        Some(started_in.as_str()),
        "the session starts where pie said"
    );
    let client = session.client().clone();

    // Pi keeps its sessions under `HOME`, whatever directory it starts in (its
    // own config root rule). The listing reads the same files. Pi creates a
    // session file only after a conversation message exists (its `#10000`
    // rule). Therefore a start and a stop of pi leaves no file. This session
    // says something before the listing.
    let state: SessionState = client.get_state().await.expect("a state");
    client.prompt("first words").await.expect("pi takes the prompt");
    let mine = wait_for_the_listing(&connection, &state.session_id).await;
    assert_eq!(
        Path::new(&mine.cwd),
        home.path(),
        "the file's header names where the session started"
    );
    assert_eq!(mine.first_message.as_deref(), Some("first words"));

    connection.close().await;
    assert!(!session.handle().is_alive(), "disconnecting stops pi");
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

    assert!(
        matches!(
            &error,
            PieError::Host { error, .. }
                if matches!(&**error, HostError::HostKeyRejected { .. })
        ),
        "got {error:?}"
    );
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
    let endpoint = connection.host().endpoint().to_string();
    assert!(
        endpoint.contains(&fixture.host) && endpoint.ends_with(&fixture.port.to_string()),
        "got {endpoint}"
    );

    let recorded = std::fs::read_to_string(&store).expect("the key was remembered");
    assert!(recorded.contains(&fixture.host), "got {recorded}");
    connection.close().await;

    // The second time, pie must ask nobody: the answer is on record. The key
    // belongs to the host and is also correct for another entry.
    let remembered = fixture
        .connect_with(&fixture.key_spec(), &store, None, Answering::never())
        .await
        .expect("the recorded key is trusted");
    assert!(remembered.is_alive());
    remembered.close().await;
}

#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn a_host_key_that_changed_is_refused_and_says_which_store_to_fix() {
    let fixture = Fixture::from_env();
    let home = TempDir::new().expect("a temp directory");
    let store = home.path().join("known_hosts");
    // This key is not the key of the host, but it is recorded for the host.
    // Pie sees a rebuilt machine, or an attacker in the middle.
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

    match &error {
        PieError::Host { error, .. } => match &**error {
            HostError::HostKeyRejected { reason, .. } => {
                // The message must tell a person what to do: the file, the line
                // in the file, and the next step of another connect.
                assert!(
                    reason.contains(&store.display().to_string()),
                    "the message names the store: {reason}"
                );
                assert!(reason.contains("line 1"), "and the line: {reason}");
                assert!(reason.contains("connect again"), "and what to do: {reason}");
            }
            other => panic!("unexpected error: {other:?}"),
        },
        other => panic!("unexpected error: {other:?}"),
    }
}

#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn the_users_own_known_hosts_is_enough_to_connect() {
    let fixture = Fixture::from_env();
    let home = TempDir::new().expect("a temp directory");
    let own = home.path().join("known_hosts");

    // Trust the key one time. Pie records it in its own store.
    let first = fixture
        .connect(&own, None, Answering::trusting(true))
        .await
        .expect("trusted");
    first.close().await;

    // The same key is in the file that the `ssh` of the user trusts. Pie accepts
    // that decision and writes nothing to its own store.
    let borrowed = home.path().join("user-known_hosts");
    std::fs::copy(&own, &borrowed).expect("a copy of the store");
    std::fs::remove_file(&own).expect("pie's store is gone");

    let second = fixture
        .connect(&own, Some(borrowed), Answering::never())
        .await
        .expect("the user's store already decided this");
    assert!(second.is_alive());
    second.close().await;

    assert!(!own.exists(), "reading another store does not write pie's own");
}

/// The sftp channel lists the sessions that the pi of the host writes: the same
/// listing as the local path, read from the host over the session of pi.
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

    // Pi writes its session file at the start of the turn (its `#10000` rule).
    // Therefore the session says something and the listing waits for the row.
    let session = &connection.sessions()[0];
    let state: SessionState = session.client().get_state().await.expect("a state");
    session
        .client()
        .prompt("first words")
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

    let home = connection.host().dirs(None).await.expect("the home directory lists");
    let pi_root = home
        .iter()
        .find(|row| row.name == ".pi" && row.is_dir)
        .expect("pi's own root is in the home directory");
    assert!(
        pi_root.path.starts_with('/'),
        "rows carry whole paths: {}",
        pi_root.path
    );

    // The walk uses the paths of the rows, never a path that the picker builds.
    // The home of an sftp session is not the directory of pie.
    let sessions = format!("{}/agent/sessions", pi_root.path);
    let projects = connection
        .host()
        .dirs(Some(&HostPath::new(sessions.clone())))
        .await
        .expect("the sessions directory lists");
    assert!(!projects.is_empty(), "pi has written project directories: {projects:?}");

    let error = connection
        .host()
        .dirs(Some(&HostPath::new(".pi/agent/sessions")))
        .await
        .expect_err("a relative path is not a path pie resolves");
    assert!(matches!(&error, HostError::NotAbsolute { .. }), "got {error:?}");
}

/// The id of an entry, read from its wire shape.
///
/// Every variant of `Entry` carries an `id`, which the leaf path of a
/// transcript walks. The shape keeps the one test below short: no arm for each
/// of the eleven kinds.
fn entry_id(entry: &Entry) -> String {
    let sent = serde_json::to_value(entry).expect("an entry serializes");
    sent["id"].as_str().expect("every entry carries an id").to_string()
}

/// The entries of a session after pi appended the message of a prompt.
///
/// Pi appends it while the response of the prompt is already on the way (the
/// response reports the preflight, not the turn). Therefore this waits.
async fn entries_after_the_prompt(session: &Session, before: usize) -> EntryList {
    for _ in 0..50 {
        let entries = session.entries().await.expect("the entries");
        if entries.entries.len() > before {
            return entries;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("pi never appended the message of the prompt");
}

/// The three reads of the read-only workspace, against a real pi.
///
/// The reads are the ones the frontend asks for: `get_state`, `get_entries` and
/// `get_session_stats`. What this holds is their relation: one session answers
/// all three, the name of the connect finds it, and the entry set of the
/// transcript is the raw one that only grows.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn the_reads_answer_about_the_session_that_was_named() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("read-test", home.path(), 1).await.expect("pi is on PATH");

    assert_eq!(
        connection
            .session("read-test:1")
            .map(|session| session.id().as_str().to_string()),
        Some("read-test:1".to_string()),
        "the label that the connect answered with finds its session"
    );
    assert!(
        connection.session("read-test:9").is_none(),
        "a label from no connect of this connection finds nothing"
    );

    let session = &connection.sessions()[0];
    let fresh = session.state().await.expect("the state of a fresh session");
    let before = session.entries().await.expect("the entries of a fresh session");
    let start = session.stats().await.expect("the usage of a fresh session");

    assert_eq!(fresh.session_id, start.session_id, "one session answers both reads");
    assert_eq!(fresh.session_name, None, "a session that nobody named has no name");
    assert!(!fresh.is_streaming, "nothing runs yet");
    assert_eq!(fresh.message_count, 0, "no message of the conversation yet");
    assert_eq!(start.total_messages, 0, "and pi counts none");

    // A session without a message is not an empty entry set: pi appends what it
    // resolved at the start. Therefore the count is not what this holds. The
    // leaf is: the walk of the transcript starts at an entry that is there.
    let leaf = before.leaf_id.clone().expect("a fresh session points at a leaf");
    assert!(
        before.entries.iter().any(|entry| entry_id(entry) == leaf),
        "the leaf `{leaf}` is one of the entries"
    );

    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");

    let after = entries_after_the_prompt(session, before.entries.len()).await;
    let stats = session.stats().await.expect("the usage after a prompt");

    assert_eq!(stats.user_messages, 1, "pi counts the message that was sent");
    assert_eq!(stats.session_id, fresh.session_id, "still the same session");
    // The read is the raw set. A fold - the latest compaction in place of the
    // entries it summarized - would drop entries here. That fold belongs to the
    // frontend, which is why this holds.
    for entry in &before.entries {
        let id = entry_id(entry);
        assert!(
            after.entries.iter().any(|later| entry_id(later) == id),
            "`{id}` survived the prompt: the entry set only grows"
        );
    }
}

/// The switch of a session: the process stays, the conversation changes.
///
/// This is the path the session drawer takes: the reader picks a row of the
/// listing, and the pi that is already running continues that conversation. The
/// switch is a fact of the protocol with no event behind it, so what a switch
/// did shows in the reads that follow it.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_switch_moves_the_session_to_the_conversation_of_another_file() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("switch-test", home.path(), 1).await.expect("pi is on PATH");
    // Everything below may fail; the pi of this test stops either way.
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));
    let session = &connection.sessions()[0];

    // The conversation to come back to. The path of the session exists from the
    // start, but the file itself does not: pi writes it at the first turn (its
    // `#10000` rule), and the response to a prompt reports the preflight, before
    // the turn begins. Therefore the listing is what says the file is there.
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let before = session.state().await.expect("the state of the conversation");
    let file = wait_for_the_listing(&connection, &before.session_id).await.path;

    // Another conversation in the same process, and the one that was open is now
    // a file that nothing points at.
    session
        .client()
        .send_raw(Command::NewSession(NewSession {
            id: None,
            parent_session: None,
        }))
        .await
        .expect("pi takes the new session");
    let away = session.state().await.expect("the state of the new conversation");
    assert_ne!(
        away.session_id, before.session_id,
        "a new session is another conversation"
    );

    let switched = session
        .switch_session(&HostPath::new(&file))
        .await
        .expect("pi opens the file of a session");
    assert!(!switched.cancelled, "no extension asked to hold this switch");

    // A relative path is a mistake of the caller and does not reach pi: pi would
    // resolve it against its own directory and quietly open another conversation.
    let relative = session.switch_session(&HostPath::new("sessions/one.jsonl")).await;
    assert!(
        matches!(&relative, Err(PieError::Host { error, .. }) if matches!(&**error, HostError::NotAbsolute { .. })),
        "got {relative:?}"
    );

    let back = session.state().await.expect("the state after the switch");
    assert_eq!(
        back.session_id, before.session_id,
        "the session of the file is the open one"
    );
    assert_eq!(back.session_file.as_deref(), Some(file.as_str()));

    // The conversation itself came back, not only its name: the entries are the
    // ones pi wrote before the switch, read from the file.
    let entries = session.entries().await.expect("the entries after the switch");
    let written: Vec<String> = entries.entries.iter().filter_map(user_text).collect();
    assert!(
        written.iter().any(|text| text == "first words"),
        "the conversation that was switched to came back: {written:?}"
    );

    // A session file that names a working directory which is gone is the one
    // switch that pi refuses (`assertSessionCwdExists` before the runtime is
    // replaced). The file is a copy of a real one, with only that field
    // changed: pi reads the directory from the header of the file.
    let stranded = home.path().join("stranded.jsonl");
    let original = std::fs::read_to_string(&file).expect("the session file of this test");
    let (header, rest) = original.split_once('\n').expect("a header line and entries");
    let mut header: serde_json::Value = serde_json::from_str(header).expect("a JSON header");
    header["cwd"] = serde_json::Value::String("/no-such-directory-of-pie".to_string());
    std::fs::write(&stranded, format!("{header}\n{rest}")).expect("a session file of this test's own");

    let refused = session
        .switch_session(&HostPath::new(stranded.display().to_string()))
        .await;
    assert!(
        matches!(
            &refused,
            Err(PieError::Rpc {
                error: RpcFailure::Command,
                ..
            })
        ),
        "pi refuses the session whose directory is gone, got {refused:?}"
    );
    assert_eq!(
        session.state().await.expect("the state is readable").session_id,
        before.session_id,
        "a refused switch leaves the session where it was"
    );

    // A path that holds no file is *not* refused: pi opens it, and with no
    // header to name a working directory it continues in the directory of the
    // process (`SessionManager.open`). That is a conversation of pie's own home
    // — which is why the drawer hands out only the paths of the listing.
    let empty = home.path().join("no-such-session.jsonl");
    let opened = session
        .switch_session(&HostPath::new(empty.display().to_string()))
        .await
        .expect("pi opens a path it is given");
    assert!(!opened.cancelled);
    let moved = session.state().await.expect("the state after the switch");
    assert_ne!(
        moved.session_id, before.session_id,
        "a path with no file is another conversation"
    );
    assert!(
        moved
            .session_file
            .as_deref()
            .is_some_and(|path| path.ends_with("no-such-session.jsonl")),
        "got {:?}",
        moved.session_file
    );
}

/// The text of a user message, from an entry of the wire, for the test above.
///
/// Every other kind of entry answers with nothing, which is what lets a test ask
/// one question of a set of eleven kinds.
fn user_text(entry: &Entry) -> Option<String> {
    let Entry::Message(entry) = entry else {
        return None;
    };
    match &entry.message {
        Message::User(user) => Some(match &user.content {
            UserContent::Text(text) => text.clone(),
            UserContent::Blocks(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    UserBlock::Text(text) => Some(text.text.clone()),
                    // An image, or a part of a later pi: neither is words.
                    _ => None,
                })
                .collect(),
        }),
        _ => None,
    }
}

/// The id of a session is unique for the run of pie, not for the connection.
///
/// The frontend subscribes to `pi://session/{id}/...`. A reconnect starts a new
/// pi under the name of the same connection, and the listeners of the old one
/// may still be there. Therefore the new process must not take the id of the
/// process before it, or its events would arrive on a channel that the frontend
/// reads for the pi that is gone.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn two_connects_of_one_name_do_not_share_the_id_of_a_session() {
    let home = TempDir::new().expect("a temp directory");

    let first = local("twice", home.path(), 1).await.expect("pi is on PATH");
    assert_eq!(first.sessions()[0].id().as_str(), "twice:1");
    first.close().await;

    let second = local("twice", home.path(), 2).await.expect("pi is on PATH");
    assert_eq!(
        second.sessions()[0].id().as_str(),
        "twice:2",
        "the second pi of a connection has an id of its own"
    );
    second.close().await;
}

/// A path that holds something other than a session is refused, and left alone.
///
/// Nothing is written to such a file either: `SessionManager` opens a session file
/// with `wx`, so an existing file is never overwritten.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_switch_to_a_file_that_is_not_a_session_is_refused_and_leaves_it_be() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("refuse-test", home.path(), 1).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));
    let session = &connection.sessions()[0];
    let before = session.state().await.expect("the state of a fresh session");

    // A file with words in it, and nothing of the shape of a session.
    let stranger = home.path().join("notes.txt");
    std::fs::write(&stranger, "these are notes, not a conversation\n").expect("a file of this test's own");

    // Pi refuses a file that is not a session: the refusal names the reason.
    let refused = session
        .switch_session(&HostPath::new(stranger.display().to_string()))
        .await;
    match &refused {
        Err(PieError::Rpc {
            error: RpcFailure::Command,
            message,
            ..
        }) => {
            assert!(message.contains("not a valid"), "pi says why: {message}");
        }
        other => panic!("unexpected answer: {other:?}"),
    }

    assert_eq!(
        std::fs::read_to_string(&stranger).expect("the file is still there"),
        "these are notes, not a conversation\n",
        "pi leaves a file it did not write alone"
    );
    assert_eq!(
        session.state().await.expect("the state is readable").session_id,
        before.session_id,
        "a refused switch leaves the session where it was"
    );
}

/// The queue of one session, and the one way that the composer can take a message
/// back.
///
/// The protocol keeps a steering queue and a follow-up queue, reports both whole on
/// every change (`queue_update`), and drops both of them together (`clear_queue`):
/// there is no way to take back a single message (G7 of the plan). The queue does not
/// need a run for this: `steer` and `follow_up` queue whether or not a run streams,
/// and `prompt` is the command that decides between a run and a queue.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn the_queue_holds_what_was_queued_and_clear_queue_answers_it() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("queue-test", home.path(), 1).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));
    let session = &connection.sessions()[0];

    session
        .client()
        .send_raw(Command::Steer(::pi_rpc::command::Steer {
            id: None,
            message: "a steering message".to_string(),
            images: None,
        }))
        .await
        .expect("pi takes a steering message");
    session
        .client()
        .send_raw(Command::FollowUp(::pi_rpc::command::FollowUp {
            id: None,
            message: "a follow-up message".to_string(),
            images: None,
        }))
        .await
        .expect("pi takes a follow-up message");

    let waiting = session.state().await.expect("the state of the session");
    assert_eq!(waiting.pending_message_count, 2, "pi counts both queues");
    assert!(!waiting.is_streaming, "the queue does not need a run");

    let cleared = session.clear_queue().await.expect("pi clears the queue");
    assert_eq!(cleared.steering, vec!["a steering message".to_string()]);
    assert_eq!(cleared.follow_up, vec!["a follow-up message".to_string()]);

    let again = session.clear_queue().await.expect("an empty queue clears too");
    assert!(again.steering.is_empty() && again.follow_up.is_empty());
    assert_eq!(
        session
            .state()
            .await
            .expect("the state after the clear")
            .pending_message_count,
        0
    );
    session
        .abort()
        .await
        .expect("an abort with nothing to stop is not a failure");
}

/// The reads of the composer, the name of a session, and a shell command of the
/// reader's own.
///
/// No model answer is needed for any of this: the reads come from the memory of pi,
/// and `bash` is a shell of pi's own. The prompt that reaches a model is held by
/// [`the_reads_answer_about_the_session_that_was_named`].
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn the_composer_reads_answer_and_a_shell_command_enters_the_transcript() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("composer-test", home.path(), 1).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));
    let session = &connection.sessions()[0];

    // A host may have no provider configured, so the lists may be empty. What this
    // holds is that each read answers.
    let commands = session.commands().await.expect("the commands of a session");
    let models = session.available_models().await.expect("the models of a session");
    let levels = session.available_thinking_levels().await.expect("the thinking levels");
    assert!(
        levels.levels.contains(&ThinkingLevel::Off),
        "every session can turn its reasoning off, got {:?}",
        levels.levels
    );
    let _ = (commands.commands.len(), models.models.len());
    assert_eq!(
        session.last_assistant_text().await.expect("the last answer").text,
        None,
        "a session that said nothing has no last answer"
    );

    let named = "composer test session";
    session.set_session_name(named).await.expect("pi takes a name");
    assert_eq!(
        session
            .state()
            .await
            .expect("the state after the rename")
            .session_name
            .as_deref(),
        Some(named)
    );

    let command = "printf 'hello from the composer'";
    let ran = session.bash(command, true).await.expect("pi runs a shell command");
    assert_eq!(ran.output, "hello from the composer");
    assert_eq!(ran.exit_code, Some(0.0));
    assert!(!ran.truncated && !ran.cancelled);
    session
        .abort_bash()
        .await
        .expect("an abort with no command running is not a failure");

    // The command is in the transcript as the message pi records it. Both paths of
    // the composer meet here: `entry_appended` carries it while the session is
    // open, and the snapshot of `get_entries` holds it after.
    let entries = session.entries().await.expect("the entries after the command");
    let recorded = entries.entries.iter().any(|entry| {
        matches!(
            entry,
            Entry::Message(message)
                if matches!(&message.message, Message::BashExecution(ran)
                    if ran.command == command && ran.exclude_from_context == Some(true))
        )
    });
    assert!(recorded, "the shell command is an entry of the session");

    session.set_auto_compaction(true).await.expect("pi takes the switch");
    assert!(
        session
            .state()
            .await
            .expect("the state after the switch")
            .auto_compaction_enabled,
        "the switch is readable in the state"
    );
}
