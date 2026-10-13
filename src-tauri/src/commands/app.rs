//! The app itself: which machine this is, and what it does with the world
//! outside the window.
//!
//! Nothing here touches pi. A link leaves for the browser of the machine, the
//! mark of a provider is fetched from models.dev, and the platform is a fact
//! compiled into this build; all three are the app's own business, which is why
//! they share a file.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine as _;
use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

use crate::error::PieError;

use super::Error;

/// Which kind of machine this is.
///
/// Pie asks the host. CSS does not measure this. A window in the shape of a phone
/// is a desktop. A tablet in landscape mode is a phone. The value is compiled in.
/// Therefore it cannot change while the app operates.
///
/// # Errors
///
/// The result is the shape of the boundary (`architecture.md`). It is not a claim
/// about today's code. A compiled-in fact has nothing to fail on yet.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub fn platform() -> Result<&'static str, PieError> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return Ok("mobile");

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Ok("desktop")
}

/// The schemes whose links this app opens.
const SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// What a person is shown of an address: one line of it, not a paragraph.
const SHOWN: usize = 120;

/// In characters, as the sentence beside it is: nothing real is longer, and a
/// longer one is a payload rather than a link.
const LONGEST: usize = 2048;

/// Parses a link that pie will open, or refuses it with the reason named.
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
/// A webview is not the place to follow a link: it would take the window pie
/// speaks to pi through. Only the schemes above leave, whatever a message holds.
///
/// Async because the opener under it waits for the program it started on macOS,
/// and a webview that cannot answer its own click is the worse trade.
///
/// # Errors
///
/// [`Error::UnopenableUrl`] for a link pie does not trust, and
/// [`Error::OpenFailed`] when the machine will not open one it does.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(chars = url.chars().count()))]
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

/// How long the mark of one provider stays good: a day. It is as long as the
/// frontend keeps its own copy (`LOGO_TTL` of `ModelPicker.tsx`), so a popup
/// opened twice asks models.dev once.
const LOGO_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a failed fetch is remembered: a machine that is offline now may be
/// online in a minute, and a popup opened again must not ask again at once.
const LOGO_RETRY: Duration = Duration::from_secs(5 * 60);

/// How long the request may take before it is a failure.
const LOGO_PATIENCE: Duration = Duration::from_secs(10);

/// The longest a provider name may be. Every name pi knows is shorter, and a
/// name of a hundred characters is a payload rather than a provider.
const LOGO_NAME: usize = 64;

/// Where the marks of models.dev live: one SVG for each provider it knows.
const LOGO_BASE: &str = "https://models.dev/logos/";

/// One provider's fetch: what it left, and when.
struct Fetched {
    at: Instant,
    /// The mark as a data URL, or `None` when there is none.
    mark: Option<String>,
}

/// The marks of this run, by provider. Without it, every opening of the picker
/// of a model would ask models.dev for the marks it already has.
#[derive(Default)]
struct Marks(HashMap<String, Fetched>);

impl Marks {
    /// What the entry of a provider holds, when it is still good at `now`. `None`
    /// is an entry that is gone or too old; `Some(None)` is a provider with no
    /// mark.
    fn get(&self, provider: &str, now: Instant) -> Option<Option<String>> {
        let entry = self.0.get(provider)?;
        let ttl = if entry.mark.is_some() { LOGO_TTL } else { LOGO_RETRY };
        (now.saturating_duration_since(entry.at) < ttl).then(|| entry.mark.clone())
    }

    /// Keeps what a fetch left, for the length its kind is good.
    fn put(&mut self, provider: &str, mark: Option<String>, now: Instant) {
        self.0.insert(provider.to_string(), Fetched { at: now, mark });
    }
}

static LOGOS: LazyLock<Mutex<Marks>> = LazyLock::new(|| Mutex::new(Marks::default()));

/// The provider name as models.dev writes it in a URL, or `None` when it cannot
/// go in one. A name with a `/`, a `.` or a space would ask for another file
/// than the one this app means, so those shapes are refused before a request is
/// made.
fn logo_slug(provider: &str) -> Option<&str> {
    let slug = provider.trim();
    let known = !slug.is_empty()
        && slug.len() <= LOGO_NAME
        && slug
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-');
    known.then_some(slug)
}

/// A mark as a URL an image or a mask can hold.
fn logo_url(svg: &str) -> String {
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    )
}

/// Fetches one SVG of models.dev. The call is blocking, so the command gives it
/// a thread of its own.
fn fetch_logo(provider: &str, url: &str) -> Result<String, Error> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(LOGO_PATIENCE))
        .build()
        .into();
    let mut answer = agent.get(url).call().map_err(|source| logo_failure(provider, source))?;
    answer
        .body_mut()
        .read_to_string()
        .map_err(|source| logo_failure(provider, source))
}

/// Makes the named failure of one fetch: the provider is part of the sentence
/// the person reads, and the request error travels with it.
fn logo_failure(provider: &str, source: ureq::Error) -> Error {
    Error::LogoFetch {
        provider: provider.to_string(),
        source: Box::new(source),
    }
}

