//! What the frontend can ask pie to do.
//!
//! One file per area of the product. The wire types (the structs that cross the
//! boundary) live at the top of the file whose commands use them; the core
//! types stay in `host` and `session`.

pub mod app;
pub mod filesystem;
pub mod host;
pub mod log;
pub mod session;

use std::sync::{Arc, PoisonError};

use typed_path::Utf8TypedPathBuf;

use crate::error::PieError;
use crate::host::HostConnection;
use crate::session::Session;
use crate::state::{AppState, HostId};

/// The connected machine with this name.
pub(crate) fn host_at(state: &AppState, id: &HostId) -> Result<Arc<HostConnection>, PieError> {
    state
        .hosts
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(id)
        .cloned()
        .ok_or_else(|| PieError::NotConnected {
            doing: format!("reaching host `{id}`"),
        })
}

/// One running conversation, with the machine that holds it.
///
/// Its three parts are looked up once, so a command body never repeats the
/// lookup and never reaches a socket or a pi process on its own.
pub(crate) struct Attached {
    /// The machine.
    pub host: Arc<HostConnection>,
    /// The conversation file, as it was asked for.
    pub path: Utf8TypedPathBuf,
    /// The pi process that serves the file.
    pub session: Arc<Session>,
}

/// The machine, and the pi that serves one conversation file on it.
pub(crate) async fn session_at(
    state: &AppState,
    host: &HostId,
    path: &Utf8TypedPathBuf,
) -> Result<Attached, PieError> {
    let host = host_at(state, host)?;
    let session = host.session(path).ok_or_else(|| PieError::NotAttached {
        session: path.as_str().to_owned(),
    })?;

    Ok(Attached {
        host,
        path: path.clone(),
        session,
    })
}
