//! The message bus from Rust to the frontend: asks that wait for an answer, and
//! notifications that do not. One channel carries both kinds.
//!
//! A webview has no event replay, so an event emitted before its listener is up is
//! lost. [`Bus`] remembers every ask it waits on and buffers the notifications
//! that opt in, then [`Bus::ready`] replays the asks with their remaining budget
//! and flushes the buffer.

use std::collections::{BTreeMap, VecDeque};
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter as _};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio::time::Instant;

/// Names one ask, so its [`Answer`] finds it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AskId(u64);

impl Display for AskId {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "ask-{}", self.0)
    }
}

/// One ask on the wire, with what is left of the time its bus waits.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskEnvelope {
    pub id: AskId,
    /// Milliseconds left to show a countdown against.
    pub timeout_ms: u64,
    pub payload: Value,
}

/// What the frontend answered.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "status", content = "data", rename_all = "snake_case")]
pub enum Answer {
    /// The ask was answered; the payload deserializes as [`Ask::Answer`].
    Resolved(Value),
    /// A person or the frontend refused it.
    Rejected(String),
}

/// A payload the frontend must answer.
pub trait Ask: Serialize + Send + Sync + 'static {
    type Answer: DeserializeOwned + Send + 'static;
    const EVENT_NAME: &'static str;
}

/// A payload the frontend only reads.
pub trait Notification: Serialize + Send + Sync + 'static {
    const EVENT_NAME: &'static str;

    /// Whether a notification sent before [`Bus::ready`] is kept.
    ///
    /// On for state and alerts, off for high-frequency updates that are stale by
    /// the time a listener reads them.
    const BUFFER_UNTIL_READY: bool = true;
}

/// A failure of [`Bus::ask`] or [`Bus::notify`].
#[derive(Debug, thiserror::Error)]
pub enum BusError {
    #[error("the ask timed out after {0:?}")]
    Timeout(Duration),
    #[error("the frontend rejected the ask: {0}")]
    Rejected(String),
    #[error("payload serialization failed: {0}")]
    Serialization(#[source] serde_json::Error),
    #[error("webview event emission failed: {0}")]
    Emit(#[source] tauri::Error),
    #[error("the bus closed before the ask was answered")]
    Closed,
}

impl From<serde_json::Error> for BusError {
    fn from(err: serde_json::Error) -> Self {
        Self::Serialization(err)
    }
}

impl From<tauri::Error> for BusError {
    fn from(err: tauri::Error) -> Self {
        Self::Emit(err)
    }
}

/// Where the events of a [`Bus`] leave.
trait Emitter: Send + Sync {
    fn emit(&self, event: &str, payload: &Value) -> Result<(), tauri::Error>;
}

struct AppEmitter(AppHandle);

impl Emitter for AppEmitter {
    fn emit(&self, event: &str, payload: &Value) -> Result<(), tauri::Error> {
        self.0.emit(event, payload)
    }
}

/// One notification kept until the frontend is ready.
#[derive(Debug)]
struct BufferedNotification {
    event: &'static str,
    payload: Value,
}

/// Readiness and the kept notifications, behind one lock so a send cannot pass a
/// check that was already stale.
#[derive(Debug, Default)]
struct NotificationBuffer {
    ready: bool,
    queue: VecDeque<BufferedNotification>,
}

/// One ask that waits for its [`Answer`].
struct PendingAsk {
    event: &'static str,
    payload: Value,
    deadline: Instant,
    responder: oneshot::Sender<Answer>,
    /// Held until the ask is answered, times out, or is dropped.
    _permit: OwnedSemaphorePermit,
}

struct Inner {
    emitter: Arc<dyn Emitter>,
    buffer: Mutex<NotificationBuffer>,
    next_id: AtomicU64,
    in_flight: Mutex<BTreeMap<AskId, PendingAsk>>,
    concurrency_limit: Arc<Semaphore>,
}

/// The message bus to the frontend: it asks, and it notifies.
#[derive(Clone)]
pub struct Bus {
    inner: Arc<Inner>,
}

impl fmt::Debug for Bus {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let in_flight_count = self
            .inner
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len();
        let ready = self
            .inner
            .buffer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .ready;

        f.debug_struct("Bus")
            .field("in_flight", &in_flight_count)
            .field("ready", &ready)
            .finish_non_exhaustive()
    }
}

impl Bus {
    /// An bus that waits on at most `max_in_flight` asks at once.
    pub fn new(app: AppHandle, max_in_flight: usize) -> Self {
        Self::with_emitter(Arc::new(AppEmitter(app)), max_in_flight)
    }

