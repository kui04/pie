//! Connected hosts and the sessions that run on them.

mod host;
mod manager;
mod question;

pub use host::{ConnectionInfo, HostRuntime};
pub use manager::HostManager;
pub use question::HostKeyQuestion;
