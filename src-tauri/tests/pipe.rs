//! The pipe of a session, driven against the scripted peer.
//!
//! [`forward_loop`] takes its stream, its end and its sink as arguments, so a
//! test can hold the order of what the frontend hears. The stream comes from a
//! real client - the protocol layer builds it, and nothing else can - and the
//! peer behind it is `fake-pi.sh`, which answers like pi and exits on its own
//! when its stdin ends.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pi_rpc::client::{BashReq, Client, Config};
use pie_lib::channel::{Channel, Handle, Program, Termination};
use pie_lib::commands::pipe::{SessionLifecycle, Sink, forward_loop};
use serde::Serialize;

/// Absolute path of a script under `tests/scripts`.
fn script(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "tests", "scripts", name].iter().collect()
}

/// A client over the scripted program, and the watch of that program.
fn fake_pi() -> (Client, Handle) {
    let channel: Channel = Program::new("bash")
        .arg(script("fake-pi.sh"))
        .spawn()
        .expect("the scripted pi starts");
    let handle = channel.handle();
    (Client::new(channel), handle)
}

/// The same, with the client tuned: the buffer of the subscription is what a test sets.
fn tuned_pi(config: Config) -> (Client, Handle) {
    let channel: Channel = Program::new("bash")
        .arg(script("fake-pi.sh"))
        .spawn()
        .expect("the scripted pi starts");
    let handle = channel.handle();
    (Client::with_config(channel, config), handle)
}

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

    /// What was heard, in order: the channel, and the kind of payload it carried.
    fn typed(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .expect("the lock")
            .iter()
            .map(|(channel, payload)| {
                let kind = payload["type"].as_str().unwrap_or("?").to_string();
                (channel.clone(), kind)
            })
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

#[tokio::test]
async fn every_record_of_pi_comes_before_the_end_of_its_session() {
    let (client, peer) = fake_pi();
    let records = client.subscribe();
    let heard = Heard::default();

    // A shell command makes the peer write an event before it answers, which is
    // what pi does too. The client closes only after that answer, so the end
    // cannot overtake the records it wrote before it.
    let driving = tokio::spawn({
        async move {
            client
                .bash_with(BashReq {
                    command: "printf hello".to_string(),
                    exclude_from_context: None,
                })
                .await
                .expect("the command runs");
            client.close().await.expect("the client closes");
        }
    });

    forward_loop(heard.clone(), "main:1", records, peer.wait()).await;
    driving.await.expect("the driver finishes");

    let events = heard.payloads("pi://session/main:1/event");
    assert_eq!(events.len(), 1, "the update of the command is one event: {events:?}");
    assert_eq!(
        events[0]["type"], "bash_execution_update",
        "an event travels as pi wrote it: {events:?}"
    );
    assert_eq!(
        heard.channels().last().map(String::as_str),
        Some("pi://session/main:1/state"),
        "the end is the last thing the frontend hears"
    );
    assert_eq!(
        heard.payloads("pi://session/main:1/state"),
        [serde_json::json!({ "type": "ended", "termination": { "type": "exited", "code": 0, "success": true } })],
        "the end carries how pi stopped"
    );
}

#[tokio::test]
async fn a_record_of_a_kind_this_build_does_not_mirror_replays_verbatim() {
    let (client, peer) = fake_pi();
    let records = client.subscribe();
    let heard = Heard::default();

    let driving = tokio::spawn({
        async move {
            // The scripted peer answers an unknown command with an error
            // response, and writes nothing else; the event of a known command is
            // what proves the pipe still carried the stream.
            client
                .bash_with(BashReq {
                    command: "printf hello".to_string(),
                    exclude_from_context: None,
                })
                .await
                .expect("the command runs");
            client.close().await.expect("the client closes");
        }
    });

    forward_loop(heard.clone(), "main:2", records, peer.wait()).await;
    driving.await.expect("the driver finishes");

    let events = heard.payloads("pi://session/main:2/event");
    assert!(
        events.iter().all(|event| event["type"] != "response"),
        "an answer nobody waits for is not an event: {events:?}"
    );
}

#[tokio::test]
async fn a_session_that_ends_without_a_record_reports_only_its_end() {
    let (client, peer) = fake_pi();
    let records = client.subscribe();
    let heard = Heard::default();

    let driving = tokio::spawn({
        async move {
            client.close().await.expect("the client closes");
        }
    });

    forward_loop(heard.clone(), "main:3", records, peer.wait()).await;
    driving.await.expect("the driver finishes");

    assert_eq!(
        heard.channels(),
        ["pi://session/main:3/state"],
        "a session that wrote nothing still reports its end"
    );
    assert_eq!(
        heard.payloads("pi://session/main:3/state"),
        [serde_json::json!({ "type": "ended", "termination": { "type": "exited", "code": 0, "success": true } })],
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

#[test]
fn the_gap_of_a_session_serializes_as_its_own_kind() {
    assert_eq!(
        serde_json::to_value(SessionLifecycle::Lagged).expect("the payload serializes"),
        serde_json::json!({ "type": "lagged" })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pipe_that_fell_behind_reports_the_gap_and_carries_on() {
    // One record is the smallest buffer the protocol layer takes. The burst is written
    // before the pipe reads anything, so the buffer keeps the newest of three and the
    // stream has two to report as gone - the hole a slow reader would leave.
    let (client, peer) = tuned_pi(Config::default().with_event_capacity(1));
    let records = client.subscribe();
    client
        .bash_with(BashReq {
            command: "burst".to_string(),
            exclude_from_context: None,
        })
        .await
        .expect("the burst runs");
    client.close().await.expect("the client closes");

    let heard = Heard::default();
    forward_loop(heard.clone(), "main:4", records, peer.wait()).await;

    let event = "pi://session/main:4/event";
    let state = "pi://session/main:4/state";
    assert_eq!(
        heard.typed(),
        [
            (state.to_string(), "lagged".to_string()),
            (event.to_string(), "bash_execution_update".to_string()),
            (state.to_string(), "ended".to_string()),
        ],
        "the gap is reported, the records after it follow, and the end closes: {:?}",
        heard.payloads(event)
    );
    assert_eq!(
        heard.payloads(event)[0]["delta"],
        "three\n",
        "the record that survived the gap is the newest one"
    );
}
