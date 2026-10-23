//! One value as a POSIX shell reads it.

/// Quotes `text` for a POSIX shell, so it reaches the command unmangled.
///
/// A path that a person selected and a path that pi wrote both go through here:
/// the machine's shell is what decides where a value ends, and two spellings of
/// that rule would be one too many.
pub(super) fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_quotes_and_spaces() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("with space"), "'with space'");
        assert_eq!(quote("it's"), r"'it'\''s'");
    }
}