/// The mark of a provider of models.dev, as a data URL, or `None` when there is
/// none.
///
/// The frontend draws it beside the model in use and at the left of every row of
/// the picker. models.dev is the source; a request that fails answers `None` for
/// as long as that failure is remembered (`LOGO_RETRY` of this file), and the
/// frontend draws its own icon until then.
///
/// # Errors
///
/// [`Error::LogoFetch`] when models.dev cannot be reached or answers badly. The
/// failure stands for the same while, so a popup opened again does not ask again
/// at once.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(provider = %provider))]
pub async fn provider_logo(provider: String) -> Result<Option<String>, PieError> {
    let Some(slug) = logo_slug(&provider).map(str::to_string) else {
        return Ok(None);
    };
    if let Some(mark) = cached(&slug) {
        return Ok(mark);
    }

    let url = format!("{LOGO_BASE}{slug}.svg");
    let name = slug.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || fetch_logo(&name, &url)).await;
    let svg = match fetched {
        Ok(Ok(svg)) => svg,
        Ok(Err(error)) => {
            remember(&slug, None);
            return Err(error.into());
        }
        Err(error) => {
            // The task of a fetch panicked, which is a bug of this app and not a
            // fact about the provider: the frontend draws its own icon.
            tracing::warn!(%error, provider = %slug, "the mark fetch did not finish");
            return Ok(None);
        }
    };

    let mark = logo_url(&svg);
    remember(&slug, Some(mark.clone()));
    Ok(Some(mark))
}

/// The mark of a provider from the cache, when its entry is still good.
fn cached(provider: &str) -> Option<Option<String>> {
    let marks = LOGOS.lock().unwrap_or_else(PoisonError::into_inner);
    marks.get(provider, Instant::now())
}

/// Keeps what a fetch left, for the length its kind is good.
fn remember(provider: &str, mark: Option<String>) {
    let mut marks = LOGOS.lock().unwrap_or_else(PoisonError::into_inner);
    marks.put(provider, mark, Instant::now());
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        LOGO_NAME, LOGO_RETRY, LOGO_TTL, LONGEST, Marks, SHOWN, logo_slug, logo_url, openable, platform, shown,
    };
    use crate::commands::error::Error;

    #[test]
    fn the_platform_answers_one_of_the_two_words_the_frontend_asks_about() {
        // The string is the full contract. The other value is as unreachable as
        // the mobile branch in the command.
        let answer = platform().expect("cannot fail");
        assert!(matches!(answer, "mobile" | "desktop"), "got {answer:?}");
    }

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

    #[test]
    fn a_provider_name_passes_only_as_models_dev_writes_it() {
        for good in ["anthropic", "openai", "deepseek", "google-vertex", "zai-coding-cn"] {
            assert_eq!(logo_slug(good), Some(good), "{good} should pass");
        }
        for refused in ["", "   ", "Anthropic", "open/ai", "../openai", "open ai", "openai.svg"] {
            assert_eq!(logo_slug(refused), None, "{refused:?} should be refused");
        }
        let long = "a".repeat(LOGO_NAME + 1);
        assert_eq!(
            logo_slug(&long),
            None,
            "a long name is a payload rather than a provider"
        );
        // A name with room around it is the name.
        assert_eq!(logo_slug(" anthropic "), Some("anthropic"));
    }

    #[test]
    fn a_mark_is_kept_for_a_day_and_a_failure_for_minutes() {
        let mut marks = Marks::default();
        let now = Instant::now();
        let mark = logo_url("<svg/>");
        marks.put("anthropic", Some(mark.clone()), now);

        assert_eq!(marks.get("anthropic", now), Some(Some(mark.clone())));
        assert_eq!(
            marks.get("anthropic", now + LOGO_TTL - Duration::from_secs(1)),
            Some(Some(mark)),
            "still good at the edge of the day"
        );
        assert_eq!(marks.get("anthropic", now + LOGO_TTL), None, "the day is over");
        assert_eq!(marks.get("openai", now), None, "an unknown provider has no entry");

        marks.put("openai", None, now);
        assert_eq!(
            marks.get("openai", now + LOGO_RETRY - Duration::from_secs(1)),
            Some(None),
            "a failure is fresh for its shorter while"
        );
        assert_eq!(marks.get("openai", now + LOGO_RETRY), None, "the wait is over");
    }

    #[test]
    fn a_mark_arrives_as_a_data_url_of_the_svg() {
        use base64::Engine as _;

        let encoded = base64::engine::general_purpose::STANDARD.encode("<svg/>");

        assert_eq!(logo_url("<svg/>"), format!("data:image/svg+xml;base64,{encoded}"));
    }

    #[test]
    #[ignore = "reaches models.dev"]
    fn the_mark_of_a_provider_arrives_from_models_dev() {
        // The URL pattern, the client and its roots, in one run: a provider whose
        // mark is in the release of models.dev this app was written against.
        let svg = super::fetch_logo("anthropic", "https://models.dev/logos/anthropic.svg").expect("models.dev answers");

        assert!(svg.contains("<svg"), "the answer is an SVG: {svg}");
        assert!(logo_url(&svg).starts_with("data:image/svg+xml;base64,"));
    }
}
