//! What the frontend can ask pie to do, and what it hears back.
//!
//! Every command is `snake_case`. Every command returns
//! `Result<T, `[`PieError`]>`. Therefore a failure arrives
//! as a named variant of the layer that owns it, not as a string.
//!
//! The files here are the areas of the product, and each one is the area
//! responsible for its answers: [`host`] opens, reads and closes the one machine,
//! [`session`] is everything a pi session is asked to do, [`app`] is the app
//! itself, [`files`] is file picking, staging and temporary storage, and [`log`]
//! is where a line of the frontend goes.
//! [`pipe`] forwards what pi says about a session, and holds no command of its
//! own: `connect` starts its task. [`Error`] names what this layer itself cannot do. What the commands share - the one
//! connection, the one question, the count that names a pi process - lives at the
//! crate root ([`crate::state`]), because it is the state of the run and not of
//! this boundary.
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
mod error;
pub mod files;
pub mod host;
pub mod log;
pub mod pipe;
pub mod session;

pub use error::Error;

use crate::error::PieError;
use crate::session::SessionManager;
use crate::state::AppState;

/// The one connection, or the failure of the IPC layer when there is none.
///
/// The lock is held to clone the manager and not a moment longer: a command
/// that reads through the connection must not hold the slot.
pub(crate) async fn connected(state: &AppState, doing: &str) -> Result<SessionManager, PieError> {
    let sessions = state.sessions.lock().await.clone();
    sessions.ok_or_else(|| {
        Error::NotConnected {
            doing: doing.to_string(),
        }
        .into()
    })
}
