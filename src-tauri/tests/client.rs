//! The read loop, driven by an in-memory transport. No pi, no network.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use pie_lib::pi_rpc::protocol::{
    Command, CommandKind, Event, ExtensionUiResponse, Response, ServerMessage, SessionState,
};
use pie_lib::pi_rpc::transport::{Control, Termination, Transport, TransportParts};
use pie_lib::pi_rpc::{Client, ClientOptions, Error};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{broadcast, mpsc};

/// The client's half of a scripted connection.
struct FakeTransport {
    reader: DuplexStream,
    writer: DuplexStream,
    control: FakeControl,
}

/// Lifecycle of the scripted peer: it exits when the test says so.
struct FakeControl {
    terminated: Arc<AtomicBool>,
    exit: mpsc::UnboundedReceiver<Termination>,
    fallback: Termination,
}

impl Transport for FakeTransport {
    type Reader = DuplexStream;
    type Writer = DuplexStream;
    type Control = FakeControl;

    fn split(self) -> pie_lib::pi_rpc::Result<TransportParts<DuplexStream, DuplexStream, FakeControl>> {
        Ok(TransportParts {
            reader: self.reader,
            writer: self.writer,
            control: self.control,
            diagnostics: None,
        })
    }
}

impl Control for FakeControl {
    async fn terminate(&mut self) -> pie_lib::pi_rpc::Result<()> {
        self.terminated.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn wait(&mut self) -> pie_lib::pi_rpc::Result<Termination> {
        Ok(self.exit.recv().await.unwrap_or(self.fallback))
    }
}

/// The scripted peer: what it read from the client, and how it ends.
struct FakePi {
    /// Whatever the client wrote - pi's stdin.
    stdin: BufReader<DuplexStream>,
    /// Whatever the client reads - pi's stdout.
    stdout: DuplexStream,
    terminated: Arc<AtomicBool>,
    exit: mpsc::UnboundedSender<Termination>,
}

impl FakePi {
    /// Reads one record the client sent.
    async fn read_record(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(5), self.stdin.read_line(&mut line))
            .await
            .expect("the client sent something")
            .expect("reading from the client");
        assert!(read > 0, "the client closed stdin");
        serde_json::from_str(&line).expect("the client writes JSON")
    }

    /// Emits one record, terminated with LF.
    async fn emit(&mut self, record: &str) {
        self.write_raw(record).await;
        self.write_raw("\n").await;
    }

    /// Emits bytes exactly as given, without framing.
    async fn write_raw(&mut self, bytes: &str) {
        self.stdout.write_all(bytes.as_bytes()).await.unwrap();
        self.stdout.flush().await.unwrap();
    }

    /// Emits a successful response to `id`.
    async fn respond(&mut self, id: &str, command: &str, data: serde_json::Value) {
        let record = serde_json::json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": true,
            "data": data,
        });
        self.emit(&record.to_string()).await;
    }

    /// Emits a failed response to `id`.
    async fn fail(&mut self, id: &str, command: &str, message: &str) {
        let record = serde_json::json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": false,
            "error": message,
        });
        self.emit(&record.to_string()).await;
    }

    /// Ends the peer the way a real process exit does: stdout closes, then the
    /// lifecycle handle reports how it ended.
    async fn exit(&mut self, termination: Termination) {
        self.stdout.shutdown().await.unwrap();
        let _ = self.exit.send(termination);
    }
}

/// Wires a client to a scripted peer with default options.
fn connect() -> (Client, FakePi) {
    connect_with(ClientOptions::default())
}

/// Wires a client to a scripted peer with explicit tuning.
fn connect_with(options: ClientOptions) -> (Client, FakePi) {
    let (client_stdout, pi_stdout) = tokio::io::duplex(64 * 1024);
    let (pi_stdin, client_stdin) = tokio::io::duplex(64 * 1024);
    let terminated = Arc::new(AtomicBool::new(false));
    let (exit, exit_receiver) = mpsc::unbounded_channel();

    let transport = FakeTransport {
        reader: client_stdout,
        writer: client_stdin,
        control: FakeControl {
            terminated: Arc::clone(&terminated),
            exit: exit_receiver,
            fallback: Termination::Exited { code: 0, success: true },
        },
    };
    let client = Client::start_with(transport, options).expect("the client starts");

    (
        client,
        FakePi {
            stdin: BufReader::new(pi_stdin),
            stdout: pi_stdout,
            terminated,
            exit,
        },
    )
}

