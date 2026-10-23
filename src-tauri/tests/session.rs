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

use camino::Utf8Path;
use tempfile::TempDir;

use pie_lib::host::{AskHostKey, Host, KnownHosts, LocalHost, PresentedKey, SshAuth, SshHost, SshTarget, Trust};
use pie_lib::session::{Id, Session, SessionManager, SessionSummary};

use ::pi_rpc::command::Command;
use ::pi_rpc::entry::Entry;
use ::pi_rpc::message::Message;
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

    fn target(&self) -> SshTarget {
        SshTarget::new(self.host.clone(), self.user.clone()).port(self.port)
    }

    fn password_auth(&self) -> SshAuth {
        SshAuth::Password(self.password.clone())
    }

    /// The same host, with the fixture key for authentication.
    fn key_auth(&self) -> SshAuth {
        SshAuth::Key {
            key: std::fs::read_to_string(&self.key).expect("the fixture key is readable"),
            passphrase: None,
        }
    }

    /// Build an `SshHost` with a host-key policy over `store`, asking `asker`.
    fn host(
        &self,
        auth: SshAuth,
        store: &Path,
        borrowed: Option<PathBuf>,
        asker: impl AskHostKey + 'static,
    ) -> Arc<dyn Host> {
        let trust = Trust::new(KnownHosts::new(store, borrowed, asker));
        Arc::new(SshHost::new(self.target(), auth, trust))
    }

    /// Reaches the host with a host-key policy over `store`, asking `asker`.
    async fn connect(
        &self,
        store: &Path,
        borrowed: Option<PathBuf>,
        asker: impl AskHostKey + 'static,
    ) -> anyhow::Result<SessionManager> {
        self.connect_with(self.password_auth(), store, borrowed, asker).await
    }

    /// Reaches the host with `auth`, and a host-key policy over `store`.
    async fn connect_with(
        &self,
        auth: SshAuth,
        store: &Path,
        borrowed: Option<PathBuf>,
        asker: impl AskHostKey + 'static,
    ) -> anyhow::Result<SessionManager> {
        let host = self.host(auth, store, borrowed, asker);
        attached("test", host, 1).await
    }
}

/// Reaches `host`. No pi starts here: a test that speaks calls [`attached`].
async fn connected(id: &str, host: Arc<dyn Host>) -> anyhow::Result<SessionManager> {
    SessionManager::connect(Id::new(id).expect("a usable name"), host).await
}

/// Reaches `host` and starts a pi on it.
async fn attached(id: &str, host: Arc<dyn Host>, number: u64) -> anyhow::Result<SessionManager> {
    let sessions = connected(id, host).await?;
    let home = sessions.host().home_dir().await?.unwrap_or_else(|| "/tmp".to_string());
    sessions.attach(number, None, Some(&home)).await?;
    Ok(sessions)
}

