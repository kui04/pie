//! [`LocalTransport`](pie_lib::pi_rpc::transport::LocalTransport) against a scripted child
//! process, and - when asked - against a real `pi`.

use std::path::PathBuf;
use std::time::Duration;

use pie_lib::pi_rpc::Client;
use pie_lib::pi_rpc::protocol::{
    AvailableThinkingLevelsData, BashResult, Command, CommandKind, Event, ModelThinkingLevel, ServerMessage,
    SessionState,
};
use pie_lib::pi_rpc::transport::{LocalTransport, Termination};
use tokio::sync::broadcast;

/// Absolute path of a script under `tests/scripts`.
fn script(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "tests", "scripts", name].iter().collect()
}

/// Next record from the subscriber, or a failure after five seconds.
async fn receive(messages: &mut broadcast::Receiver<ServerMessage>) -> ServerMessage {
    tokio::time::timeout(Duration::from_secs(5), messages.recv())
        .await
        .expect("a record arrived")
        .expect("the client is alive")
}

#[tokio::test]
async fn drives_a_local_process() {
    let process = LocalTransport::new("bash")
        .arg(script("fake-pi.sh"))
        .spawn()
        .expect("the scripted pi starts");
    assert!(process.id().is_some());

    let client = Client::start(process).expect("the client starts");
    let mut messages = client.subscribe();

    let response = client.request(Command::new(CommandKind::GetState)).await.unwrap();
    let state: SessionState = response.decode().unwrap();
    assert_eq!(state.session_id, "fake-session");
    assert_eq!(state.thinking_level, ModelThinkingLevel::High);

    // `bash` emits an event before its response, as pi does.
    let response = client
        .request(Command::new(CommandKind::Bash {
            command: "printf hello".to_string(),
            exclude_from_context: Some(true),
        }))
        .await
        .unwrap();
    let result: BashResult = response.decode().unwrap();
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.output, "hello\n");
    assert!(matches!(
        receive(&mut messages).await,
        ServerMessage::Event(Event::BashExecutionUpdate { .. })
    ));

    // Closing stdin is the orderly shutdown: the child exits on its own.
    assert_eq!(client.shutdown().await, Termination::Exited { code: 0, success: true });
}

#[tokio::test]
async fn kills_the_child_on_terminate() {
    let process = LocalTransport::new("bash")
        .arg(script("fake-pi.sh"))
        .spawn()
        .expect("the scripted pi starts");
    let client = Client::start(process).expect("the client starts");

    match client.terminate().await {
        Termination::Signalled { .. } | Termination::Exited { success: false, .. } => {}
        other => panic!("unexpected termination: {other:?}"),
    }
    assert!(client.is_closed());
}

/// The conformance test that matters most, and the slowest: a real `pi`.
///
/// Ignored by default because it needs `pi` on `PATH` and starts a real session.
/// Run it after bumping the pin: `cargo test --test local_pi -- --ignored`.
#[tokio::test]
#[ignore = "requires pi on PATH"]
async fn drives_real_pi() {
    let version = pie_lib::pi_rpc::probe_version("pi").await.expect("`pi --version` runs");
    pie_lib::pi_rpc::check_version(&version).expect("pi matches the pinned protocol version");

    let process = LocalTransport::pi().arg("--no-session").spawn().expect("pi starts");
    let client = Client::start(process).expect("the client starts");

    let response = client.request(Command::new(CommandKind::GetState)).await.unwrap();
    let state: SessionState = response.decode().unwrap();
    assert!(!state.session_id.is_empty(), "a real session has an id");

    let response = client
        .request(Command::new(CommandKind::GetAvailableThinkingLevels))
        .await
        .unwrap();
    let levels: AvailableThinkingLevelsData = response.decode().unwrap();
    assert!(
        levels.levels.contains(&ModelThinkingLevel::Off),
        "`off` is part of a real session's value space"
    );

    let response = client
        .request(Command::new(CommandKind::SetSessionName {
            name: "pie conformance".to_string(),
        }))
        .await
        .unwrap();
    assert!(response.is_success());

    assert_eq!(
        client.shutdown().await,
        Termination::Exited { code: 0, success: true },
        "closing stdin is an orderly shutdown"
    );
}
