//! The sessions of one machine, and the dialogs they ask.

mod extension;
pub(crate) mod store;

use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};

pub use extension::{ExtensionAnswer, ExtensionAsk};
use pi_rpc::client::Client;
use pi_rpc::error::ErrorKind;
use pi_rpc::event::Event;
pub use store::{SessionInfo, SessionTitle};
use tokio::sync::Mutex;
use typed_path::Utf8TypedPathBuf;

use crate::bus::{Bus, Notification};
use crate::channel::{ExitStatus, Handle, Process};
use crate::state::HostId;

/// One conversation id. pi creates it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for SessionId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// One entry of a conversation. A fork starts from one of them.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct SessionEntryId(String);

impl SessionEntryId {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for SessionEntryId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// One event of pi's own stream, as pi sent it.
///
/// Two machines can hold the same conversation path, so the connection name
/// travels beside the file: the frontend keys a transcript on both.
#[derive(Debug, Clone)]
pub struct SessionEvent {
    /// The connection that serves the conversation.
    pub host: HostId,
    /// The conversation file, as the session is registered under it.
    pub session: Utf8TypedPathBuf,
    /// pi's event, mirrored by the protocol crate.
    pub event: Event,
}

impl serde::Serialize for SessionEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct as _;

        let mut state = serializer.serialize_struct("SessionEvent", 3)?;
        state.serialize_field("host", &self.host)?;
        state.serialize_field("session", &self.session)?;

        // `Event`'s derived `Serialize` renames the tag of an event this pie does
        // not know yet. `encode_event_value` replays it verbatim, so a newer pi
        // keeps its unknown events readable without a pin bump.
        let event =
            pi_rpc::event::encode_event_value(&self.event).map_err(serde::ser::Error::custom)?;
        state.serialize_field("event", &event)?;
        state.end()
    }
}

impl Notification for SessionEvent {
    const EVENT_NAME: &'static str = "pi://session/event";

    // The stream is forwarded, never buffered or replayed: a delta queued while
    // the webview subscribes is stale by the time it reads it, so the frontend
    // owns what happens to an event it receives.
    const BUFFER_UNTIL_READY: bool = false;
}

/// The end of the pi process of one session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnded {
    /// The connection that served the conversation.
    pub host: HostId,
    /// The conversation file, as the session is registered under it.
    pub session: Utf8TypedPathBuf,
    /// The status pi exited with.
    pub status: ExitStatus,
}

impl Notification for SessionEnded {
    const EVENT_NAME: &'static str = "pi://session/ended";
}

/// One pi process, with the conversation it serves.
#[derive(Debug)]
pub struct Session {
    /// The conversation file. It names this session, so it never changes.
    path: Utf8TypedPathBuf,
    info: StdMutex<SessionInfo>,
    client: Client,
    process: Mutex<Process>,
}

impl Session {
    /// Wraps a started `pi --mode rpc` client and its underlying process handle.
    pub(crate) fn new(
        path: Utf8TypedPathBuf,
        info: SessionInfo,
        client: Client,
        process: Process,
    ) -> Self {
        Self {
            path,
            info: StdMutex::new(info),
            client,
            process: Mutex::new(process),
        }
    }

    /// Returns a clone of the RPC [`Client`] handle for issuing session commands.
    pub fn client(&self) -> Client {
        self.client.clone()
    }

    /// Returns a snapshot of this session's metadata.
    ///
    /// pi reports the file it opened; the file this session is registered under
    /// wins, so the snapshot always names the conversation it belongs to.
    pub fn info(&self) -> SessionInfo {
        let mut info = self
            .info
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        info.path = self.path.clone();
        info
    }

    /// Returns the conversation file of this session.
    pub fn path(&self) -> Utf8TypedPathBuf {
        self.path.clone()
    }

    /// Updates the cached metadata for this session (e.g. after rename or detach).
    pub fn set_info(&self, updated: SessionInfo) {
        *self.info.lock().unwrap_or_else(PoisonError::into_inner) = updated;
    }