    /// A bus whose events leave through `emitter`.
    fn with_emitter(emitter: Arc<dyn Emitter>, max_in_flight: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                emitter,
                buffer: Mutex::new(NotificationBuffer::default()),
                next_id: AtomicU64::new(1),
                in_flight: Mutex::new(BTreeMap::new()),
                concurrency_limit: Arc::new(Semaphore::new(max_in_flight.max(1))),
            }),
        }
    }

    /// Asks the frontend, and waits for its typed [`Ask::Answer`].
    ///
    /// A full channel waits for a slot inside the same `timeout`. The entry is
    /// removed when the ask is answered, times out, or its future is dropped.
    pub async fn ask<R: Ask>(&self, ask: R, timeout: Duration) -> Result<R::Answer, BusError> {
        let deadline = Instant::now() + timeout;
        let payload = serde_json::to_value(ask)?;

        let permit = tokio::time::timeout_at(
            deadline,
            Arc::clone(&self.inner.concurrency_limit).acquire_owned(),
        )
        .await
        .map_err(|_| BusError::Timeout(timeout))?
        .map_err(|_| BusError::Closed)?;

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(BusError::Timeout(timeout));
        }

        let id = AskId(self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let (responder, receiver) = oneshot::channel();

        let should_emit = {
            let buffer = self
                .inner
                .buffer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.inner
                .in_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(
                    id,
                    PendingAsk {
                        event: R::EVENT_NAME,
                        payload: payload.clone(),
                        deadline,
                        responder,
                        _permit: permit,
                    },
                );
            buffer.ready
        };

        let _guard = PendingAskGuard {
            bus: self.clone(),
            id,
        };

        // A frontend that is not listening yet receives this ask from
        // [`Bus::ready`] instead.
        if should_emit {
            let envelope = AskEnvelope {
                id,
                timeout_ms: remaining.as_millis().try_into().unwrap_or(u64::MAX),
                payload,
            };
            self.inner
                .emitter
                .emit(R::EVENT_NAME, &serde_json::to_value(&envelope)?)?;
        }

        match tokio::time::timeout_at(deadline, receiver).await {
            Ok(Ok(Answer::Resolved(value))) => Ok(serde_json::from_value(value)?),
            Ok(Ok(Answer::Rejected(reason))) => Err(BusError::Rejected(reason)),
            Ok(Err(_)) => Err(BusError::Closed),
            Err(_) => Err(BusError::Timeout(timeout)),
        }
    }

    /// Delivers the frontend's [`Answer`].
    ///
    /// `false` means no ask waited under that id: it timed out, or it was already
    /// answered.
    pub fn answer(&self, id: AskId, answer: Answer) -> bool {
        let entry = self
            .inner
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);

        match entry {
            Some(entry) => entry.responder.send(answer).is_ok(),
            None => false,
        }
    }

    /// Sends a one-way [`Notification`].
    ///
    /// Before [`Bus::ready`] it is kept when
    /// [`Notification::BUFFER_UNTIL_READY`] is set, and dropped otherwise.
    pub fn notify<N: Notification>(&self, notification: N) -> Result<(), BusError> {
        let payload = serde_json::to_value(notification)?;

        {
            let mut buffer = self
                .inner
                .buffer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);

            if !buffer.ready {
                if N::BUFFER_UNTIL_READY {
                    buffer.queue.push_back(BufferedNotification {
                        event: N::EVENT_NAME,
                        payload,
                    });
                }
                return Ok(());
            }
        }

        self.inner.emitter.emit(N::EVENT_NAME, &payload)?;
        Ok(())
    }

    /// Marks the frontend as ready: flushes the kept notifications, then replays
    /// every ask that still waits with what is left of its budget.
    pub fn ready(&self) {
        let now = Instant::now();
        let mut envelopes = Vec::new();

        let notifications: Vec<BufferedNotification> = {
            let mut buffer = self
                .inner
                .buffer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            buffer.ready = true;

            let in_flight = self
                .inner
                .in_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            for (&id, entry) in in_flight.iter() {
                let remaining = entry.deadline.saturating_duration_since(now);
                if remaining.is_zero() {
                    continue;
                }
                envelopes.push((
                    entry.event,
                    AskEnvelope {
                        id,
                        timeout_ms: remaining.as_millis().try_into().unwrap_or(u64::MAX),
                        payload: entry.payload.clone(),
                    },
                ));
            }

            buffer.queue.drain(..).collect()
        };

        for item in notifications {
            if let Err(error) = self.inner.emitter.emit(item.event, &item.payload) {
                tracing::warn!(
                    event = item.event,
                    %error,
                    "failed to flush buffered notification"
                );
            }
        }

        for (event, envelope) in envelopes {
            let id = envelope.id;
            let payload = match serde_json::to_value(&envelope) {
                Ok(payload) => payload,
                Err(error) => {
                    tracing::warn!(event, id = %id, %error, "failed to replay an in-flight ask");
                    continue;
                }
            };
            if let Err(error) = self.inner.emitter.emit(event, &payload) {
                tracing::warn!(
                    event,
                    id = %id,
                    %error,
                    "failed to replay an in-flight ask"
                );
            }
        }
    }
}

