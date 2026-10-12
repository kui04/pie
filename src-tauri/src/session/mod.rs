//! The sessions of one machine: the pi processes that run on it, and the
//! conversations they write.
//!
//! Two things are called a session here, and they are not the same:
//!
//! - a **process session** is one `pi --mode rpc` that pie started. Its id
//!   (`main:1`) is pie's own, and it is the name of the events of that session.
//!   It lives as long as the process does, and [`SessionManager::close`] ends it.
//! - a **conversation file** is a session of pi: the JSONL file it appends to,
//!   with an id of its own. One process moves between them without restarting
//!   ([`Session::switch_session`]), and they outlive the process - a disconnect
//!   stops pi, and the files stay where pi wrote them.
//!
//! [`SessionManager`] is the app's one handle to both. It owns the [`Host`] it
//! reached, because the two live and die together, and it owns the pi processes
//! that run there. It stays free of Tauri, so the full path can be tested against
//! a real machine with no UI in the way.
//!
//! A connection and a session start apart, and the frontend decides each:
//! [`SessionManager::connect`] reaches the machine and reads what it holds, and
//! [`SessionManager::attach`] starts one pi on it. Therefore a screen that only
//! lists conversations runs no pi, and one that is done speaking ends just that
//! pi with [`SessionManager::detach`].

mod error;
mod id;
mod process;
mod store;
mod wire;

pub use error::Error;
pub use id::Id;
pub use process::Session;
pub use store::SessionSummary;
pub use wire::{
    AvailableModelsData, AvailableThinkingLevelsData, CommandsData, LastAssistantTextData, PromptData, QueuedInputData,
};

use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;

use crate::error::PieError;
use crate::host::{Host, HostPath, Options, Spec};

use process::speaking;
use store::SessionStore;

/// The sessions of one machine, and the reach to it.
#[derive(Clone)]
pub struct SessionManager {
    inner: Arc<Inner>,
}

struct Inner {
    /// The name the frontend gave this connection, and the stem of the ids of
    /// its sessions.
    id: Id,
    /// The machine. It stays here: a session cannot outlive the reach that runs
    /// it, and nothing outside this module reaches a machine on its own.
    host: Host,
    /// The reader of the conversation files on that machine. One host, one
    /// store: it is built with the host and kept, because the root of pi's
    /// sessions is resolved once per connection, not once per drawer.
    store: SessionStore,
    /// The pi processes of this connection.
    ///
    /// The product keeps one session per connection today, and the list is a
    /// list because that is what a session manager is for. A change to it is
    /// short and never waits, which is why the lock is a plain one: it is held
    /// to move a value in or out of the list, never across an await.
    live: Mutex<Vec<Session>>,
}

impl std::fmt::Debug for SessionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionManager")
            .field("id", &self.inner.id)
            .field("host", &self.inner.host)
            .field("sessions", &self.inner.live.lock().map(|live| live.len()).unwrap_or(0))
            .finish_non_exhaustive()
    }
}

impl SessionManager {
    /// Reaches a machine, and reads what it holds.
    ///
    /// No pi starts here. A connection is the machine: the reach to it, the
    /// conversations it holds, and the directories that a picker reads. A pi
    /// process is a session, and the frontend starts one with [`SessionManager::attach`]
    /// when it needs to speak. Therefore a screen that only lists conversations
    /// runs no pi at all.
    ///
    /// A host that pie reaches over SSH can wait here for a person: an unknown
    /// host key goes to the frontend, and the answer arrives through a command
    /// while this call is pending.
    ///
    /// # Errors
    ///
    /// [`PieError::Host`] when the machine cannot be reached, its credentials are
    /// refused, its host key is not trusted, or it has no `pi` for pie to speak
    /// to, and [`PieError::Session`] when the name cannot be used.
    pub async fn connect(id: Id, spec: &Spec, options: &Options) -> Result<Self, PieError> {
        let host = Host::connect(spec, options).await?;
        let store = SessionStore::of(&host);

        tracing::info!(connection = %id, endpoint = %host.endpoint(), "connected");
        Ok(Self {
            inner: Arc::new(Inner {
                id,
                host,
                store,
                live: Mutex::new(Vec::new()),
            }),
        })
    }

    /// Starts one pi on this machine, and answers with the session it speaks
    /// through.
    ///
    /// `number` is the count that names this pi process for the whole run of
    /// pie: the id of the session is this connection and that number
    /// (`main:1`). One connection can start several, one after the other.
    ///
    /// Pi starts where the machine says: the home directory of this machine, or
    /// the directory of the login shell on a host. [`SessionInfo::cwd`] is the
    /// label of that choice, not the value pi is given: pi is started with the
    /// machine's own default, so no path of this machine is turned into text on
    /// the way to it.
    ///
    /// # Errors
    ///
    /// [`PieError::Channel`] when pi cannot be started, and
    /// [`PieError::Host`] when the channel it runs in cannot be opened.
    pub async fn attach(&self, number: u64) -> Result<Session, PieError> {
        let cwd = self.inner.host.home().map(HostPath::of_local);
        let channel = self.inner.host.open_pi(None).await?;
        let (client, handle) = speaking(channel);
        let session = Session::new(self.inner.id.for_session(number), cwd, client, handle);

        tracing::info!(connection = %self.inner.id, session = %session.id(), "attached");
        self.inner
            .live
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(session.clone());
        Ok(session)
    }

