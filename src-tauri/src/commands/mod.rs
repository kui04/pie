//! What the frontend can ask pie to do, and what it hears back.
//!
//! Every command is `snake_case`. Every command returns
//! `Result<T, `[`PieError`]>`. A failure arrives as a sentence that the step
//! which failed wrote, with a name only for the failures this boundary decides
//! itself. It never arrives as a bare string.
//!
//! The files here are the areas of the product, and each one is the area
//! responsible for its answers: [`host`] opens, reads and closes the connected
//! machines, [`session`] is everything a pi session is asked to do, [`app`] is the
//! app itself, [`files`] is file selection and path inspection, [`attachment`] stages
//! a file where pi can read it, and [`log`] is where a line of the frontend goes.
//! [`pipe`] forwards what pi says about a session, and holds no command of its
//! own: `connect` starts its task. [`PieError`] is what this layer cannot do. What
//! the commands share - the connected hosts, the one active, the questions, the
//! count that names a pi process - lives at the crate root ([`crate::state`]),
//! because it is the state of the run and not of this boundary.
//!
//! `src/lib/bridge/` in the frontend mirrors this list one file to one file.
//!
//! `run()` names every command by module. `#[tauri::command]` puts the wrapper
//! that `generate_handler!` looks for next to the function. A re-export of the
//! function does not carry it.
//!
//! Every command but [`log`] is instrumented, so one line per call says what it
//! carried, how it ended and how long it took (see [`crate::log`]).
//!
//! `connect` answers with what it made. A *question* comes the other way, as an
//! event, because it arrives while the command is still in progress. The frontend
//! names the connection that it opens (`connect` takes that name) and listens on
//! `pi://connection/{id}/state` before it calls.

pub mod app;
pub mod attachment;
pub mod files;
pub mod host;
pub mod log;
pub mod pipe;
pub mod session;

use std::sync::{Arc, PoisonError};

use crate::{error::PieError, runtime::HostRuntime, session::SessionManager, state::AppState};

/// The active connection runtime, or the failure of the IPC layer when there is none.
///
/// The lock is held to clone the runtime and not a moment longer: a command that
/// reads through the connection must not hold it.
pub(crate) fn connected_runtime(state: &AppState, doing: &str) -> Result<Arc<HostRuntime>, PieError> {
    let runtime = state.hosts.lock().unwrap_or_else(PoisonError::into_inner).active();
    runtime.ok_or_else(|| PieError::NotConnected {
        doing: doing.to_string(),
    })
}

/// The sessions of the active connection, or the failure of the IPC layer when
/// there is none.
pub(crate) fn connected(state: &AppState, doing: &str) -> Result<SessionManager, PieError> {
    Ok(connected_runtime(state, doing)?.sessions().clone())
}
