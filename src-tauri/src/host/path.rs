//! A path on a machine, as that machine writes it.
//!
//! Pie reaches two machines: this one and a host over SSH. A path belongs to the
//! machine it names, and the two spell paths differently - POSIX or Windows -
//! which is why the rule about absolute paths lives here and not with the
//! machine that happened to read the path first.

use std::fmt::{Display, Formatter};
use std::path::Path;

use serde::Serialize;

/// A path on the machine pie reaches.
///
/// Pie never resolves one against its own directory: on a phone, that directory
/// is not the home of a person. Therefore a path either arrives absolute - from
/// the directory picker, or from the session listing that pi wrote - or it is a
/// mistake, and [`HostPath::is_absolute`] is what says so.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct HostPath(String);

impl HostPath {
    /// Names a path as the machine writes it.
    pub fn new(path: impl Into<String>) -> Self {
        Self(path.into())
    }

    /// Names a path of this machine.
    ///
    /// A path whose bytes are not text on this platform becomes a replacement
    /// character: what travels is a name a person reads, not a byte string.
    pub(crate) fn of_local(path: &Path) -> Self {
        Self(path.to_string_lossy().into_owned())
    }

    /// The path, for the machine that will use it.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether the path is absolute in either spelling a host may use.
    ///
    /// `C:/x`, `C:\x`, `/x` and `\\host\share` are absolute; `x`, `./x` and a
    /// bare drive are not. Both spellings are accepted because pie cannot know
    /// which host the path is for.
    pub fn is_absolute(&self) -> bool {
        is_absolute_path(self.as_str())
    }
}

/// The one rule about absolute paths, in either spelling a host may use.
///
/// A path of this machine follows the platform, which is why the local reads
/// use [`std::path::Path::is_absolute`] and do not come here. A path of the
/// machine pie reached arrives as text, and both spellings are possible. The
/// rule belongs beside the type that carries such a path, not with the reader
/// that happened to see it first.
pub(crate) fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with("\\\\")
        || matches!(
            path.as_bytes(),
            [drive, b':', sep, ..] if drive.is_ascii_alphabetic() && matches!(sep, b'\\' | b'/')
        )
}

impl Display for HostPath {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_of_a_host_is_absolute_in_either_spelling() {
        for absolute in ["/home/pi", "\\\\host\\share", "C:\\Users\\pi", "c:/users"] {
            assert!(HostPath::new(absolute).is_absolute(), "`{absolute}` is absolute");
        }
        for relative in ["", "pi", ".pi/agent", "./x", "C:", "1:\\x"] {
            assert!(!HostPath::new(relative).is_absolute(), "`{relative}` is not absolute");
        }
    }

    #[test]
    fn a_path_crosses_as_the_string_the_frontend_reads() {
        assert_eq!(
            serde_json::to_value(HostPath::new("/home/pi")).expect("a path serializes"),
            serde_json::json!("/home/pi")
        );
    }
}
