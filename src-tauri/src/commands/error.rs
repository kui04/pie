//! What the IPC layer cannot do: the state of its own one-connection slot, and
//! the two things it can be asked that have nothing to do with pi.
//!
//! The slot belongs to this layer, so the failures of holding one do too: no
//! connection is [`Error::NotConnected`], and a second connect onto a live one is
//! [`Error::AlreadyConnected`]. They are not failures of a machine - the machine
//! is fine - which is why they are named here and not in
//! [`host::Error`](crate::host::Error).
//!
//! An argument that pie cannot use is here for the same reason. A failure of a
//! reach or of a session belongs to the layer that owns it, and this module adds no
//! wrapper: the failure of a command crosses the boundary without a change.

use serde::Serialize;
use thiserror::Error;

/// A failure of the IPC layer.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Error {
    /// A live connection is present, and the product keeps one at a time.
    #[error("pie is already connected to {endpoint}")]
    AlreadyConnected {
        /// The machine of the live connection, `local` or `user@host:port`.
        endpoint: String,
    },

    /// The command needs a connection. No connection is present.
    #[error("connect to a host before {doing}")]
    NotConnected {
        /// What the person tried to do. The sentence above uses it.
        doing: String,
    },

    /// A link pie will not open: not a link, or a scheme it does not trust.
    #[error("`{url}` is not a link pie opens")]
    UnopenableUrl {
        /// The address, as short as a sentence can hold it.
        url: String,
    },

    /// The machine would not open a link pie asked it to.
    #[error("the machine would not open `{url}`: {source}")]
    OpenFailed {
        /// The address, as short as a sentence can hold it.
        url: String,
        /// What the opener said, boxed: the whole error would make every `Result`
        /// of this module pay for the one failure that carries it.
        #[serde(skip)]
        #[source]
        source: Box<tauri_plugin_opener::Error>,
    },

    /// Pie cannot find its own directory for host keys.
    #[error("pie cannot resolve where to keep host keys: {source}")]
    NoHostKeyStore {
        /// What the platform reported. This value is not serializable.
        /// Therefore only the sentence beside it travels.
        #[serde(skip)]
        #[source]
        source: tauri::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_of_the_one_connection_is_named_here() {
        assert_eq!(
            Error::AlreadyConnected {
                endpoint: "local".to_string()
            }
            .to_string(),
            "pie is already connected to local"
        );
        assert_eq!(
            Error::NotConnected {
                doing: "listing its sessions".to_string()
            }
            .to_string(),
            "connect to a host before listing its sessions"
        );
    }

    #[test]
    fn a_link_pie_refuses_says_which_one() {
        let error = Error::UnopenableUrl {
            url: "javascript:alert(1)".to_string(),
        };

        assert_eq!(error.to_string(), "`javascript:alert(1)` is not a link pie opens");
    }
}
