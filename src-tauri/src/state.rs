//! The state of one app run: the connected hosts and the active one, the
//! host-key questions, the count that names a pi process, and the marks of the
//! providers.
//!
//! Tauri hands this value to every command that asks for it, and these are the
//! things those commands share. The product keeps one active machine at a time;
//! the registry can hold more connections than that. The hosts lock is held to
//! move a runtime in or out of the registry, never across an await. A host-key
//! question has its own lock, so its answer can arrive while that host connects.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::runtime::{HostKeyQuestion, HostManager};

/// How long a person has to answer a host-key question.
///
/// Nothing else limits this wait. The host-key step of the reach has no limit by
/// design, because a person operates there. A dialog that is dismissed, or a
/// frontend that goes away during a question, would hold the connect of that
/// host open forever. Only a restart of pie would give an exit. This time is long
/// enough to compare a fingerprint by eye.
pub(crate) const HOST_KEY_PATIENCE: Duration = Duration::from_secs(120);

/// What the commands of one app run share.
#[derive(Debug, Default)]
pub struct AppState {
    /// The connected hosts, and the one the frontend shows. The lock is held to
    /// move a runtime in or out of the registry, never across an await.
    pub(crate) hosts: Mutex<HostManager>,
    pub(crate) question: Arc<HostKeyQuestion>,
    /// The marks of the providers that this run fetched, by provider.
    pub(crate) marks: Mutex<Marks>,
    /// How many pi processes this run of pie has started.
    ///
    /// The id of a session carries this number. The ids must stay apart for the
    /// whole run: a reconnect starts a new pi under the name of the same
    /// connection, and the frontend must not take the events of the one for the
    /// events of the other (`main:1`, then `main:2`). The count only rises, and it
    /// starts again when pie does - the processes of the last run are gone with
    /// it.
    session_number: AtomicU64,
}

impl AppState {
    /// The number for the next pi process that starts.
    ///
    /// A connect that fails takes a number with it, because the count is read
    /// before the attempt. A gap says nothing, and the ids stay unique.
    pub(crate) fn next_session_number(&self) -> u64 {
        self.session_number.fetch_add(1, Ordering::Relaxed) + 1
    }
}

/// How long the mark of one provider stays good: a day. It is as long as the
/// frontend keeps its own copy (`LOGO_TTL` of `ModelPicker.tsx`), so a popup
/// opened twice asks models.dev once.
const MARK_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a failed fetch is remembered: a machine that is offline now may be
/// online in a minute, and a popup opened again must not ask again at once.
const MARK_RETRY: Duration = Duration::from_secs(5 * 60);

/// One provider's fetch: what it left, and when.
#[derive(Debug)]
struct Fetched {
    at: Instant,
    /// The mark as a data URL, or `None` when there is none.
    mark: Option<String>,
}

/// The marks of this run, by provider. Without it, every opening of the picker
/// of a model would ask models.dev for the marks it already has.
#[derive(Debug, Default)]
pub(crate) struct Marks(HashMap<String, Fetched>);

impl Marks {
    /// What the entry of a provider holds, when it is still good at `now`. `None`
    /// is an entry that is gone or too old; `Some(None)` is a provider with no
    /// mark.
    pub(crate) fn get(&self, provider: &str, now: Instant) -> Option<Option<String>> {
        let entry = self.0.get(provider)?;
        let ttl = if entry.mark.is_some() { MARK_TTL } else { MARK_RETRY };
        (now.saturating_duration_since(entry.at) < ttl).then(|| entry.mark.clone())
    }

    /// Keeps what a fetch left, for the length its kind is good.
    pub(crate) fn put(&mut self, provider: &str, mark: Option<String>, now: Instant) {
        self.0.insert(provider.to_string(), Fetched { at: now, mark });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_number_of_a_session_only_rises() {
        let state = AppState::default();

        assert_eq!(state.next_session_number(), 1, "the first pi of a run is `:1`");
        assert_eq!(state.next_session_number(), 2, "a reconnect is `:2`, not `:1` again");
        assert_eq!(state.next_session_number(), 3);
    }

    #[test]
    fn a_mark_is_kept_for_a_day_and_a_failure_for_minutes() {
        let mut marks = Marks::default();
        let now = Instant::now();
        let mark = "data:image/svg+xml;base64,AA==".to_string();
        marks.put("anthropic", Some(mark.clone()), now);

        assert_eq!(marks.get("anthropic", now), Some(Some(mark.clone())));
        assert_eq!(
            marks.get("anthropic", now + MARK_TTL - Duration::from_secs(1)),
            Some(Some(mark)),
            "still good at the edge of the day"
        );
        assert_eq!(marks.get("anthropic", now + MARK_TTL), None, "the day is over");
        assert_eq!(marks.get("openai", now), None, "an unknown provider has no entry");

        marks.put("openai", None, now);
        assert_eq!(
            marks.get("openai", now + MARK_RETRY - Duration::from_secs(1)),
            Some(None),
            "a failure is fresh for its shorter while"
        );
        assert_eq!(marks.get("openai", now + MARK_RETRY), None, "the wait is over");
    }
}
