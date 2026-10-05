//! What the frontend can ask pie to do, and what it hears back.
//!
//! Every command is `snake_case` and returns `Result<T, `[`PieError`](crate::error::PieError)>`,
//! so a failure arrives as the named variant of the layer that owns it rather
//! than a string it has to read. Inside, each command fails as its own layer's
//! error - [`Error`] for what the IPC layer cannot do, `connection::Error` for
//! this side's reach for the host - and `crate::error` aggregates them without
//! deciding what they mean. The rules of the boundary are in
//! `.agents/rules/architecture.md`.
//!
//! One file per area of the product: [`connect`] opens and closes the one host,
//! [`files`] reads what is on it, [`keys`] asks the person for a private key,
//! [`platform`] says which kind of machine this is, and [`state`] holds what they
//! share. `run()` names them by module: `#[tauri::command]` puts the wrapper a
//! `generate_handler!` looks for next to the function, and a re-export of the
//! function does not carry it.
//!
//! `connect` answers with what it made; a *question* it cannot answer comes the
//! other way, as an event, because it arrives while the command is still
//! running. So the frontend names the connection it is opening (`connect` takes
//! that name) and listens on `pi://connection/{id}/state` before it calls.

pub mod connect;
mod error;
pub mod files;
pub mod keys;
pub mod platform;
pub mod state;

pub use error::Error;
pub use state::AppState;