/// Session state payload for the scripted peer.
fn state(level: &str) -> serde_json::Value {
    serde_json::json!({
        "thinkingLevel": level,
        "isStreaming": false,
        "isCompacting": false,
        "steeringMode": "all",
        "followUpMode": "one-at-a-time",
        "sessionId": "fake-session",
        "autoCompactionEnabled": true,
        "messageCount": 0,
        "pendingMessageCount": 0,
    })
}

/// Next record from the subscriber, or a failure after five seconds.
async fn receive(messages: &mut broadcast::Receiver<ServerMessage>) -> ServerMessage {
    tokio::time::timeout(Duration::from_secs(5), messages.recv())
        .await
        .expect("a record arrived")
        .expect("the client is alive")
}

#[tokio::test]
async fn correlates_the_response_to_its_request() {
    let (client, mut pi) = connect();

    let pending = tokio::spawn({
        let client = client.clone();
        async move { client.request(Command::new(CommandKind::GetState)).await }
    });

    let sent = pi.read_record().await;
    assert_eq!(sent["type"], "get_state");
    let id = sent["id"].as_str().expect("the client assigns an id");
    assert!(id.starts_with("pie-"), "ids are namespaced to this client");

    pi.respond(id, "get_state", state("high")).await;

    let response: Response = pending.await.unwrap().unwrap();
    assert_eq!(response.id.as_deref(), Some(id));
    let state: SessionState = response.decode().unwrap();
    assert_eq!(state.session_id, "fake-session");
}

#[tokio::test]
async fn matches_out_of_order_responses() {
    let (client, mut pi) = connect();

    let first = tokio::spawn({
        let client = client.clone();
        async move { client.request(Command::new(CommandKind::GetState)).await }
    });
    let second = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .request(Command::new(CommandKind::GetAvailableThinkingLevels))
                .await
        }
    });

    let a = pi.read_record().await;
    let b = pi.read_record().await;
    let (state_command, levels_command) = if a["type"] == "get_state" { (a, b) } else { (b, a) };

    // Answer the second command first, exactly as pi interleaves its output.
    pi.respond(
        levels_command["id"].as_str().unwrap(),
        "get_available_thinking_levels",
        serde_json::json!({"levels": ["off", "high"]}),
    )
    .await;
    pi.respond(state_command["id"].as_str().unwrap(), "get_state", state("off"))
        .await;

    let state_response = first.await.unwrap().unwrap();
    let levels_response = second.await.unwrap().unwrap();

    let state: SessionState = state_response.decode().unwrap();
    assert_eq!(state.steering_mode, pie_lib::pi_rpc::protocol::QueueMode::All);
    assert_eq!(state.follow_up_mode, pie_lib::pi_rpc::protocol::QueueMode::OneAtATime);
    let levels: pie_lib::pi_rpc::protocol::AvailableThinkingLevelsData = levels_response.decode().unwrap();
    assert_eq!(levels.levels.len(), 2);
}

