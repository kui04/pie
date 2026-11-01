//! The app itself: its links, the marks of providers, and the answers to asks.

use std::sync::PoisonError;

use anyhow::Context as _;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::bus::{Answer, AskId};
use crate::error::PieError;
use crate::state::{AppState, ProviderId};

/// Answers one ask. `false` means no ask waited under that id.
#[tauri::command(rename = "answer")]
pub fn app_answer(state: State<'_, AppState>, id: AskId, answer: Answer) -> bool {
    state.bus().answer(id, answer)
}

/// Which kind of machine pie runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    /// Android or iOS: the screen is small and the pickers are the system's.
    Mobile,
    /// A desktop session, where pie owns windows and file dialogs.
    Desktop,
}

/// A link pie is willing to hand to the browser.
///
/// A value exists only through [`OpenableUrl::parse`], so a scheme pie does not open
/// never reaches the opener.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenableUrl(String);

impl OpenableUrl {
    /// Parses `text` as a link of a scheme pie opens.
    pub fn parse(text: &str) -> Result<Self, PieError> {
        let refuse = || PieError::UnopenableUrl {
            url: text.to_owned(),
        };

        if text.chars().any(char::is_control) {
            return Err(refuse());
        }

        let url = Url::parse(text).map_err(|_| refuse())?;
        let opens = match url.scheme() {
            "http" | "https" => url.host_str().is_some_and(|host| !host.is_empty()),
            "mailto" => true,
            _ => false,
        };

        if opens {
            Ok(Self(text.to_owned()))
        } else {
            Err(refuse())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Open a link in the browser of the machine.
#[tauri::command(rename = "open_url")]
pub async fn app_open_url(app: AppHandle, url: String) -> Result<(), PieError> {
    let url = OpenableUrl::parse(&url)?;

    app.opener()
        .open_url(url.as_str(), None::<String>)
        .with_context(|| format!("opening `{}`", url.as_str()))?;

    Ok(())
}

/// Which kind of machine this is.
#[tauri::command(rename = "platform")]
pub fn app_platform() -> Result<Platform, PieError> {
    Ok(if cfg!(mobile) {
        Platform::Mobile
    } else {
        Platform::Desktop
    })
}

/// One provider's mark, as base64 of the SVG.
#[tauri::command(rename = "provider_logo")]
pub async fn app_provider_logo(
    state: State<'_, AppState>,
    provider: String,
) -> Result<Option<String>, PieError> {
    let provider = ProviderId::parse(&provider)?;

    // The guard is released before any await, and before the fetch.
    let (dir, path, cached) = {
        let mut cache = state.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if cache.failed(&provider) {
            return Ok(None);
        }

        (
            cache.dir().to_owned(),
            cache.path(&provider),
            cache.logo(&provider).is_some(),
        )
    };

    if cached {
        match tokio::fs::read(path.as_std_path()).await {
            Ok(bytes) => return Ok(Some(STANDARD.encode(bytes))),
            Err(error) => {
                tracing::warn!(%error, path = %path, "a cached provider mark could not be read")
            }
        }
    }

    // `ureq` blocks, so the fetch runs on a blocking thread; a blocking call on a
    // runtime worker would hold up every other command.
    let url = format!("https://models.dev/logos/{provider}.svg");
    let fetched = tokio::task::spawn_blocking(move || {
        let mut response = ureq::get(url.as_str())
            .call()
            .with_context(|| format!("fetching `{url}`"))?;
        let body = response
            .body_mut()
            .read_to_vec()
            .with_context(|| format!("reading `{url}`"))?;

        std::fs::create_dir_all(&dir)
            .with_context(|| format!("making the cache directory `{dir}`"))?;
        std::fs::write(&path, &body).with_context(|| format!("writing `{path}`"))?;

        Ok::<Vec<u8>, anyhow::Error>(body)
    })
    .await
    .context("the provider mark fetch did not run")?;

    match fetched {
        Ok(body) => {
            state
                .cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remember(provider);
            Ok(Some(STANDARD.encode(body)))
        }
        Err(error) => {
            tracing::warn!(%error, provider = %provider, "a provider mark could not be fetched");
            state
                .cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .record_failure(provider);
            Ok(None)
        }
    }
}

/// Replay the open asks. The frontend calls this after it subscribes.
#[tauri::command(rename = "ready_for_answer")]
pub fn app_ready_for_answer(state: State<'_, AppState>) {
    state.bus().ready();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_pie_opens_needs_a_known_scheme_and_a_host() {
        for link in [
            "https://example.com/a",
            "http://example.com",
            "mailto:someone@example.com",
        ] {
            let url = OpenableUrl::parse(link).expect("a link pie opens");
            assert_eq!(url.as_str(), link);
        }

        for link in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://",
            "not a link",
            "",
        ] {
            let error = OpenableUrl::parse(link).expect_err("no link pie opens");
            assert!(
                matches!(error, PieError::UnopenableUrl { .. }),
                "`{link}`: {error}"
            );
        }
    }

    #[test]
    fn a_link_with_a_control_character_is_refused() {
        let error = OpenableUrl::parse("https://example.com/a\nb").expect_err("no link pie opens");
        assert!(matches!(error, PieError::UnopenableUrl { .. }), "{error}");
    }
}
