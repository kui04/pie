//! Tests that drive a real `pi` on the e2e host.
//!
//! They are ignored by default. Start the mock host first, then run them:
//!
//! ```sh
//! e2e/setup.sh
//! docker compose -f e2e/compose.yaml up -d --wait
//! cargo test --lib live_ -- --ignored --nocapture
//! ```
//!
//! The real-model test needs the real host and spends one model call:
//!
//! ```sh
//! e2e/run.sh real   # or bring up host-real with e2e/.testenv/real.env
//! cargo test --lib live_real_ -- --ignored --nocapture
//! ```

use std::time::Duration;

use camino::Utf8PathBuf;
use hostaddr::HostAddr;
use pi_rpc::event::Event;
use russh::keys::PublicKey;
use typed_path::Utf8TypedPath;

use super::ssh::trust::KnownHosts;
use super::*;
use crate::bus::Bus;
use crate::state::LocalDirs;

fn e2e_ssh_dir() -> Utf8PathBuf {
    Utf8PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../e2e/.testenv/ssh")
}

fn key_text() -> String {
    let path = e2e_ssh_dir().join("id_ed25519");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read `{path}`: {error}; run e2e/setup.sh"))
}

fn target(port: u16) -> HostTarget {
    HostTarget::Ssh {
        user: "pi".to_owned(),
        host: HostAddr::try_from(("127.0.0.1", port)).expect("a host address"),
        auth: HostAuth::Key {
            private_key: key_text(),
            passphrase: None,
        },
    }
}

/// Sends one prompt and waits for the run that does not retry.
async fn run_prompt(session: &Session, prompt: &str, patience: Duration) {
    let mut events = session.client().subscribe();
    session
        .client()
        .prompt(prompt)
        .await
        .expect("pi accepts the prompt");

    let deadline = tokio::time::Instant::now() + patience;
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .expect("the run ends in time")
            .expect("the event stream stays open");
        if let Event::AgentEnd(end) = &*event
            && !end.will_retry
        {
            return;
        }
    }
}

/// The conversation file of `session`, as pi wrote it.
async fn conversation_text(connection: &HostConnection, session: &Session) -> String {
    let path = session.path();
    let bytes = connection
        .host()
        .read_bytes(path.to_path())
        .await
        .expect("the conversation file is readable");
    String::from_utf8(bytes.to_vec()).expect("the conversation is text")
}

#[tokio::test]
#[ignore = "needs e2e/setup.sh and the mock host"]
async fn live_mock_pi_round_trips_a_session() {
    let ssh = e2e_ssh_dir();
    let (bus, _events) = Bus::recording(8);
    bus.ready();

    let dirs = LocalDirs {
        known_hosts: ssh.join("known_hosts"),
        ..Default::default()
    };
    let connection = connect(HostId::new("live-mock"), target(2222), bus.clone(), &dirs)
        .await
        .expect("the mock host answers");

    let listed = connection.list_sessions().await.expect("the catalog");
    assert!(listed.len() >= 2, "{listed:?}");

    let session = connection
        .start_new_session(Utf8TypedPath::derive("/home/pi/work"), bus)
        .await
        .expect("a new session starts");
    let path = session.path();

    run_prompt(&session, "hello", Duration::from_secs(120)).await;

    let text = conversation_text(&connection, &session).await;
    assert!(text.contains("\"role\":\"assistant\""), "{text}");
    assert!(
        text.contains("Hello from the pie mock"),
        "the mock answers: {text}"
    );

    connection
        .delete_session(&path)
        .await
        .expect("the session is deleted");
    assert!(connection.session(&path).is_none());
    connection.disconnect().await.expect("the host disconnects");
}

#[tokio::test]
#[ignore = "needs the real e2e host and spends one model call"]
async fn live_real_pi_round_trips_a_session() {
    let ssh = e2e_ssh_dir();
    let host_key = std::fs::read_to_string(ssh.join("host_ed25519.pub"))
        .expect("the e2e host key; run e2e/setup.sh");
    let host_key = PublicKey::from_openssh(host_key.trim()).expect("the host key");

    let known = tempfile::tempdir().expect("a temporary directory");
    let known_hosts =
        Utf8PathBuf::from_path_buf(known.path().join("known_hosts")).expect("a UTF-8 path");
    let store = KnownHosts::new(known_hosts.clone());
    store
        .remember(
            &HostAddr::try_from(("127.0.0.1", 2223)).expect("a host address"),
            &host_key,
        )
        .expect("the host key is recorded");

    let (bus, _events) = Bus::recording(8);
    bus.ready();
    let dirs = LocalDirs {
        known_hosts,
        ..Default::default()
    };
    let connection = connect(HostId::new("live-real"), target(2223), bus.clone(), &dirs)
        .await
        .expect("the real host answers");

    let session = connection
        .start_new_session(Utf8TypedPath::derive("/home/pi/work"), bus)
        .await
        .expect("a new session starts");
    let path = session.path();

    run_prompt(
        &session,
        "Reply with one short sentence about the word pie.",
        Duration::from_secs(300),
    )
    .await;

    let text = conversation_text(&connection, &session).await;
    assert!(text.contains("\"role\":\"user\""), "{text}");
    assert!(text.contains("\"role\":\"assistant\""), "{text}");

    connection
        .delete_session(&path)
        .await
        .expect("the session is deleted");
    connection.disconnect().await.expect("the host disconnects");
}
