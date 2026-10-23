//! The sessions of one machine: the pi processes that run on it, and the
//! conversations they write.
//!
//! Two things are called a session here, and they are not the same:
//!
//! - a **process session** is one `pi --mode rpc` that pie started. Its id
//!   (`main:1`) is pie's own, and it is the name of the events of that session.
//!   It lives as long as the process does, and [`SessionManager::detach`] ends it.
//! - a **conversation file** is a session of pi: the JSONL file it appends to,
//!   with an id of its own. One process holds the one it was attached on, until
//!   pi itself forks or clones the conversation (`fork`, `clone`); the files
//!   outlive the process - a disconnect stops pi, and the files stay where pi
//!   wrote them.
//!
//! [`SessionManager`] is the app's one handle to both. It holds the [`Host`] and
//! the pi processes that run there; the reach and its lifecycle belong to
//! [`HostRuntime`](crate::runtime::HostRuntime). It stays free of Tauri, so the
//! full path can be tested against a real machine with no UI in the way.
//!
//! A connection and a session start apart, and the frontend decides each:
//! [`HostRuntime::connect`](crate::runtime::HostRuntime::connect) reaches the
//! machine and reads what it holds, and [`SessionManager::attach`] starts one pi
//! on it. Therefore a screen that only lists conversations runs no pi, and one
//! that is done speaking ends just that pi with [`SessionManager::detach`].

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
    host: Arc<Host>,
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
    /// Builds the sessions of one machine, with its reach already held.
    ///
    /// The caller owns the reach and its lifecycle; this manager owns only the
    /// pi processes and the conversation catalog of that machine.
    pub fn new(id: Id, host: Arc<Host>) -> Self {
        Self {
            inner: Arc::new(Inner {
                id,
                host,
                live: Mutex::new(Vec::new()),
                catalog: Mutex::new(SessionCatalog::default()),
            }),
        }
    }

    /// Starts one pi on this machine, and answers with the session it speaks
    /// through.
    ///
    /// `number` is the count that names this pi process for the whole run of
    /// pie: the id of the session is this connection and that number
    /// (`main:1`). One connection can start several, one after the other.
    ///
    /// `current_dir` is the directory pi starts in, when pie selected one. `None`
    /// leaves the choice to the machine: the home directory here, or the
    /// directory of the login shell on a host. [`SessionInfo::cwd`] reports
    /// which of the two happened - the selected directory, or the home of this
    /// machine - so a screen can name the session when pi has no name for it.
    ///
    /// `session_file` names the file of pi to load at the start (`--session`), a
    /// host path that pi reads itself. `None` starts a new session file; pi
    /// creates the file at the first message. Pi takes the working directory of
    /// a loaded session file from the file itself, so `current_dir` is for a new
    /// session file alone; the two are separate entry points of the IPC surface
    /// (`attach_session` and `start_session`), and neither can be given both.
    ///
    /// # Errors
    ///
    /// A sentence for a session file path or a directory that is not absolute: pi
    /// would resolve a relative one against its own directory and quietly open
    /// another session file or another directory there. A sentence when pi
    /// cannot be started, and one when the channel it runs in cannot be opened.
    pub async fn attach(
        &self,
        number: u64,
        session_file: Option<&str>,
        current_dir: Option<&str>,
    ) -> anyhow::Result<Session> {
        let current_dir = match current_dir {
            Some(dir) => dir.to_string(),
            None => {
                if let Some(path) = session_file {
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
                            let mut reader = self.inner.host.files().open(path).await?;
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
        let (channel, label) = self.inner.host.spawn_pi(&current_dir, session_file).await?;
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

    /// Ends every session of this machine. The reach stays open.
    ///
    /// The failure of one detach is not a reason to spare the next: every pi of
    /// this machine stops.
    pub async fn detach_all(&self) {
        for session in self.sessions() {
            if let Err(error) = self.detach(session.id().as_str()).await {
                tracing::warn!(session = %session.id(), %error, "a detach of a closing connection did not finish");
            }
        }
    }

    /// The name the frontend gave this connection.
    pub fn id(&self) -> &Id {
        &self.inner.id
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

    /// Every conversation that pi wrote on this machine, in all project
    /// directories.
    ///
    /// This is the listing of the session drawer: the conversation files of pi,
    /// not the processes pie runs. A session that has said nothing yet has no
    /// file, and therefore no row: pi writes one at the start of the first turn.
    /// If the catalog is empty, scans the host filesystem and populates it.
    ///
    /// # Errors
    ///
    /// A sentence when the files cannot be read, with the path at fault in it.
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
        let list = store::summaries(self.inner.host.files_arc()).await?;
        let mut cat = self.inner.catalog.lock().unwrap_or_else(PoisonError::into_inner);
        cat.set(list.clone());
        Ok(list)
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
        self.inner.host.files().remove_file(path).await?;
        let mut cat = self.inner.catalog.lock().unwrap_or_else(PoisonError::into_inner);
        cat.remove_by_path(path);
        Ok(())
    }

    /// Drops the remembered session files, so the next listing reads the
    /// machine again.
    pub fn clear_catalog(&self) {
        self.inner
            .catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
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
