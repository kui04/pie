//! Absolute-path checks for a machine's paths.

use super::files;
use typed_path::Utf8TypedPath;

/// How a machine spells an absolute path.
#[derive(Debug, Clone, Copy)]
pub(crate) enum PathStyle {
    /// The platform of this app: POSIX or Windows.
    Native,
    /// A POSIX machine, reached over SSH.
    Posix,
}

/// Validates that a host path is absolute in the machine's style.
pub(crate) fn checked(path: &str, style: PathStyle) -> anyhow::Result<&str> {
    let absolute = match style {
        PathStyle::Native => Utf8TypedPath::derive(path).is_absolute(),
        PathStyle::Posix => path.starts_with('/'),
    };
    if absolute {
        Ok(path)
    } else {
        Err(files::not_absolute(path))
    }
}

/// Validates an absolute path of this machine.
pub(crate) fn is_absolute_path(path: &str) -> anyhow::Result<&str> {
    checked(path, PathStyle::Native)
}

/// Validates an absolute POSIX path of an SSH host.
pub(crate) fn is_posix_absolute(path: &str) -> anyhow::Result<&str> {
    checked(path, PathStyle::Posix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_native_style_accepts_posix_and_windows_roots() {
        for path in ["/", "/home/u", "C:\\Users\\u", "c:/Users/u", "\\\\server\\share"] {
            assert!(is_absolute_path(path).is_ok(), "`{path}` is absolute");
        }
        for path in ["", ".", "sessions/one", "C:relative"] {
            assert!(is_absolute_path(path).is_err(), "`{path}` is relative");
        }
    }

    #[test]
    fn the_posix_style_rejects_windows_roots() {
        assert!(is_posix_absolute("/").is_ok());
        assert!(is_posix_absolute("/home/u/.pi").is_ok());
        assert!(is_posix_absolute("C:\\Users\\u").is_err());
        assert!(is_posix_absolute("c:/Users/u").is_err());
        assert!(is_posix_absolute("\\\\server\\share").is_err());
        assert!(is_posix_absolute("sessions/one").is_err());
    }
}
