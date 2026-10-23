//! Opening, reading and closing the one machine, and its directories.
//!
//! `connect` is the only command that waits for a person. Pie cannot answer one
//! question itself: whether an unknown host key belongs to the host. The question
//! arrives as an event while this command is in progress. The answer comes back
//! through a separate command. Therefore the name of the connection is an
//! argument here and not a constant: the event uses that name, and the answer
//! must say which question it answers.
//!
//! `list_dirs` is here because a directory belongs to a machine, not to a
//! session: the picker asks the connected machine, and the session that starts
//! there reads the answer.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use camino::Utf8PathBuf;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::error::PieError;
use crate::host::{
    AskHostKey, ConnectionState, Host, KnownHosts, Listing, LocalHost, PresentedKey, SshAuth, SshHost, SshTarget, Trust,
};
use crate::session::{Id, SessionManager};
use crate::state::{AppState, HOST_KEY_PATIENCE, HostKeyQuestion};

/// How to reach a machine, as the connect screen sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum ConnectSpec {
    /// This machine.
    Local,
    /// A machine reached over SSH.
    Ssh {
        /// Hostname or IP address.
        host: String,
        /// Port; defaults to 22.
        #[serde(default)]
        port: Option<u16>,
        /// Login name.
        user: String,
        /// Credentials.
        auth: AuthSpec,
    },
}

/// Credentials for an SSH connection, as the connect screen sends them.
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthSpec {
    /// Password authentication.
    Password {
        /// The password.
        password: String,
    },
    /// Public-key authentication with the private key itself.
    Key {
        /// The private key, in the OpenSSH or PEM form a key file holds.
        key: String,
        /// Passphrase, when the key is encrypted.
        #[serde(default)]
        passphrase: Option<String>,
    },
}

impl fmt::Debug for AuthSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password { .. } => formatter
                .debug_struct("Password")
                .field("password", &"<redacted>")
                .finish(),
            Self::Key { key, passphrase } => formatter
                .debug_struct("Key")
                .field("bytes", &key.len())
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

impl From<AuthSpec> for SshAuth {
    fn from(auth: AuthSpec) -> Self {
        match auth {
            AuthSpec::Password { password } => Self::Password(password),
            AuthSpec::Key { key, passphrase } => Self::Key { key, passphrase },
        }
    }
}

/// The event of the connection for a state.
fn state_event(connection: &Id) -> String {
    format!("pi://connection/{connection}/state")
}

/// Puts host-key questions to the frontend.
///
/// Pie builds one for each connection. Therefore the question carries the name of
/// that connection. The answer comes back through [`trust_host_key`].
struct AskFrontend {
    app: AppHandle,
    question: Arc<HostKeyQuestion>,
    connection: Id,
}

impl AskHostKey for AskFrontend {
    fn ask(&self, presented: PresentedKey) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        // These values leave `self` before the future is boxed. The future
        // borrows `self`, not the values.
        let app = self.app.clone();
        let question = Arc::clone(&self.question);
        let connection = self.connection.clone();
        let event = state_event(&connection);

        Box::pin(async move {
            let (answer, decision) = oneshot::channel();
            question.open(&connection, answer);
            if let Err(error) = app.emit(&event, ConnectionState::HostKey { key: presented }) {
                tracing::warn!(%error, "the host-key question could not be delivered");
                question.close(&connection);
                return false;
            }
            wait_for_answer(decision, HOST_KEY_PATIENCE).await
        })
    }
}

/// The answer to a host-key question. An absent answer is a refusal.
///
/// The sender stays in the slot until an answer arrives or a new question
/// replaces it. Therefore the wait must end by itself. A frontend that went away
/// gives the same answer: no trust.
async fn wait_for_answer(decision: oneshot::Receiver<bool>, patience: Duration) -> bool {
    match tokio::time::timeout(patience, decision).await {
        Ok(Ok(trusted)) => trusted,
        Ok(Err(_gone)) => false,
        Err(_elapsed) => {
            tracing::info!(?patience, "nobody answered whether to trust this host key");
            false
        }
    }
}

/// Connects to a machine, and reads what it holds.
///
/// No pi starts here. The connection is the machine: the reach to it and the
/// conversation files on it. A session is a pi process, and the frontend starts
/// one with [`attach_session`](crate::commands::session::attach_session) when it
/// needs to speak. Therefore a screen that only lists conversations runs no pi.
///
/// The `id` is the name of this connection from the frontend. The events of this
/// connection use that name. The host-key question arrives before this command
/// returns.
///
/// # Errors
///
/// [`PieError::AlreadyConnected`] if a live connection is present, a sentence if
/// the name cannot go in an event, and the failure of the reach to the machine.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(connection = %id))]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    spec: ConnectSpec,
) -> Result<crate::session::ConnectionInfo, PieError> {
    let id = Id::new(&id)?;
    let mut slot = state.sessions.lock().await;
    if let Some(existing) = slot.take() {
        if existing.is_alive() {
            let endpoint = existing.host().endpoint().to_string();
            *slot = Some(existing);
            return Err(PieError::AlreadyConnected { endpoint });
        }
        // No pi of this connection runs, so nothing speaks through it. The
        // connection ended with no observer, and the slot must not keep the
        // machine it reached. A machine that was connected and never spoken to is
        // this case too: only a session makes a connection live.
        tracing::info!(connection = %existing.id(), "dropping a connection with no live session");
        existing.close().await;
    }

    let host = build_host(&app, &state, &id, spec)?;
    let sessions = SessionManager::connect(id.clone(), host).await?;
    let info = sessions.info();
    *slot = Some(sessions.clone());
    watching(&app, sessions, id);
    Ok(info)
}

