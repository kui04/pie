//! The sessions of one machine: the pi processes that run on it, and the
//! conversations they write.
//!
//! Two things are called a session here, and they are not the same:
//!
//! - a **process session** is one `pi --mode rpc` that pie started. Its id
//!   (`main:1`) is pie's own, and it is the name of the events of that session.
//!   It lives as long as the process does, and [`SessionManager::close`] ends it.
//! - a **conversation file** is a session of pi: the JSONL file it appends to,
//!   with an id of its own. One process holds the one it was attached on, until
//!   pi itself forks or clones the conversation (`fork`, `clone`); the files
//!   outlive the process - a disconnect stops pi, and the files stay where pi
//!   wrote them.
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

mod extension;
mod id;
mod process;
pub(crate) mod store;
mod wire;

#[doc(inline)]
pub use extension::{
    EditorTextUpdate, ExtensionAnswer, ExtensionEvent, ExtensionRequest, ExtensionState, ExtensionStatus,
};
pub use id::Id;
pub use process::Session;
pub use store::{SessionCatalog, SessionSummary};
pub use wire::{
    AvailableModelsData, AvailableThinkingLevelsData, CommandsData, LastAssistantTextData, PromptData, QueuedInputData,
};

use std::sync::{Arc, Mutex, PoisonError};

use anyhow::Context as _;
use serde::Serialize;

use crate::host::Host;

