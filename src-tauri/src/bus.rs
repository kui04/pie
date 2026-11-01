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
use tauri::{AppHandle, Emitter};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio::time::Instant;

/// Names one ask, so its [`Answer`] finds it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AskId(u64);

impl AskId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
}

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
    app: AppHandle,
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
        Self {
            inner: Arc::new(Inner {
                app,
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

        let _guard = PendingAskGuard {
            bus: self.clone(),
            id,
        };

        // A frontend that is not listening yet receives this ask from
        // [`Bus::ready`] instead.
        if self.is_ready() {
            let envelope = AskEnvelope {
                id,
                timeout_ms: remaining.as_millis().try_into().unwrap_or(u64::MAX),
                payload,
            };
            self.inner.app.emit(R::EVENT_NAME, &envelope)?;
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

        self.inner.app.emit(N::EVENT_NAME, payload)?;
        Ok(())
    }

    /// Marks the frontend as ready: flushes the kept notifications, then replays
    /// every ask that still waits with what is left of its budget.
    pub fn ready(&self) {
        let notifications: Vec<BufferedNotification> = {
            let mut buffer = self
                .inner
                .buffer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            buffer.ready = true;
            buffer.queue.drain(..).collect()
        };

        for item in notifications {
            if let Err(error) = self.inner.app.emit(item.event, item.payload) {
                tracing::warn!(
                    event = item.event,
                    %error,
                    "failed to flush buffered notification"
                );
            }
        }

        let now = Instant::now();
        let mut envelopes = Vec::new();

        {
            let mut in_flight = self
                .inner
                .in_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);

            in_flight.retain(|&id, entry| {
                let remaining = entry.deadline.saturating_duration_since(now);
                if remaining.is_zero() {
                    return false;
                }
                envelopes.push((
                    entry.event,
                    AskEnvelope {
                        id,
                        timeout_ms: remaining.as_millis().try_into().unwrap_or(u64::MAX),
                        payload: entry.payload.clone(),
                    },
                ));
                true
            });
        }

        for (event, envelope) in envelopes {
            let id = envelope.id;
            if let Err(error) = self.inner.app.emit(event, envelope) {
                tracing::warn!(
                    event,
                    id = %id,
                    %error,
                    "failed to replay an in-flight ask"
                );
            }
        }
    }

    fn is_ready(&self) -> bool {
        self.inner
            .buffer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .ready
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