/// A session of this machine, with pi started in `home`.
async fn local(name: &str, home: &Path, number: u64) -> anyhow::Result<SessionManager> {
    let host: Arc<dyn Host> = Arc::new(LocalHost::new(Utf8Path::from_path(home).map(Utf8Path::to_path_buf)));
    attached(name, host, number).await
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

/// Waits for the file of a branch: the listing that names `parent` as its own
/// session's parent, once pi wrote it.
///
/// A branch that holds no entry yet has no file - pi writes it at the first turn of
/// the branch - so a caller that starts a fork before the first user message waits
/// here after that message.
async fn wait_for_a_branch(sessions: &SessionManager, parent: &str) -> SessionSummary {
    for _ in 0..50 {
        let listed = sessions.summaries().await.expect("the listing");
        if let Some(summary) = listed
            .into_iter()
            .find(|summary| summary.parent_session_path.as_deref() == Some(parent))
        {
            return summary;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("pi never wrote the file of the branch of {parent}");
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
    let host: Arc<dyn Host> = Arc::new(LocalHost::new(
        Utf8Path::from_path(home.path()).map(Utf8Path::to_path_buf),
    ));

    // The reach is the machine. It is complete before any pi runs on it, and the
    // listing of the conversations needs no pi at all.
    let connection = connected("no-pi", host).await.expect("this machine");
    assert!(connection.sessions().is_empty(), "a connect starts no pi");
    assert!(!connection.is_alive(), "and nothing of it is running");
    assert_eq!(connection.host().endpoint().to_string(), "local");
    connection.summaries().await.expect("the listing of the machine");

    let home = connection
        .host()
        .home_dir()
        .await
        .expect("home_dir succeeds")
        .unwrap_or_else(|| "/tmp".to_string());
    let session = connection.attach(1, None, Some(&home)).await.expect("pi is on PATH");
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
    let home_dir = connection
        .host()
        .home_dir()
        .await
        .expect("home_dir succeeds")
        .unwrap_or_else(|| "/tmp".to_string());
    let second = connection
        .attach(2, None, Some(&home_dir))
        .await
        .expect("pi is on PATH");
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
        session.cwd(),
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

/// A new session starts in the directory it was given, and pi records that
/// directory in its own file.
///
/// The choice of directory is the spawn directory of pi: the home here, or the
/// directory of the login shell on a host. Therefore the header of the session
/// file says where the tools of that session run, and a listing that grouped the
/// conversation under another directory would be a lie.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_new_session_starts_in_the_directory_it_was_given() {
    let home = TempDir::new().expect("a temp directory");
    let project = TempDir::new().expect("a temp directory");
    let host: Arc<dyn Host> = Arc::new(LocalHost::new(
        Utf8Path::from_path(home.path()).map(Utf8Path::to_path_buf),
    ));

    let connection = connected("start-dir", host).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));

    let dir = project.path().to_string_lossy().into_owned();
    let session = connection
        .attach(1, None, Some(&dir))
        .await
        .expect("pi takes the directory");
    assert_eq!(
        session.cwd(),
        Some(dir.as_str()),
        "the session reports the directory pie chose"
    );

    // Pi writes the header of its session file at the first turn, and the header
    // is where the cwd is recorded.
    let state: SessionState = session.state().await.expect("a state");
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let mine = wait_for_the_listing(&connection, &state.session_id).await;
    assert_eq!(
        Path::new(&mine.cwd),
        project.path(),
        "pi started in the directory, not in HOME"
    );
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
        error.to_string().contains("was not accepted"),
        "the host key is the reason: {error}"
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
        .connect_with(fixture.key_auth(), &store, None, Answering::never())
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

    // The message must tell a person what to do: the file, the line in the file,
    // and the next step of another connect.
    let reason = error.to_string();
    assert!(
        reason.contains(&store.display().to_string()),
        "the message names the store: {reason}"
    );
    assert!(reason.contains("line 1"), "and the line: {reason}");
    assert!(reason.contains("connect again"), "and what to do: {reason}");
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

/// The same choice of directory on a host: the `cd` before pi is where the
/// conversation is recorded, and the login home is not where it lands.
#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn a_new_session_starts_in_the_directory_it_was_given_over_ssh() {
    let fixture = Fixture::from_env();
    let store = TempDir::new().expect("a temp directory");
    let host = fixture.host(
        fixture.password_auth(),
        &store.path().join("known_hosts"),
        None,
        Answering::trusting(true),
    );
    let connection = connected("start-ssh", host).await.expect("the host is reached");

    let session = connection
        .attach(1, None, Some("/tmp"))
        .await
        .expect("pi starts in the directory pie chose");
    assert_eq!(session.cwd(), Some("/tmp"));

    let state = session.state().await.expect("a state");
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let mine = wait_for_the_listing(&connection, &state.session_id).await;
    assert_eq!(
        mine.cwd, "/tmp",
        "pi started in the chosen directory, not in the login home"
    );
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

    let home_path = connection
        .host()
        .home_dir()
        .await
        .expect("home_dir succeeds")
        .expect("the host has a home directory");
    let home = connection
        .host()
        .dirs(&home_path)
        .await
        .expect("the home directory lists");
    assert!(
        home.directory.starts_with('/'),
        "the home names itself: {}",
        home.directory
    );
    let pi_root = home
        .entries
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
        .dirs(&sessions)
        .await
        .expect("the sessions directory lists");
    assert!(
        !projects.entries.is_empty(),
        "pi has written project directories: {projects:?}"
    );

    let error = connection
        .host()
        .dirs(".pi/agent/sessions")
        .await
        .expect_err("a relative path is not a path pie resolves");
    assert!(error.to_string().contains("is not absolute"), "got {error}");
}

/// The directory picker makes a missing folder over the same sftp channel.
#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn the_directory_picker_makes_a_missing_folder_over_sftp() {
    let fixture = Fixture::from_env();
    let store = TempDir::new().expect("a temp directory");
    let own = store.path().join("known_hosts");
    let connection = fixture
        .connect(&own, None, Answering::trusting(true))
        .await
        .expect("the host is reached");

    let home_path = connection
        .host()
        .home_dir()
        .await
        .expect("home_dir succeeds")
        .expect("the host has a home directory");
    let home = connection
        .host()
        .dirs(&home_path)
        .await
        .expect("the home directory lists");
    let fresh = format!("{}/pie-probe/sub", home.directory);
    assert!(
        !connection.host().dir_exists(&fresh).await.expect("the probe answers"),
        "the folder is missing before it is made"
    );
    connection
        .host()
        .create_dir(&fresh)
        .await
        .expect("the missing folder is made with its parent");
    assert!(
        connection.host().dir_exists(&fresh).await.expect("the probe answers"),
        "the folder stands after it is made"
    );

    let probe_dir = format!("{}/pie-probe", home.directory);
    let read = connection.host().dirs(&probe_dir).await.expect("the made folder lists");
    assert!(read.entries.iter().any(|row| row.name == "sub" && row.is_dir));

    connection
        .host()
        .create_dir(&fresh)
        .await
        .expect("making what stands is fine");

    let error = connection
        .host()
        .create_dir(".pi/agent/sessions")
        .await
        .expect_err("a relative path is not a path pie resolves");
    assert!(error.to_string().contains("is not absolute"), "got {error}");
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

#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn an_attach_on_a_conversation_starts_pi_holding_that_file() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("attach-file", home.path(), 1).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));

    // A conversation for the second process: the first one writes the file.
    let session = &connection.sessions()[0];
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let before = session.state().await.expect("the state of the conversation");
    let file = wait_for_the_listing(&connection, &before.session_id).await.path;
    connection
        .detach("attach-file:1")
        .await
        .expect("the first session ends");
    assert!(connection.sessions().is_empty(), "one process per conversation");

    // The second process starts on that file. No `switch_session` runs: the file
    // is what pi holds from its first moment.
    let loaded = connection.attach(2, Some(&file), None).await.expect("pi is on PATH");
    let state = loaded.state().await.expect("the state of the loaded conversation");
    assert_eq!(
        state.session_file.as_deref(),
        Some(file.as_str()),
        "pi was started on the file"
    );
    assert_eq!(state.session_id, before.session_id, "and it is the same conversation");
}