    /// Ends one session: pi winds down, and the process is waited for.
    ///
    /// Closing says "we are leaving": pi's standard input ends, it disposes the
    /// session, and the client keeps reading until its output does. The deadline
    /// is the client's own (`SHUTDOWN_GRACE`), so a close that reports a failure
    /// is a pi that did not go - and a kill is what is left.
    ///
    /// The machine stays reached, and the conversation file of pi stays where it
    /// is: a detach closes a process, it does not delete a conversation. The
    /// caller that wants to speak again attaches a new session.
    ///
    /// # Errors
    ///
    /// [`crate::session::Error::UnknownSession`] when this connection has no such
    /// session.
    pub async fn detach(&self, id: &str) -> Result<(), PieError> {
        let session = self
            .session(id)
            .ok_or_else(|| crate::session::Error::UnknownSession { id: id.to_string() })?;
        if session.client().close().await.is_err() {
            tracing::warn!(session = %session.id(), "pi did not exit in time; killing it");
            session.handle().terminate().await;
        }
        session.handle().wait().await;
        let mut live = self.inner.live.lock().unwrap_or_else(PoisonError::into_inner);
        live.retain(|held| held.id() != session.id());
        tracing::info!(connection = %self.inner.id, session = %session.id(), "detached");
        Ok(())
    }

    /// The name the frontend gave this connection.
    pub fn id(&self) -> &Id {
        &self.inner.id
    }

    /// The machine these sessions run on.
    pub fn host(&self) -> &Host {
        &self.inner.host
    }

    /// The sessions that run on this machine.
    ///
    /// The answer is a copy: each value is a hand on the same pi process, not a
    /// session of its own.
    pub fn sessions(&self) -> Vec<Session> {
        self.inner.live.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The session with this id, if this connection has one.
    ///
    /// The id is the one that [`SessionInfo`] carries, which is pie's own id for
    /// the process. It is not the session id of pi, which is the id of the
    /// session file. A name that matches nothing is not an error here: the caller
    /// names the mistake, because the caller knows what it asked for.
    pub fn session(&self, id: &str) -> Option<Session> {
        self.sessions().into_iter().find(|session| session.id().as_str() == id)
    }

    /// Whether pi still operates behind at least one session.
    ///
    /// A connection does not end when its process dies: nothing watches for that
    /// event yet. Therefore this tells a live connection from a connection with a
    /// dead host.
    pub fn is_alive(&self) -> bool {
        self.sessions().iter().any(|session| session.handle().is_alive())
    }

    /// What the frontend is told about this connection.
    pub fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            id: self.inner.id.clone(),
            endpoint: self.inner.host.endpoint(),
            sessions: self.sessions().iter().map(Session::info).collect(),
        }
    }

    /// Every conversation that pi wrote on this machine, in all project
    /// directories.
    ///
    /// This is the listing of the session drawer: the conversation files of pi,
    /// not the processes pie runs. A session that has said nothing yet has no
    /// file, and therefore no row: pi writes one at the start of the first turn.
    /// Which machine it is decides how the files are read, and nothing else: the
    /// layout belongs to pi and is the same on both.
    ///
    /// # Errors
    ///
    /// [`PieError::Host`] when the files cannot be read, with the path at fault
    /// in the message.
    pub async fn summaries(&self) -> Result<Vec<SessionSummary>, PieError> {
        self.inner.store.summaries().await
    }

    /// Ends every session of this machine, and then the reach to it.
    ///
    /// Each session goes the way a [`SessionManager::detach`] ends it. The
    /// conversation files stay where pi wrote them. Therefore a disconnect is
    /// different from a delete of a session. The method takes `&self` on
    /// purpose: the slot gives shared hands to this connection, and the listings
    /// operate on them. The end of the connection must not need to own the last
    /// hand.
    pub async fn close(&self) {
        for session in self.sessions() {
            // The failure of one detach is not a reason to spare the next: every
            // pi of this connection stops.
            if let Err(error) = self.detach(session.id().as_str()).await {
                tracing::warn!(session = %session.id(), %error, "a detach of a closing connection did not finish");
            }
        }
        self.inner.host.close().await;
    }
}

/// What the frontend receives after a connection is ready.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    /// The name the frontend gave this connection.
    pub id: Id,
    /// `local`, or `user@host:port`.
    pub endpoint: crate::host::Endpoint,
    /// The sessions that operate on the machine.
    pub sessions: Vec<SessionInfo>,
}

/// What the frontend receives about one session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// The id of this session, for the `pi://session/{id}/...` events.
    pub id: Id,
    /// The start of pi, if pie selected it.
    pub cwd: Option<HostPath>,
}