use process::speaking;
use store::checked_session_path;

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
    host: Arc<dyn Host>,
    /// The pi processes of this connection.
    ///
    /// The product keeps one session per connection today, and the list is a
    /// list because that is what a session manager is for. A change to it is
    /// short and never waits, which is why the lock is a plain one: it is held
    /// to move a value in or out of the list, never across an await.
    live: Mutex<Vec<Session>>,
    /// In-memory catalog of all session summaries on this machine.
    catalog: Mutex<SessionCatalog>,
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
    /// A sentence when the machine cannot be reached, its credentials are
    /// refused, its host key is not trusted, or it has no `pi` for pie to speak
    /// to.
    pub async fn connect(id: Id, host: Arc<dyn Host>) -> anyhow::Result<Self> {
        host.connect().await?;

        tracing::info!(connection = %id, endpoint = %host.endpoint(), "connected");
        Ok(Self {
            inner: Arc::new(Inner {
                id,
                host,
                live: Mutex::new(Vec::new()),
                catalog: Mutex::new(SessionCatalog::default()),
            }),
        })
    }

    /// Dials the same machine again after its reach ended, and returns a new
    /// manager holding the restored reach.
    ///
    /// # Errors
    ///
    /// Every failure [`SessionManager::connect`] reports. When the dial fails,
    /// this manager is left untouched so a later retry can dial again.
    pub async fn reconnect(&self) -> anyhow::Result<Self> {
        self.inner.host.connect().await?;
        for session in self.sessions() {
            if let Err(error) = self.detach(session.id().as_str()).await {
                tracing::warn!(session = %session.id(), %error, "a detach of an ended connection did not finish");
            }
        }
        tracing::info!(connection = %self.inner.id, endpoint = %self.inner.host.endpoint(), "connected");
        Ok(Self {
            inner: Arc::new(Inner {
                id: self.inner.id.clone(),
                host: Arc::clone(&self.inner.host),
                live: Mutex::new(Vec::new()),
                catalog: Mutex::new(SessionCatalog::default()),
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
    /// `cwd` is the directory pi starts in, when pie selected one. `None`
    /// leaves the choice to the machine: the home directory here, or the
    /// directory of the login shell on a host. [`SessionInfo::cwd`] reports
    /// which of the two happened - the selected directory, or the home of this
    /// machine - so a screen can name the session when pi has no name for it.
    ///
    /// `conversation` names the file of pi to load at the start (`--session`), a
    /// host path that pi reads itself. `None` starts a new conversation; pi
    /// creates the file at the first message. Pi takes the working directory of
    /// a loaded conversation from the file itself, so `cwd` is for a new
    /// conversation alone; the two are separate entry points of the IPC surface
    /// (`attach_session` and `start_session`), and neither can be given both.
    ///
    /// # Errors
    ///
    /// A sentence for a conversation path or a directory that is not absolute: pi
    /// would resolve a relative one against its own directory and quietly open
    /// another conversation or another directory there. A sentence when pi
    /// cannot be started, and one when the channel it runs in cannot be opened.
    pub async fn attach(&self, number: u64, conversation: Option<&str>, cwd: Option<&str>) -> anyhow::Result<Session> {
        let conversation = conversation.map(checked_session_path).transpose()?;
        let cwd = match cwd {
            Some(dir) => crate::host::is_absolute_path(dir)?.to_string(),
            None => {
                if let Some(path) = conversation {
                    let from_catalog = self
                        .inner
                        .catalog
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .get_by_path(path)
                        .map(|s| s.cwd.clone());
                    match from_catalog {
                        Some(dir) => dir,
                        None => {
                            let mut reader = self.inner.host.open_file(path).await?;
                            store::read_session_cwd(&mut *reader)
                                .await?
                                .context("session file missing cwd header")?
                        }
                    }
                } else {
                    anyhow::bail!("missing cwd for session");
                }
            }
        };
        let (channel, label) = self.inner.host.open_pi(&cwd, conversation).await?;
        let (client, handle) = speaking(channel);
        let session = Session::new(self.inner.id.for_session(number), label, client, handle);
        session.extension().install(session.client()).await;

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
    /// A sentence when this connection has no such session.
    pub async fn detach(&self, id: &str) -> anyhow::Result<()> {
        let session = self
            .session(id)
            .ok_or_else(|| anyhow::anyhow!("this connection has no session `{id}`"))?;
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
    pub fn host(&self) -> &Arc<dyn Host> {
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
        let live = self.inner.live.lock().unwrap_or_else(PoisonError::into_inner);
        live.iter().find(|session| session.id().as_str() == id).cloned()
    }

    /// Whether pi still operates behind at least one session.
    ///
    /// A connection does not end when its process dies: nothing watches for that
    /// event yet. Therefore this tells a live connection from a connection with a
    /// dead host.
    pub fn is_alive(&self) -> bool {
        let live = self.inner.live.lock().unwrap_or_else(PoisonError::into_inner);
        live.iter().any(|session| session.handle().is_alive())
    }

    /// Whether the reach to the machine is still open.
    ///
    /// Every session of an ended reach stops with it, so this is the question to ask
    /// before speaking through any of them.
    pub fn is_open(&self) -> bool {
        self.inner.host.is_open()
    }

    /// Closes the reach to the machine, as a network that goes away does.
    ///
    /// A test affordance, and it exists in a debug build alone: a release has no code that can
    /// close a reach this way. It is here because the failure this app has to answer - a link that
    /// ends while no command is asking - cannot be produced on a device by cutting the network of
    /// an emulator or a container, and a path that cannot be reached cannot be tested. The
    /// connection stays pie's: the watch of it reports the end, and the credential for another dial
    /// is still in memory.
    #[cfg(debug_assertions)]
    pub async fn close_the_reach(&self) {
        self.inner.host.close().await;
    }

    /// Whether this is the same connection as another hand, not one that carries the
    /// same name.
    ///
    /// A task that watches a connection must not announce the end of one the app has
    /// already replaced.
    pub fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// What the frontend is told about this connection.
    pub fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            id: self.inner.id.clone(),
            endpoint: self.inner.host.endpoint(),
            sessions: self.sessions().iter().map(Session::info).collect(),
            open: self.is_open(),
        }
    }

    /// Returns all session summaries of this machine. If the catalog is empty,
    /// scans the host filesystem and populates it.
    pub async fn list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let is_empty = {
            let cat = self.inner.catalog.lock().unwrap_or_else(PoisonError::into_inner);
            cat.is_empty()
        };
        if is_empty {
            self.refresh_sessions().await
        } else {
            let cat = self.inner.catalog.lock().unwrap_or_else(PoisonError::into_inner);
            Ok(cat.all())
        }
    }

    /// Scans the machine for session files and refreshes the in-memory catalog.
    pub async fn refresh_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let list = store::summaries(&self.inner.host).await?;
        let mut cat = self.inner.catalog.lock().unwrap_or_else(PoisonError::into_inner);
        cat.set(list.clone());
        Ok(list)
    }

    /// Every conversation that pi wrote on this machine, in all project
    /// directories.
    ///
    /// This is the listing of the session drawer: the conversation files of pi,
    /// not the processes pie runs. A session that has said nothing yet has no
    /// file, and therefore no row: pi writes one at the start of the first turn.
    ///
    /// # Errors
    ///
    /// A sentence when the files cannot be read, with the path at fault in it.
    pub async fn summaries(&self) -> anyhow::Result<Vec<SessionSummary>> {
        self.list_sessions().await
    }

    /// Deletes one conversation file of this machine and removes it from the catalog.
    ///
    /// The file belongs to pi, and the process that holds it must be gone first:
    /// a pi that keeps writing to a removed file writes into a name nobody can open
    /// again. [`SessionManager::detach`] ends that process; the caller orders the
    /// two.
    ///
    /// # Errors
    ///
    /// A sentence for a path that is not absolute - pi would resolve a relative
    /// one against its own directory - and one when the file cannot be removed.
    pub async fn delete_conversation(&self, path: &str) -> anyhow::Result<()> {
        let path = checked_session_path(path)?;
        self.inner.host.remove_file(path).await?;
        let mut cat = self.inner.catalog.lock().unwrap_or_else(PoisonError::into_inner);
        cat.remove_by_path(path);
        Ok(())
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
    /// Whether the reach to the machine is still open.
    pub open: bool,
}

/// What the frontend receives about one session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// The id of this session, for the `pi://session/{id}/...` events.
    pub id: Id,
    /// The start of pi, if pie selected it.
    pub cwd: Option<String>,
}