/// A fork of a conversation starts from a user turn, and the process holds the
/// branch.
///
/// Pi lists the fork points itself (`get_fork_messages`), writes the branch into a
/// new file whose header names the file it came from, and keeps the session id in
/// the process: the conversation changes, the session does not. The old file stays
/// where pi wrote it.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_fork_branches_a_conversation_into_a_new_file() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("fork", home.path(), 1).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));

    let session = connection.sessions()[0].clone();
    let before = session.state().await.expect("the state of a fresh session");
    let entries = session
        .entries()
        .await
        .expect("the entries of a fresh session")
        .entries
        .len();
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let old_file = wait_for_the_listing(&connection, &before.session_id).await.path;
    entries_after_the_prompt(&session, entries).await;

    // The fork points arrive once pi holds the user turn; the file exists by then,
    // which is what a fork needs ("send a message before cloning or forking it").
    let point = {
        let mut found = None;
        for _ in 0..50 {
            let messages = session.fork_messages().await.expect("the fork points");
            if let Some(first) = messages.into_iter().find(|message| message.text == "first words") {
                found = Some(first);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        found.expect("pi lists the user turn as a fork point")
    };

    let forked = session.fork(&point.entry_id).await.expect("pi forks");
    assert!(!forked.cancelled, "a fork of a saved conversation is not cancelled");
    assert_eq!(
        forked.text.as_deref(),
        Some("first words"),
        "the fork answers with the message it starts from"
    );

    let after = session.state().await.expect("the state of the branch");
    assert_ne!(
        after.session_id, before.session_id,
        "the process holds another conversation"
    );
    assert_ne!(after.session_file.as_deref(), Some(old_file.as_str()));

    // A fork before the first user message holds no entry, so pi writes its file at
    // the first turn of the branch.
    session.prompt("again", None, None).await.expect("pi takes the prompt");
    let branch = wait_for_a_branch(&connection, &old_file).await;
    assert_eq!(branch.id, after.session_id, "the file is the one the process holds");
    assert_eq!(Path::new(&branch.cwd), home.path(), "the branch keeps the directory");
    assert!(Path::new(&old_file).exists(), "the file it came from stays");
}

/// A clone is a fork at the leaf: the whole branch, in a new file.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_clone_copies_the_branch_into_a_new_file() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("clone", home.path(), 1).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));

    let session = connection.sessions()[0].clone();
    let before = session.state().await.expect("the state of a fresh session");
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let old_file = wait_for_the_listing(&connection, &before.session_id).await.path;

    let cloned = session.clone_session().await.expect("pi clones");
    assert!(!cloned.cancelled, "a clone of a saved conversation is not cancelled");

    let after = session.state().await.expect("the state of the copy");
    assert_ne!(
        after.session_id, before.session_id,
        "the copy is a conversation of its own"
    );
    let branch = wait_for_a_branch(&connection, &old_file).await;
    assert_eq!(branch.id, after.session_id, "the file is the one the process holds");
    assert_eq!(
        branch.first_message.as_deref(),
        Some("first words"),
        "the copy carries the words"
    );
    assert!(Path::new(&old_file).exists(), "the file it came from stays");
}