/// Builds the [`Host`] implementation for `spec`.
fn build_host(app: &AppHandle, state: &AppState, id: &Id, spec: ConnectSpec) -> anyhow::Result<Arc<dyn Host>> {
    let home = app
        .path()
        .home_dir()
        .ok()
        .and_then(|h| Utf8PathBuf::from_path_buf(h).ok());
    match spec {
        ConnectSpec::Local => Ok(Arc::new(LocalHost::new(home))),
        ConnectSpec::Ssh { host, port, user, auth } => {
            let store = app
                .path()
                .app_data_dir()
                .with_context(|| "pie cannot resolve where to keep host keys")?
                .join("known_hosts");
            let trust = Trust::new(KnownHosts::new(
                store,
                home.map(|home| home.as_std_path().join(".ssh").join("known_hosts")),
                AskFrontend {
                    app: app.clone(),
                    question: Arc::clone(&state.question),
                    connection: id.clone(),
                },
            ));
            let mut target = SshTarget::new(host, user);
            if let Some(port) = port {
                target = target.port(port);
            }
            Ok(Arc::new(SshHost::new(target, auth.into(), trust)))
        }
    }
}

/// The one connection that pie holds now, or `null` when there is none.
///
/// The workspace reads the session it subscribes to from here. The machine that
/// opened the connection dies with the connect screen, so its answer cannot
/// outlive it, and Rust is the source of truth: a reload of the webview reads the
/// same connection instead of losing it.
///
/// A connection whose pi has exited is still the connection that pie holds. The
/// read of a session reports the end; this read does not guess it.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a claim
/// about today's code. A read of the slot has nothing to fail on yet.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn get_connection(state: State<'_, AppState>) -> Result<Option<crate::session::ConnectionInfo>, PieError> {
    Ok(current_connection(&state).await)
}

/// What the frontend is told about the one connection, if there is one.
async fn current_connection(state: &AppState) -> Option<crate::session::ConnectionInfo> {
    let slot = state.sessions.lock().await;
    slot.as_ref().map(|sessions| sessions.info())
}

/// Ends the connection. Every session stops. The files of the sessions stay.
///
/// A disconnect with no connection does nothing. Therefore a click that races the
/// end of the connection is not an error.
///
/// A `connect` in progress holds the connection slot. Therefore this command
/// waits behind it: the version probe, the full connect to the machine, and a
/// host-key question, up to `HOST_KEY_PATIENCE`. The frontend can make the wait
/// shorter. It answers the question on screen.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a claim
/// about today's code. The end of a connection has nothing to fail on yet.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), PieError> {
    // The guard is dropped at the end of this block. Therefore the slot is free
    // before the sessions stop, and the shutdown below does not hold it. The order
    // of a new `connect` against this stop is the task of the frontend, not of a
    // lock.
    let sessions = {
        let mut slot = state.sessions.lock().await;
        slot.take()
    };
    if let Some(sessions) = sessions {
        sessions.close().await;
    }
    Ok(())
}

/// Brings the connection back, with what this process already holds.
///
/// A reach ends on its own: a network goes away, a host sleeps. The frontend hears the
/// end, and this is the command it answers it with. The machine, the address and the
/// credential are the ones already used in this process, so a person types nothing a
/// second time, and no secret crosses the boundary again - not even to pie's own
/// frontend.
///
/// # Errors
///
/// [`PieError::NotConnected`] when there is no connection to bring back - what a request
/// that raced the end of a connection finds - and everything a `connect` reports.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn reconnect(app: AppHandle, state: State<'_, AppState>) -> Result<crate::session::ConnectionInfo, PieError> {
    let mut slot = state.sessions.lock().await;
    let Some(previous) = slot.as_ref() else {
        return Err(PieError::NotConnected {
            doing: "bringing the connection back".to_string(),
        });
    };

    let id = previous.id().clone();
    tracing::info!(connection = %id, endpoint = %previous.host().endpoint(), "dialling the same machine again");

    let sessions = match previous.reconnect().await {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!(connection = %id, %error, "the connection could not be brought back");
            return Err(error.into());
        }
    };
    let info = sessions.info();
    *slot = Some(sessions.clone());
    watching(&app, sessions, id);
    Ok(info)
}

