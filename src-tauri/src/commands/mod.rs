//! What the frontend can ask pie to do, and what it hears back.
//!
//! Every command is `snake_case`. Every command returns
//! `Result<T, `[`PieError`](crate::error::PieError)>`. Therefore a failure
//! arrives as a named variant of the layer that owns it, not as a string.
//!
//! A command fails as its own layer's error: [`Error`] for the IPC layer, and
//! `connection::Error` for the reach of pie to the host. `crate::error`
//! aggregates these errors. It does not decide their meaning. The rules of the
//! boundary are in `.agents/rules/architecture.md`.
//!
//! One file for each area of the product: [`connect`] opens and closes the one
//! host, [`files`] reads what is on it, [`keys`] asks the person for a private
//! key, [`pipe`] forwards what pi says about a session, [`platform`] says which
//! kind of machine this is, [`session`] reads what a session of pi holds, and
//! [`state`] holds what they share.
//!
//! `run()` names every command by module; [`pipe`] holds none, because it has no
//! command: `connect` starts its task. `#[tauri::command]` puts the wrapper that
//! `generate_handler!` looks for next to the function. A re-export of the
//! function does not carry it.
//!
//! `connect` answers with what it made. A *question* comes the other way, as an
//! event, because it arrives while the command is still in progress. The
//! frontend names the connection that it opens (`connect` takes that name) and
//! listens on `pi://connection/{id}/state` before it calls.

pub mod connect;
mod error;
pub mod files;
pub mod keys;
pub mod pipe;
pub mod platform;
pub mod session;
pub mod state;

pub use error::Error;
pub use state::AppState;