/// A conversation can be deleted: the file goes once the process that held it is
/// gone.
///
/// Pi has no command for this, so the deletion is pie's own file operation, on the
/// machine that holds the file. A process that kept writing to a removed file would
/// write into a name nobody can open again, which is why the detach comes first.
#[ignore = "requires pi on PATH"]
#[tokio::test]
async fn a_deleted_conversation_leaves_the_listing() {
    let home = TempDir::new().expect("a temp directory");

    let connection = local("delete", home.path(), 1).await.expect("pi is on PATH");
    let connection = Arc::new(connection);
    let _stops_pi = StopsPi(Arc::clone(&connection));

    let session = connection.sessions()[0].clone();
    let state = session.state().await.expect("the state of a fresh session");
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let row = wait_for_the_listing(&connection, &state.session_id).await;

    connection.detach("delete:1").await.expect("the process goes first");
    connection.delete_conversation(&row.path).await.expect("the file goes");

    assert!(
        !connection
            .summaries()
            .await
            .expect("the listing")
            .iter()
            .any(|summary| summary.path == row.path),
        "the row is gone"
    );
}

/// The same deletion on a host, over the sftp channel of the reach.
#[ignore = "requires the ssh fixture"]
#[tokio::test]
async fn a_conversation_deleted_over_sftp_leaves_the_host_listing() {
    let fixture = Fixture::from_env();
    let store = TempDir::new().expect("a temp directory");
    let own = store.path().join("known_hosts");
    let connection = fixture
        .connect(&own, None, Answering::trusting(true))
        .await
        .expect("the host is reached");

    // The conversation of this test is its own: the fixture host holds the
    // sessions of every test that ran before it.
    let session = connection.sessions()[0].clone();
    let state = session.state().await.expect("a state");
    session
        .prompt("first words", None, None)
        .await
        .expect("pi takes the prompt");
    let row = wait_for_the_listing(&connection, &state.session_id).await;

    connection.detach("test:1").await.expect("the process goes first");
    connection
        .delete_conversation(&row.path)
        .await
        .expect("the file goes over sftp");

    assert!(
        !connection
            .summaries()
            .await
            .expect("the host listing")
            .iter()
            .any(|summary| summary.path == row.path),
        "the row is gone"
    );
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
