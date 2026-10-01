//! Pi's `pi --mode rpc` JSONL protocol: wire types, framing, and transports.
//!
//! Pi is driven as a long-lived process - spawned locally or reached over SSH -
//! that speaks one JSON object per LF-terminated line: commands on stdin,
//! responses and events on stdout. This module is that protocol. It owns the
//! wire types, the framing, and the transports; it holds no connection policy,
//! never touches the UI, and must not depend on Tauri or on the rest of the app:
//! `tests/purity.rs` fails the build if it does, because as a module that
//! boundary is a convention rather than a crate edge.
//!
//! # Protocol
//!
//! * Client -> Pi: [`protocol::Command`] records on stdin, plus
//!   [`protocol::ExtensionUiResponse`] answers to dialogs Pi asked for.
//! * Pi -> client: [`protocol::Response`], [`protocol::Event`],
//!   [`protocol::ExtensionUiRequest`] and `extension_error` records, all
//!   surfaced through [`protocol::ServerMessage`].
//! * Framing: [`framing`] - records are split on `\n` only, one trailing `\r`
//!   is stripped.
//!
//! [`Client`] runs the read loop: it correlates responses by id, fans everything
//! else out to subscribers, and closes stdin for an orderly shutdown.
//!
//! # Version
//!
//! [`PI_VERSION`] is the Pi release whose protocol this mirrors - the app version
//! itself, so `pie`, `tauri.conf.json` and the protocol types move together.
//! [`probe_version`] and [`check_version`] compare a `pi` binary against that
//! pin. Pi's protocol carries no compatibility guarantee, so before bumping:
//! re-read the pinned checkout at `.codegraph/.references/pi` and re-record the
//! fixtures in `src-tauri/tests/fixtures`.
//!
//! # Example
//!
//! ```no_run
//! use pie_lib::pi_rpc::protocol::{Command, CommandKind};
//! use pie_lib::pi_rpc::transport::LocalTransport;
//! use pie_lib::pi_rpc::Client;
//!
//! # async fn example() -> pie_lib::pi_rpc::Result<()> {
//! let transport = LocalTransport::pi().arg("--no-session").spawn()?;
//! let client = Client::start(transport)?;
//! let response = client.request(Command::new(CommandKind::GetState)).await?;
//! println!("{:?}", response.data);
//! client.shutdown().await;
//! # Ok(())
//! # }
//! ```

mod client;
mod error;
pub mod framing;
pub mod protocol;
pub mod transport;
mod version;

pub use client::{Client, ClientOptions};
pub use error::{Error, Result};
pub use version::{PI_VERSION, check_version, probe_version};