/// Closes the reach to the machine, as a network that goes away does.
///
/// # Errors
///
/// [`PieError::NotConnected`] when there is no connection whose reach could be closed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn close_the_reach(state: State<'_, AppState>) -> Result<(), PieError> {
    #[cfg(debug_assertions)]
    {
        let slot = state.sessions.lock().await;
        let Some(connection) = slot.as_ref() else {
            return Err(PieError::NotConnected {
                doing: "closing a reach".to_string(),
            });
        };
        tracing::info!("a debug build closed the reach to the machine");
        connection.close_the_reach().await;
        return Ok(());
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        tracing::warn!("a release build was asked to close a reach, and has no way to");
        Ok(())
    }
}

/// How often the watch of a reach asks whether it is still open.
const WATCH_EVERY: Duration = Duration::from_millis(500);

/// Watches the reach to the machine, and says so when it ends.
fn watching(app: &AppHandle, connection: SessionManager, id: Id) {
    let app = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            let held = {
                let state = app.state::<AppState>();
                let slot = state.sessions.lock().await;
                slot.as_ref().is_some_and(|current| current.is_same(&connection))
            };
            if !held {
                return;
            }
            if connection.is_open() {
                continue;
            }
            tracing::info!(connection = %id, "the reach to the machine ended");
            if let Err(error) = app.emit(&state_event(&id), ConnectionState::Ended) {
                tracing::warn!(connection = %id, %error, "the end of a reach was not announced");
            }
            return;
        }
    });
}

/// Answers the host-key question that the frontend shows.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(connection = %connection, trusted))]
pub fn trust_host_key(state: State<'_, AppState>, connection: String, trusted: bool) -> Result<bool, PieError> {
    Ok(state.question.answer(&connection, trusted))
}

/// One directory level on the connected machine, for the directory picker.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = ?path))]
pub async fn list_dirs(state: State<'_, AppState>, path: Option<String>) -> Result<Listing, PieError> {
    let sessions = super::connected(&state, "browsing its directories").await?;
    Ok(sessions.host().dirs(path.as_deref()).await?)
}

/// Whether a path names a directory on the connected machine.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = %path))]
pub async fn dir_exists(state: State<'_, AppState>, path: String) -> Result<bool, PieError> {
    let sessions = super::connected(&state, "reading its directories").await?;
    Ok(sessions.host().dir_exists(&path).await?)
}

/// Makes a directory on the connected machine, with parents as needed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = %path))]
pub async fn create_dir(state: State<'_, AppState>, path: String) -> Result<(), PieError> {
    let sessions = super::connected(&state, "making a directory").await?;
    Ok(sessions.host().create_dir(&path).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_connection_reads_as_none_rather_than_failing() {
        let state = AppState::default();

        assert!(
            current_connection(&state).await.is_none(),
            "no connection is a state, not a failure"
        );
    }

    #[tokio::test]
    async fn a_question_nobody_answers_stops_waiting() {
        let (_answer, decision) = oneshot::channel();

        let trusted = wait_for_answer(decision, Duration::from_millis(10)).await;

        assert!(!trusted, "no answer is not trust");
    }

    #[tokio::test]
    async fn an_answer_that_never_arrives_does_not_hold_a_question_open() {
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        let connection = Id::new("main").expect("a usable name");
        question.open(&connection, answer);

        assert!(!wait_for_answer(decision, Duration::from_millis(10)).await);
        assert!(
            !question.answer("main", true),
            "a late answer finds nobody waiting, and says that it answered nothing"
        );
    }

    #[test]
    fn spec_deserializes_from_the_connect_screens_json() {
        let local: ConnectSpec = serde_json::from_str(r#"{"transport": "local"}"#).unwrap();
        assert!(matches!(local, ConnectSpec::Local));

        let ssh: ConnectSpec = serde_json::from_str(
            r#"{
                "transport": "ssh",
                "host": "box.local",
                "user": "pi",
                "auth": { "type": "password", "password": "secret" }
            }"#,
        )
        .unwrap();
        assert!(matches!(ssh, ConnectSpec::Ssh { port: None, .. }));

        let key: ConnectSpec = serde_json::from_str(
            r#"{
                "transport": "ssh",
                "host": "box.local",
                "port": 2222,
                "user": "pi",
                "auth": { "type": "key", "key": "-----BEGIN OPENSSH PRIVATE KEY-----" }
            }"#,
        )
        .unwrap();
        assert!(matches!(
            key,
            ConnectSpec::Ssh {
                port: Some(2222),
                auth: AuthSpec::Key { passphrase: None, .. },
                ..
            }
        ));
    }

    #[test]
    fn auth_debug_output_never_prints_secrets() {
        let password = format!(
            "{:?}",
            AuthSpec::Password {
                password: "hunter2".to_string()
            }
        );
        assert!(!password.contains("hunter2"), "got `{password}`");
        assert!(password.contains("<redacted>"), "got `{password}`");

        let key = format!(
            "{:?}",
            AuthSpec::Key {
                key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----".to_string(),
                passphrase: Some("hunter2".to_string()),
            }
        );
        assert!(!key.contains("BEGIN OPENSSH PRIVATE KEY"), "got `{key}`");
        assert!(!key.contains("AAAA"), "got `{key}`");
        assert!(!key.contains("hunter2"), "got `{key}`");
        assert!(key.contains("<redacted>"), "got `{key}`");
    }
}
