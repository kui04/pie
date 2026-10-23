//! One connected host, and the sessions that run on it.

use crate::host::{Endpoint, Host};
use crate::session::{Id, Session, SessionInfo, SessionManager};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

/// What the frontend receives after a connection is ready.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    /// The name the frontend gave this connection.
    pub id: Id,
    /// `local`, or `user@host:port`.
    pub endpoint: Endpoint,
    /// The sessions that operate on the machine.
    pub sessions: Vec<SessionInfo>,
    /// Whether the reach to the machine is still open.
    pub open: bool,
}

/// One connected host: its reach, and the pi sessions that run on it.
#[derive(Debug)]
pub struct HostRuntime {
    id: Id,
    host: Arc<Host>,
    sessions: SessionManager,
    connect_lock: AsyncMutex<()>,
}

impl HostRuntime {
    /// Builds the runtime of `host` under the connection name `id`.
    pub fn new(id: Id, host: Arc<Host>) -> Self {
        let sessions = SessionManager::new(id.clone(), Arc::clone(&host));
        Self {
            id,
            host,
            sessions,
            connect_lock: AsyncMutex::new(()),
        }
    }

    /// The name the frontend gave this connection.
    pub fn id(&self) -> &Id {
        &self.id
    }

    /// The machine these sessions run on.
    pub fn host(&self) -> &Arc<Host> {
        &self.host
    }

    /// The sessions of this machine.
    pub fn sessions(&self) -> &SessionManager {
        &self.sessions
    }

    /// Whether the reach to the machine is still open.
    pub fn is_open(&self) -> bool {
        self.host.is_open()
    }

    /// The label of this machine: `local`, or `user@host:port`.
    pub fn endpoint(&self) -> Endpoint {
        self.host.endpoint()
    }

    /// What the frontend is told about this connection.
    pub fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            id: self.id.clone(),
            endpoint: self.host.endpoint(),
            sessions: self.sessions.sessions().iter().map(Session::info).collect(),
            open: self.host.is_open(),
        }
    }

    /// Reaches the machine and verifies that `pi` runs on it.
    ///
    /// # Errors
    ///
    /// Every failure [`Host::connect`] reports.
    pub async fn connect(&self) -> anyhow::Result<()> {
        let _guard = self.connect_lock.lock().await;
        self.host.connect().await?;
        tracing::info!(connection = %self.id, endpoint = %self.host.endpoint(), "connected");
        Ok(())
    }

    /// Dials the same machine again, after its reach ended.
    ///
    /// The sessions of the old reach stop first: a pi process cannot outlive the
    /// connection that carries it. The catalog is cleared because the files it
    /// listed belong to the old reach.
    ///
    /// # Errors
    ///
    /// Every failure [`Host::connect`] reports.
    pub async fn reconnect(&self) -> anyhow::Result<()> {
        let _guard = self.connect_lock.lock().await;
        self.sessions.detach_all().await;
        self.sessions.clear_catalog();
        self.host.connect().await?;
        tracing::info!(connection = %self.id, endpoint = %self.host.endpoint(), "connected");
        Ok(())
    }

    /// Ends every session, and then the reach to the machine.
    pub async fn close(&self) {
        let _guard = self.connect_lock.lock().await;
        self.sessions.detach_all().await;
        self.sessions.clear_catalog();
        self.host.close().await;
    }
}