    /// Install the dialog handler. Call it before the frontend learns the path.
    pub(crate) async fn install_extension(&self, host: HostId, bus: Bus) {
        let path = self.path();
        self.client
            .set_ui_handler(extension::Extension::new(bus, host, path))
            .await;
    }

    /// Forwards pi's events, and the end of its process, to the frontend.
    ///
    /// Runs once per session and stops with it: [`Session::shutdown`] closes the
    /// client first, which ends the stream this task reads.
    pub(crate) fn pump(self: &Arc<Self>, host: HostId, bus: Bus) {
        let this = Arc::clone(self);

        tokio::spawn(async move {
            let mut events = this.client().subscribe();

            loop {
                match events.recv().await {
                    Ok(event) => {
                        let notification = SessionEvent {
                            host: host.clone(),
                            session: this.path(),
                            event: (*event).clone(),
                        };
                        if let Err(error) = bus.notify(notification) {
                            tracing::warn!(%error, "a session event did not leave");
                        }
                    }
                    // A receiver that fell behind drops events but keeps reading, so
                    // the stream goes on. Ending here would hide everything after the
                    // one event that arrived too fast.
                    Err(error) if error.kind() == ErrorKind::Protocol => {
                        tracing::warn!(%error, "the events of a session fell behind");
                    }
                    Err(error) => {
                        tracing::debug!(%error, "the events of a session ended");
                        break;
                    }
                }
            }

            // The client drains pending records before it reports a close, so every
            // event of this run has left by now and pi has ended or is ending.
            let status = match this.process.lock().await.wait().await {
                Ok(status) => status,
                Err(error) => {
                    tracing::warn!(%error, "the end of a session could not be read");
                    ExitStatus::Unknown
                }
            };

            let ended = SessionEnded {
                host,
                session: this.path(),
                status,
            };
            if let Err(error) = bus.notify(ended) {
                tracing::warn!(%error, "the end of a session did not leave");
            }
        });
    }

    /// Ends the session at the end of its standard input, and waits for pi to exit.
    pub(crate) async fn shutdown(&self) -> anyhow::Result<ExitStatus> {
        self.client.close().await?;
        self.process.lock().await.wait().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::executor::OsFamily;
    use crate::host::fs::typed;

    fn file() -> Utf8TypedPathBuf {
        typed("/home/u/.pi/agent/sessions/a.jsonl", OsFamily::Unix)
    }

    #[test]
    fn a_session_event_names_its_host_its_file_and_pis_own_event() {
        let event = SessionEvent {
            host: HostId::new("laptop"),
            session: file(),
            event: Event::AgentStart,
        };

        let wire = serde_json::to_value(&event).expect("a session event serializes");

        assert_eq!(wire["host"], "laptop");
        assert_eq!(wire["session"], "/home/u/.pi/agent/sessions/a.jsonl");
        assert_eq!(wire["event"]["type"], "agent_start");
    }

    #[test]
    fn an_unknown_event_keeps_the_tag_pi_sent() {
        let event = SessionEvent {
            host: HostId::new("laptop"),
            session: file(),
            event: Event::Unknown(pi_rpc::types::RawRecord::new(
                "type",
                serde_json::json!({ "type": "brand_new_event", "count": 2 }),
            )),
        };

        let wire = serde_json::to_value(&event).expect("a session event serializes");

        assert_eq!(
            wire["event"],
            serde_json::json!({ "type": "brand_new_event", "count": 2 })
        );
    }

    #[test]
    fn a_session_end_carries_the_status_as_a_tagged_union() {
        let ended = SessionEnded {
            host: HostId::new("laptop"),
            session: file(),
            status: ExitStatus::exited(1),
        };

        let wire = serde_json::to_value(&ended).expect("a session end serializes");

        assert_eq!(wire["host"], "laptop");
        assert_eq!(wire["status"]["type"], "exited");
        assert_eq!(wire["status"]["code"], 1);
    }
}