#[tokio::test]
async fn turns_a_failed_response_into_an_rpc_error() {
    let (client, mut pi) = connect();

    let pending = tokio::spawn({
        let client = client.clone();
        async move { client.request(Command::new(CommandKind::Abort)).await }
    });

    let sent = pi.read_record().await;
    let id = sent["id"].as_str().unwrap();
    pi.fail(id, "abort", "nothing to abort").await;

    match pending.await.unwrap() {
        Err(Error::Rpc { command, message }) => {
            assert_eq!(command, "abort");
            assert_eq!(message, "nothing to abort");
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[tokio::test]
async fn times_out_a_request_that_is_never_answered() {
    let (client, mut pi) = connect();

    let outcome = client
        .request_with_timeout(Command::new(CommandKind::GetState), Duration::from_millis(50))
        .await;
    assert!(matches!(outcome, Err(Error::Timeout { .. })));

    // The command still reached pi; only the waiter is gone.
    let sent = pi.read_record().await;
    assert_eq!(sent["type"], "get_state");

    let mut messages = client.subscribe();
    pi.respond(sent["id"].as_str().unwrap(), "get_state", state("high"))
        .await;
    assert!(
        matches!(receive(&mut messages).await, ServerMessage::Response(response) if response.id.is_some()),
        "an answer nobody waits for is broadcast"
    );
}

#[tokio::test]
async fn broadcasts_events_and_keeps_unmapped_records() {
    let (client, mut pi) = connect();
    let mut messages = client.subscribe();

    pi.emit(r#"{"type":"queue_update","steering":[],"followUp":["a"]}"#)
        .await;
    pi.emit(r#"{"type":"brand_new_event","payload":1}"#).await;
    pi.emit("not json at all").await;

    assert!(matches!(
        receive(&mut messages).await,
        ServerMessage::Event(Event::QueueUpdate { .. })
    ));
    assert!(matches!(receive(&mut messages).await, ServerMessage::Unknown { .. }));
    assert!(matches!(
        receive(&mut messages).await,
        ServerMessage::Unparseable { .. }
    ));
}

#[tokio::test]
async fn dispatches_the_final_record_at_eof() {
    // Framing itself - partial records, CR, U+2028, `finish` - is pinned by the
    // `framing` unit tests. What only the read loop can get wrong is flushing the
    // last, LF-less record when pi's stdout ends.
    let (client, mut pi) = connect();
    let mut messages = client.subscribe();
    pi.write_raw(r#"{"type":"agent_settled"}"#).await;
    pi.exit(Termination::Exited { code: 0, success: true }).await;
    assert!(matches!(
        receive(&mut messages).await,
        ServerMessage::Event(Event::AgentSettled)
    ));
}

#[tokio::test]
async fn shutdown_closes_stdin_without_killing_pi() {
    let (client, mut pi) = connect();

    let shutdown = tokio::spawn({
        let client = client.clone();
        async move { client.shutdown().await }
    });

    // pi sees EOF on stdin: that is the protocol's orderly shutdown.
    let mut rest = String::new();
    assert_eq!(pi.stdin.read_line(&mut rest).await.unwrap(), 0, "stdin must close");
    assert!(
        !pi.terminated.load(Ordering::SeqCst),
        "a graceful shutdown must not kill pi"
    );

    pi.exit(Termination::Exited { code: 0, success: true }).await;
    assert_eq!(shutdown.await.unwrap(), Termination::Exited { code: 0, success: true });
    assert!(client.is_closed());
    assert!(matches!(
        client.send(&Command::new(CommandKind::GetState)).await,
        Err(Error::Closed)
    ));
}

#[tokio::test]
async fn terminate_kills_the_peer() {
    let (client, mut pi) = connect();

    let terminating = tokio::spawn({
        let client = client.clone();
        async move { client.terminate().await }
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !pi.terminated.load(Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "terminate() never reached the peer"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    pi.exit(Termination::Signalled { signal: 9 }).await;
    assert_eq!(terminating.await.unwrap(), Termination::Signalled { signal: 9 });
    assert!(client.is_closed());
}

#[tokio::test]
async fn fails_pending_requests_when_pi_exits() {
    let (client, mut pi) = connect();

    let pending = tokio::spawn({
        let client = client.clone();
        async move { client.request(Command::new(CommandKind::GetState)).await }
    });
    let _sent = pi.read_record().await;

    pi.exit(Termination::Exited {
        code: 1,
        success: false,
    })
    .await;

    assert!(matches!(pending.await.unwrap(), Err(Error::Closed)));
    assert_eq!(
        client.wait().await,
        Termination::Exited {
            code: 1,
            success: false
        }
    );
}

#[tokio::test]
async fn a_fire_and_forget_command_carries_no_id() {
    let (client, mut pi) = connect();
    let mut messages = client.subscribe();

    client.send(&Command::new(CommandKind::Abort)).await.unwrap();

    let sent = pi.read_record().await;
    assert_eq!(sent["type"], "abort");
    assert!(sent.get("id").is_none(), "an unawaited command is not correlated");

    // Nothing waits for the answer, so pi's response reaches the subscribers
    // instead of resolving a request.
    pi.emit(r#"{"id":"nobody-is-waiting","type":"response","command":"abort","success":true}"#)
        .await;
    match receive(&mut messages).await {
        ServerMessage::Response(response) => assert_eq!(response.command, "abort"),
        other => panic!("unexpected record: {other:?}"),
    }
}

#[tokio::test]
async fn answers_an_extension_ui_dialog() {
    let (client, mut pi) = connect();
    let mut messages = client.subscribe();

    pi.emit(r#"{"type":"extension_ui_request","id":"d1","method":"confirm","title":"Run?","message":"Lots of files"}"#)
        .await;
    let ServerMessage::ExtensionUiRequest(request) = receive(&mut messages).await else {
        panic!("expected a dialog");
    };

    client
        .send_extension_ui_response(&ExtensionUiResponse::confirm(&request.id, true))
        .await
        .unwrap();

    let sent = pi.read_record().await;
    assert_eq!(
        sent,
        serde_json::json!({"type": "extension_ui_response", "id": "d1", "confirmed": true})
    );
}

#[tokio::test]
async fn two_subscribers_both_receive_an_event() {
    let (client, mut pi) = connect();
    let mut first = client.subscribe();
    let mut second = client.subscribe();

    pi.emit(r#"{"type":"agent_settled"}"#).await;

    assert!(matches!(
        receive(&mut first).await,
        ServerMessage::Event(Event::AgentSettled)
    ));
    assert!(matches!(
        receive(&mut second).await,
        ServerMessage::Event(Event::AgentSettled)
    ));
}

#[tokio::test]
async fn a_lagging_subscriber_skips_records_instead_of_stalling_the_loop() {
    let (client, mut pi) = connect_with(ClientOptions {
        broadcast_capacity: 2,
        ..ClientOptions::default()
    });
    let mut messages = client.subscribe();

    for _ in 0..5 {
        pi.emit(r#"{"type":"agent_settled"}"#).await;
    }
    // A request is answered only after the records before it were dispatched, so
    // awaiting one is an ordering barrier instead of a sleep.
    let barrier = tokio::spawn({
        let client = client.clone();
        async move { client.request(Command::new(CommandKind::GetState)).await }
    });
    let asked = pi.read_record().await;
    pi.respond(asked["id"].as_str().unwrap(), "get_state", state("high"))
        .await;
    barrier.await.unwrap().unwrap();

    match messages.recv().await {
        Err(broadcast::error::RecvError::Lagged(skipped)) => assert!(skipped >= 1),
        other => panic!("expected a lag report, got {other:?}"),
    }
}

/// Types are `Send`/`Sync` and the public futures are `Send`, checked by the
/// compiler: a stray `!Send` field, or a lock guard held across an `.await`,
/// would otherwise only break whoever first spawns one of these.
const fn assert_send_type<T: Send>() {}
const fn assert_sync_type<T: Sync>() {}

const _: () = assert_send_type::<Client>();
const _: () = assert_sync_type::<Client>();
const _: () = assert_send_type::<ServerMessage>();
const _: () = assert_sync_type::<ServerMessage>();
const _: () = assert_send_type::<Command>();
const _: () = assert_send_type::<Event>();
const _: () = assert_send_type::<Response>();

#[tokio::test]
async fn the_public_futures_are_send() {
    fn assert_send<T: Send>(_: T) {}
    let (client, _pi) = connect();

    assert_send(client.request(Command::new(CommandKind::GetState)));
    assert_send(client.request_with_timeout(Command::new(CommandKind::GetState), Duration::from_secs(1)));
    assert_send(client.send(&Command::new(CommandKind::GetState)));
    assert_send(client.send_extension_ui_response(&ExtensionUiResponse::confirm("dialog", true)));
    assert_send(client.wait());
    assert_send(client.shutdown());
    assert_send(client.terminate());
}