/// Removes a [`PendingAsk`] when its future ends, whatever ended it.
struct PendingAskGuard {
    bus: Bus,
    id: AskId,
}

impl Drop for PendingAskGuard {
    fn drop(&mut self) {
        self.bus
            .inner
            .in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }
}

#[cfg(test)]
mod test_support {
    use std::sync::Arc;

    use tokio::sync::mpsc;

    use super::{Bus, Emitter, Value};

    impl Bus {
        /// A bus whose events go to a channel instead of a webview.
        pub(crate) fn recording(
            max_in_flight: usize,
        ) -> (Self, mpsc::UnboundedReceiver<(String, Value)>) {
            let (sender, receiver) = mpsc::unbounded_channel();
            let bus = Self::with_emitter(Arc::new(ChannelEmitter { sender }), max_in_flight);
            (bus, receiver)
        }
    }

    struct ChannelEmitter {
        sender: mpsc::UnboundedSender<(String, Value)>,
    }

    impl Emitter for ChannelEmitter {
        fn emit(&self, event: &str, payload: &Value) -> Result<(), tauri::Error> {
            let _ = self.sender.send((event.to_owned(), payload.clone()));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde::{Deserialize, Serialize};
    use serde_json::{Value, json};
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

    use super::*;

    /// How long a test waits for an event before it calls the bus stuck.
    const PATIENCE: Duration = Duration::from_secs(2);

    /// How long a test watches for an event that must not come.
    const SILENCE: Duration = Duration::from_millis(50);

    #[derive(Serialize)]
    struct Ping {
        value: u32,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct Pong {
        ok: bool,
    }

    impl Ask for Ping {
        type Answer = Pong;
        const EVENT_NAME: &'static str = "test/ask";
    }

    #[derive(Serialize)]
    struct Note {
        n: u32,
    }

    impl Notification for Note {
        const EVENT_NAME: &'static str = "test/note";
    }

    #[derive(Serialize)]
    struct Stream {
        n: u32,
    }

    impl Notification for Stream {
        const EVENT_NAME: &'static str = "test/stream";
        const BUFFER_UNTIL_READY: bool = false;
    }

    /// A bus and the events its frontend receives.
    struct Frontend {
        bus: Bus,
        events: mpsc::UnboundedReceiver<(String, Value)>,
    }

    impl Frontend {
        fn new(max_in_flight: usize) -> Self {
            let (bus, events) = Bus::recording(max_in_flight);
            Self { bus, events }
        }

        async fn next(&mut self, event: &str) -> Value {
            let (name, payload) = tokio::time::timeout(PATIENCE, self.events.recv())
                .await
                .expect("the event arrives in time")
                .expect("the event channel stays open");
            assert_eq!(name, event, "the event has the expected name");
            payload
        }

        async fn next_ask(&mut self) -> (AskId, u64, Value) {
            let payload = self.next(Ping::EVENT_NAME).await;
            let id = serde_json::from_value(payload["id"].clone()).expect("an ask id");
            let timeout_ms = payload["timeoutMs"]
                .as_u64()
                .expect("the remaining time is a number");
            (id, timeout_ms, payload["payload"].clone())
        }

        async fn silent(&mut self) {
            assert!(
                tokio::time::timeout(SILENCE, self.events.recv())
                    .await
                    .is_err(),
                "no event arrives"
            );
        }

        async fn wait_for_one_in_flight(&self) -> AskId {
            let deadline = tokio::time::Instant::now() + PATIENCE;
            loop {
                let id = self
                    .bus
                    .inner
                    .in_flight
                    .lock()
                    .expect("the in-flight map")
                    .keys()
                    .next()
                    .copied();
                if let Some(id) = id {
                    return id;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the ask is in flight"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    }

    fn ask(bus: &Bus, value: u32, timeout: Duration) -> JoinHandle<Result<Pong, BusError>> {
        let bus = bus.clone();
        tokio::spawn(async move { bus.ask(Ping { value }, timeout).await })
    }

    #[tokio::test]
    async fn a_ready_ask_reaches_the_frontend_and_its_answer_comes_back() {
        let mut frontend = Frontend::new(8);
        frontend.bus.ready();

        let asking = ask(&frontend.bus, 7, Duration::from_secs(5));
        let (id, timeout_ms, payload) = frontend.next_ask().await;

        assert!(timeout_ms > 0 && timeout_ms <= 5_000, "{timeout_ms}");
        assert_eq!(payload, json!({ "value": 7 }));

        assert!(
            frontend
                .bus
                .answer(id, Answer::Resolved(json!({ "ok": true })))
        );

        assert_eq!(
            asking
                .await
                .expect("the ask task lives")
                .expect("the ask is answered"),
            Pong { ok: true }
        );
    }

    #[tokio::test]
    async fn an_ask_before_ready_is_replayed_with_the_time_it_has_left() {
        let mut frontend = Frontend::new(8);
        let asking = ask(&frontend.bus, 1, Duration::from_secs(5));

        frontend.silent().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        frontend.bus.ready();

        let (id, timeout_ms, _) = frontend.next_ask().await;
        assert!(timeout_ms <= 4_900, "{timeout_ms}");

        assert!(
            frontend
                .bus
                .answer(id, Answer::Resolved(json!({ "ok": true })))
        );
        assert!(asking.await.expect("the ask task lives").is_ok());
    }

    #[tokio::test]
    async fn an_ask_answered_before_ready_is_not_replayed() {
        let mut frontend = Frontend::new(8);
        let asking = ask(&frontend.bus, 1, Duration::from_secs(5));

        let id = frontend.wait_for_one_in_flight().await;
        assert!(
            frontend
                .bus
                .answer(id, Answer::Resolved(json!({ "ok": true })))
        );

        frontend.bus.ready();
        frontend.silent().await;
        assert!(asking.await.expect("the ask task lives").is_ok());
    }

    #[tokio::test]
    async fn a_rejected_ask_carries_the_reason() {
        let mut frontend = Frontend::new(8);
        frontend.bus.ready();

        let asking = ask(&frontend.bus, 1, Duration::from_secs(5));
        let (id, _, _) = frontend.next_ask().await;
        assert!(
            frontend
                .bus
                .answer(id, Answer::Rejected("not now".to_owned()))
        );

        let error = asking
            .await
            .expect("the ask task lives")
            .expect_err("the ask is rejected");
        assert!(matches!(error, BusError::Rejected(ref reason) if reason == "not now"));
        assert!(error.to_string().contains("not now"), "{error}");
    }

    #[tokio::test]
    async fn an_answer_that_does_not_fit_the_ask_is_a_serialization_failure() {
        let mut frontend = Frontend::new(8);
        frontend.bus.ready();

        let asking = ask(&frontend.bus, 1, Duration::from_secs(5));
        let (id, _, _) = frontend.next_ask().await;
        assert!(
            frontend
                .bus
                .answer(id, Answer::Resolved(json!({ "ok": "yes" })))
        );

        let error = asking
            .await
            .expect("the ask task lives")
            .expect_err("the answer does not fit");
        assert!(matches!(error, BusError::Serialization(_)), "{error}");
    }

    #[tokio::test]
    async fn an_unanswered_ask_times_out_and_its_id_is_forgotten() {
        let mut frontend = Frontend::new(8);
        frontend.bus.ready();

        let asking = ask(&frontend.bus, 1, Duration::from_millis(50));
        let (id, _, _) = frontend.next_ask().await;

        let error = asking
            .await
            .expect("the ask task lives")
            .expect_err("the ask times out");
        assert!(
            matches!(error, BusError::Timeout(at) if at == Duration::from_millis(50)),
            "{error}"
        );
        assert!(
            !frontend
                .bus
                .answer(id, Answer::Resolved(json!({ "ok": true })))
        );
    }

    #[test]
    fn an_answer_for_an_unknown_id_is_refused() {
        let frontend = Frontend::new(8);

        assert!(
            !frontend
                .bus
                .answer(AskId(9_999), Answer::Resolved(json!({ "ok": true })))
        );
    }

    #[tokio::test]
    async fn the_second_ask_waits_for_a_slot_and_runs_when_the_first_is_answered() {
        let mut frontend = Frontend::new(1);
        frontend.bus.ready();

        let first = ask(&frontend.bus, 1, Duration::from_secs(5));
        let (first_id, _, _) = frontend.next_ask().await;

        let second = ask(&frontend.bus, 2, Duration::from_secs(5));
        frontend.silent().await;

        assert!(
            frontend
                .bus
                .answer(first_id, Answer::Resolved(json!({ "ok": true })))
        );
        let (second_id, _, payload) = frontend.next_ask().await;
        assert_eq!(payload, json!({ "value": 2 }));
        assert!(
            frontend
                .bus
                .answer(second_id, Answer::Resolved(json!({ "ok": false })))
        );

        assert_eq!(
            first
                .await
                .expect("the first task lives")
                .expect("the first is answered"),
            Pong { ok: true }
        );
        assert_eq!(
            second
                .await
                .expect("the second task lives")
                .expect("the second is answered"),
            Pong { ok: false }
        );
    }

    #[tokio::test]
    async fn an_ask_that_times_out_waiting_for_a_slot_never_reaches_the_frontend() {
        let mut frontend = Frontend::new(1);
        frontend.bus.ready();

        let first = ask(&frontend.bus, 1, Duration::from_secs(5));
        let (first_id, _, _) = frontend.next_ask().await;

        let second = ask(&frontend.bus, 2, Duration::from_millis(50));
        let error = second
            .await
            .expect("the second task lives")
            .expect_err("the second ask times out");
        assert!(
            matches!(error, BusError::Timeout(at) if at == Duration::from_millis(50)),
            "{error}"
        );

        frontend.silent().await;
        assert!(
            frontend
                .bus
                .answer(first_id, Answer::Resolved(json!({ "ok": true })))
        );
        assert!(first.await.expect("the first task lives").is_ok());
    }

    #[tokio::test]
    async fn a_zero_limit_still_runs_one_ask() {
        let mut frontend = Frontend::new(0);
        frontend.bus.ready();

        let asking = ask(&frontend.bus, 1, Duration::from_secs(5));
        let (id, _, _) = frontend.next_ask().await;
        assert!(
            frontend
                .bus
                .answer(id, Answer::Resolved(json!({ "ok": true })))
        );
        assert!(asking.await.expect("the ask task lives").is_ok());
    }

    #[tokio::test]
    async fn a_dropped_ask_frees_its_slot() {
        let mut frontend = Frontend::new(1);
        frontend.bus.ready();

        let first = ask(&frontend.bus, 1, Duration::from_secs(5));
        let (first_id, _, _) = frontend.next_ask().await;

        let second = ask(&frontend.bus, 2, Duration::from_secs(5));
        frontend.silent().await;

        first.abort();
        assert!(first.await.is_err(), "the first task is cancelled");

        let (second_id, _, _) = frontend.next_ask().await;
        assert!(
            !frontend
                .bus
                .answer(first_id, Answer::Resolved(json!({ "ok": true })))
        );
        assert!(
            frontend
                .bus
                .answer(second_id, Answer::Resolved(json!({ "ok": true })))
        );
        assert!(second.await.expect("the second task lives").is_ok());
    }

    #[tokio::test]
    async fn notifications_before_ready_are_kept_in_order_and_flushed_once() {
        let mut frontend = Frontend::new(8);
        frontend.bus.notify(Note { n: 1 }).expect("a note is kept");
        frontend.bus.notify(Note { n: 2 }).expect("a note is kept");
        frontend.silent().await;

        frontend.bus.ready();

        assert_eq!(frontend.next(Note::EVENT_NAME).await, json!({ "n": 1 }));
        assert_eq!(frontend.next(Note::EVENT_NAME).await, json!({ "n": 2 }));
        frontend.silent().await;
    }

    #[tokio::test]
    async fn a_streaming_notification_is_dropped_before_ready_and_emitted_after() {
        let mut frontend = Frontend::new(8);
        frontend
            .bus
            .notify(Stream { n: 1 })
            .expect("a stream note is dropped");
        frontend.silent().await;

        frontend.bus.ready();
        frontend
            .bus
            .notify(Stream { n: 2 })
            .expect("a stream note leaves");

        assert_eq!(frontend.next(Stream::EVENT_NAME).await, json!({ "n": 2 }));
        frontend.silent().await;
    }

    #[test]
    fn an_ask_id_and_its_envelope_keep_the_wire_shape() {
        assert_eq!(serde_json::to_value(AskId(7)).expect("an id"), json!(7));
        assert_eq!(AskId(7).to_string(), "ask-7");
        assert_eq!(
            serde_json::from_value::<AskId>(json!(7)).expect("an id"),
            AskId(7)
        );

        let envelope = AskEnvelope {
            id: AskId(3),
            timeout_ms: 1_500,
            payload: json!({ "a": 1 }),
        };
        assert_eq!(
            serde_json::to_value(&envelope).expect("an envelope"),
            json!({ "id": 3, "timeoutMs": 1_500, "payload": { "a": 1 } })
        );

        assert!(matches!(
            serde_json::from_value::<Answer>(json!({ "status": "resolved", "data": { "ok": true } }))
                .expect("an answer"),
            Answer::Resolved(ref value) if value == &json!({ "ok": true })
        ));
        assert!(matches!(
            serde_json::from_value::<Answer>(json!({ "status": "rejected", "data": "why" }))
                .expect("an answer"),
            Answer::Rejected(ref reason) if reason == "why"
        ));
    }
}
