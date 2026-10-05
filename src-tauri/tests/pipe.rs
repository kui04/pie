//! The pipe of a session, driven without a window and without pi.
//!
//! [`forward_loop`] takes its channel, its end and its sink as arguments, so a
//! test can hold the order of what the frontend hears. The real pipe passes an
//! `AppHandle` in place of the sink of these tests, and the wait of a real
//! `Client` in place of the end.

use std::future::ready;
use std::sync::{Arc, Mutex};

use pie_lib::commands::pipe::{SessionLifecycle, Sink, forward_loop};
use pie_lib::pi_rpc::protocol::ServerMessage;
use pie_lib::pi_rpc::transport::Termination;
use serde::Serialize;
use tokio::sync::broadcast;

/// A sink that keeps what it heard, in order.
#[derive(Clone, Default)]
struct Heard(Arc<Mutex<Vec<(String, serde_json::Value)>>>);

impl Heard {
    /// The channels that were told something, in order.
    fn channels(&self) -> Vec<String> {
        self.0
            .lock()
            .expect("the lock")
            .iter()
            .map(|(channel, _)| channel.clone())
            .collect()
    }

    /// The payloads of one channel, in order.
    fn payloads(&self, channel: &str) -> Vec<serde_json::Value> {
        self.0
            .lock()
            .expect("the lock")
            .iter()
            .filter(|(heard, _)| heard == channel)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}

impl Sink for Heard {
    fn send<S: Serialize + Clone>(&self, channel: &str, payload: S) {
        let payload = serde_json::to_value(payload).expect("a payload serializes");
        self.0.lock().expect("the lock").push((channel.to_string(), payload));
    }
}

/// One record, as pi would write it.
fn record(line: &str) -> ServerMessage {
    ServerMessage::parse(line)
}

#[tokio::test]
async fn every_record_of_pi_comes_before_the_end_of_its_session() {
    let (sender, records) = broadcast::channel(16);
    for line in [
        r#"{"type":"agent_start"}"#,
        r#"{"type":"turn_start"}"#,
        r#"{"type":"agent_end","messages":[],"willRetry":false}"#,
    ] {
        sender.send(record(line)).expect("the channel takes it");
    }
    let heard = Heard::default();

    // The end is already there when the loop starts, which is the race that
    // `biased` must lose: pi wrote these records before it ended, and the
    // frontend must see them in that order.
    forward_loop(heard.clone(), "main:1", records, ready(Termination::Unknown)).await;

    assert_eq!(
        heard.channels(),
        [
            "pi://session/main:1/event",
            "pi://session/main:1/event",
            "pi://session/main:1/event",
            "pi://session/main:1/state",
        ],
        "the records of pi arrive first, and the end arrives last"
    );
    assert_eq!(
        heard.payloads("pi://session/main:1/state"),
        [serde_json::json!({ "type": "ended", "termination": { "type": "unknown" } })],
        "the end carries how pi stopped"
    );
    assert_eq!(
        heard.payloads("pi://session/main:1/event").first(),
        Some(&serde_json::json!({ "type": "agent_start" })),
        "an event travels as itself"
    );
}

#[tokio::test]
async fn a_record_that_cannot_be_described_stays_in_the_log() {
    let (sender, records) = broadcast::channel(16);
    for line in [
        // A response reaches a subscriber only when nobody waits for it.
        r#"{"id":"pie-9","type":"response","command":"abort","success":true}"#,
        // A record of a kind this mirror does not know.
        r#"{"type":"brand_new_event","payload":1}"#,
        // A line that is not JSON.
        "not json at all",
        // One event that must survive the three above.
        r#"{"type":"agent_start"}"#,
    ] {
        sender.send(record(line)).expect("the channel takes it");
    }
    let heard = Heard::default();

    forward_loop(heard.clone(), "main:2", records, ready(Termination::Unknown)).await;

    assert_eq!(
        heard.channels(),
        ["pi://session/main:2/event", "pi://session/main:2/state"],
        "nothing but the event and the end goes out"
    );
}

#[tokio::test]
async fn an_extension_dialog_and_its_failure_have_channels_of_their_own() {
    let (sender, records) = broadcast::channel(16);
    for line in [
        // Both lines are from the recorded corpus under `tests/fixtures`.
        r#"{"type":"extension_ui_request","id":"253f79b7-ec07-4b72-bd6d-36527f46e177","method":"setStatus","statusKey":"pi-permission-system","statusText":"yolo"}"#,
        r#"{"type":"extension_error","extensionPath":"/home/user/.pi/agent/ext/thing.ts","event":"tool_call","error":"boom"}"#,
    ] {
        sender.send(record(line)).expect("the channel takes it");
    }
    let heard = Heard::default();

    forward_loop(heard.clone(), "main:3", records, ready(Termination::Unknown)).await;

    assert_eq!(
        heard.channels(),
        [
            "pi://session/main:3/prompt",
            "pi://session/main:3/error",
            "pi://session/main:3/state"
        ],
        "a dialog and a failure wait on their own channels for the milestone that reads them"
    );
}

#[tokio::test]
async fn a_pipe_that_fell_behind_still_reports_the_end() {
    let (sender, records) = broadcast::channel(1);
    for index in 0..4 {
        sender
            .send(record(r#"{"type":"agent_start"}"#))
            .unwrap_or_else(|error| panic!("the channel takes record {index}: {error}"));
    }
    let heard = Heard::default();

    forward_loop(
        heard.clone(),
        "main:4",
        records,
        ready(Termination::Exited { code: 0, success: true }),
    )
    .await;

    assert_eq!(
        heard.payloads("pi://session/main:4/state"),
        [serde_json::json!({ "type": "ended", "termination": { "type": "exited", "code": 0, "success": true } })],
        "a lag loses records, and the end is still reported"
    );
    assert_eq!(
        heard.channels().last().map(String::as_str),
        Some("pi://session/main:4/state"),
        "the end is the last thing the frontend hears"
    );
}

#[test]
fn the_end_of_a_session_serializes_with_its_own_tag() {
    let ended = SessionLifecycle::Ended {
        termination: Termination::Signalled { signal: 9 },
    };

    assert_eq!(
        serde_json::to_value(&ended).expect("the payload serializes"),
        serde_json::json!({ "type": "ended", "termination": { "type": "signalled", "signal": 9 } })
    );
}
