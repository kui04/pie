//! Opening a link the transcript holds, in the browser of the machine.
//!
//! A webview is not the place to follow a link: it would take the window pie
//! speaks to pi through. Only the schemes below leave, whatever a message holds.

use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

use crate::commands::error::Error;
use crate::error::PieError;

const SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// What a person is shown of an address: one line of it, not a paragraph.
const SHOWN: usize = 120;

/// In characters, as the sentence beside it is: nothing real is longer, and a
/// longer one is a payload rather than a link.
const LONGEST: usize = 2048;

fn openable(url: &str) -> Result<Url, Error> {
    if url.chars().count() > LONGEST {
        return Err(Error::UnopenableUrl { url: shown(url) });
    }
    let parsed = Url::parse(url).map_err(|_| Error::UnopenableUrl { url: shown(url) })?;
    if !SCHEMES.contains(&parsed.scheme()) {
        return Err(Error::UnopenableUrl {
            url: shown(parsed.as_str()),
        });
    }
    Ok(parsed)
}

/// An address as a sentence can hold it. A refused one was never parsed, so it
/// arrives as it was given.
fn shown(url: &str) -> String {
    let flat: String = url
        .chars()
        .map(|character| if character.is_control() { ' ' } else { character })
        .collect();
    if flat.chars().count() <= SHOWN {
        return flat;
    }
    let mut cut: String = flat.chars().take(SHOWN).collect();
    cut.push('…');
    cut
}

/// Opens a link from the transcript in the browser of the machine.
///
/// Async because the opener under it waits for the program it started on macOS,
/// and a webview that cannot answer its own click is the worse trade.
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), PieError> {
    let parsed = openable(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|source| Error::OpenFailed {
            url: shown(parsed.as_str()),
            source: Box::new(source),
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{LONGEST, SHOWN, openable, shown};
    use crate::commands::error::Error;

    #[test]
    fn only_the_web_and_mail_are_links_this_app_opens() {
        for allowed in [
            "https://example.com",
            "http://example.com",
            "mailto:dev@example.com",
            // The URL parser drops the spaces a protocol line may carry.
            " https://example.com ",
        ] {
            assert!(openable(allowed).is_ok(), "{allowed} should be allowed");
        }
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "not a url",
        ] {
            assert!(
                matches!(openable(refused), Err(Error::UnopenableUrl { .. })),
                "{refused} should be refused"
            );
        }
    }

    #[test]
    fn an_address_is_refused_before_it_can_be_a_payload() {
        let long = format!("https://example.com/{}", "a".repeat(LONGEST));

        assert!(matches!(openable(&long), Err(Error::UnopenableUrl { url }) if url.chars().count() == SHOWN + 1));
    }

    #[test]
    fn an_address_is_measured_in_characters_not_in_bytes() {
        // Three bytes a character: longer than the limit in bytes, and a link.
        let wide = format!("https://example.com/{}", "字".repeat(700));

        assert!(wide.len() > LONGEST, "the case needs more bytes than the limit");
        assert!(wide.chars().count() < LONGEST, "and fewer characters");
        assert!(openable(&wide).is_ok(), "{wide} should be allowed");
    }

    #[test]
    fn what_a_person_reads_of_an_address_is_one_short_line() {
        let shown = shown("http://example.com/\nsecond line");

        assert!(!shown.contains('\n'), "the line should not break: {shown}");
    }
}
