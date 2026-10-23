//! The app's own channel against a scripted child process, and - when asked -
//! against a real `pi`.
//!
//! The protocol client comes from the `pi_rpc` crate; what this file tests is the
//! layer under it: that a started program hands back the records pi wrote, that
//! closing it is the orderly shutdown pi expects, and that the lifecycle handle
//! reports the end the process actually had.

use std::path::PathBuf;

use pi_rpc::client::Client;
use pi_rpc::command::{Command, Common};
use pi_rpc::error::ErrorKind;
use pi_rpc::response::{BashResult, SessionState};
use pie_lib::channel::{Channel, Handle, Program, Termination};
use pie_lib::host::{Host, PI_VERSION, check_version};

/// Absolute path of a script under `tests/scripts`.
fn script(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "tests", "scripts", name].iter().collect()
}

/// The scripted pi, as a channel of the app.
fn fake_pi() -> Channel {
    Program::new("bash")
        .arg(script("fake-pi.sh"))
        .spawn()
        .expect("the scripted pi starts")
}

/// A client over one channel, and the handle on the process behind it.
fn start(channel: Channel) -> (Client, Handle) {
    let handle = channel.handle();
    (Client::new(channel), handle)
}

#[tokio::test]
async fn drives_a_local_process() {
    let (client, handle) = start(fake_pi());
    assert!(handle.is_alive(), "the process was just started");

    let state: SessionState = client.get_state().await.expect("the state arrives");
    assert_eq!(state.session_id, "fake-session");

    let result: BashResult = client
        .bash_with(pi_rpc::client::BashReq {
            command: "printf hello".to_string(),
            exclude_from_context: Some(true),
        })
        .await
        .expect("the command runs");
    assert_eq!(result.exit_code, Some(0.0));
    assert_eq!(result.output, "hello\n");

    // Closing the write half is the orderly shutdown: the child sees EOF on
    // stdin and exits on its own.
    client.close().await.expect("the client closes");
    assert_eq!(handle.wait().await, Termination::Exited { code: 0, success: true });
    assert!(!handle.is_alive(), "the process is gone");
}

#[tokio::test]
async fn ends_a_child_that_never_reads_its_stdin() {
    // `sleep` ignores both stdin and the polite request to stop.
    let channel = Program::new("bash")
        .args(["-c", "exec sleep 60"])
        .spawn()
        .expect("the child starts");
    let handle = channel.handle();
    let _client = Client::new(channel);

    handle.terminate().await;
    match handle.wait().await {
        Termination::Signalled { .. } | Termination::Exited { success: false, .. } => {}
        other => panic!("unexpected termination: {other:?}"),
    }
}

#[tokio::test]
async fn a_channel_that_is_gone_answers_at_once() {
    let (client, handle) = start(fake_pi());
    client.close().await.expect("the client closes");

    // The first wait is what notices the end; every later one is immediate and
    // says the same thing about the same process.
    let first = handle.wait().await;
    let second = tokio::time::timeout(std::time::Duration::from_secs(1), handle.wait())
        .await
        .expect("a finished program answers at once");

    assert_eq!(first, second);
}

#[tokio::test]
async fn a_channel_that_ends_is_a_closed_client() {
    // The end of the bytes reaches the app as `Closed`, which is what turns
    // "pi exited" into a sentence for a person.
    let (client, _handle) = start(fake_pi());
    client.close().await.expect("the client closes");

    let error = client.get_state().await.expect_err("a closed client sends nothing");
    assert_eq!(error.kind(), ErrorKind::Closed, "got {error}");
}

/// A command pi refuses is a response, not a failure of the bytes: `send_raw`
/// hands back what pi wrote, and the typed helpers turn that refusal into an
/// error. This is the split the app's own reads work on.
#[tokio::test]
async fn a_refused_command_comes_back_as_the_response_pi_wrote() {
    let (client, _handle) = start(fake_pi());

    let response = client
        .send_raw(Command::Abort(Common { id: None }))
        .await
        .expect("pi answered, which is not a failure of the channel");

    match response {
        pi_rpc::response::Response::Error(failed) => {
            assert_eq!(failed.command, "unknown");
            assert!(failed.error.contains("unexpected command"), "got {}", failed.error);
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

/// A real `pi`, the one test here that can fail for a reason outside pie.
///
/// Ignored by default because it needs `pi` on `PATH`. Run it after bumping the
/// pin: `cargo test --test channel -- --ignored`.
#[tokio::test]
#[ignore = "requires pi on PATH"]
async fn drives_real_pi() {
    let host = Host::local(None);
    let version = host.pi_version().await.expect("`pi --version` runs");
    check_version(&version).expect("pi matches the pinned protocol version");
    assert_eq!(version, PI_VERSION, "the probe reports the pinned release");

    let (client, handle) = start(
        Program::new("pi")
            .args(["--mode", "rpc", "--no-session"])
            .spawn()
            .expect("pi starts"),
    );

    let state: SessionState = client.get_state().await.expect("the state arrives");
    assert!(!state.session_id.is_empty(), "a real session has an id");

    let levels = client.get_available_thinking_levels().await.expect("the levels arrive");
    assert!(
        levels.contains(&pi_rpc::types::ThinkingLevel::Off),
        "`off` is part of a real session's value space"
    );

    client
        .send_raw(Command::SetSessionName(pi_rpc::command::SetSessionName {
            id: None,
            name: "pie conformance".to_string(),
        }))
        .await
        .expect("the name is accepted");

    // Closing says "wind down": pi disposes the session, writes what that
    // disposal produces, and exits on its own. It has to end at 0 - a program
    // that dies writing its tail records is a disconnect reported as a crash.
    client.close().await.expect("the client closes");
    assert_eq!(
        handle.wait().await,
        Termination::Exited { code: 0, success: true },
        "closing stdin is an orderly shutdown",
    );
}

/// Closing the write half is the orderly shutdown pi expects: its stdin ends, it
/// disposes the session, writes the records of that disposal, and exits 0.
///
/// This drives the bytes themselves rather than `pi_rpc::Client`, so it holds the
/// channel's own contract apart from the client's: the write half closes, the last
/// records still arrive, and the child reports a clean exit. `drives_real_pi`
/// covers the same end through the client.
#[tokio::test]
#[ignore = "requires pi on PATH"]
async fn closing_the_write_half_is_the_orderly_shutdown() {
    use pi_rpc::transport::{Transport, TransportRecv, TransportSend};

    let channel = Program::new("pi")
        .args(["--mode", "rpc", "--no-session"])
        .spawn()
        .expect("pi starts");
    let handle = channel.handle();
    let (mut tx, mut rx) = channel.split();
    tx.send(r#"{"id":"1","type":"get_state"}"#.to_string())
        .await
        .expect("the command goes out");
    tx.close().await.expect("the write half closes");
    drop(tx);

    let mut records = Vec::new();
    while let Some(record) = rx.recv().await.expect("a record arrives") {
        records.push(record);
    }

    assert!(
        records.iter().any(|record| record.contains(r#""command":"get_state""#)),
        "the answer arrives: {records:?}"
    );
    assert!(
        records.len() > 1,
        "pi keeps writing while it disposes the session: {records:?}"
    );
    assert_eq!(handle.wait().await, Termination::Exited { code: 0, success: true },);
}
