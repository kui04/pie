//! The state of one app run: the one connection, the one question, the count
//! that names a pi process, and the marks of the providers.
//!
//! Tauri hands this value to every command that asks for it, and these are the
//! things those commands share. The product keeps one machine at a time. Therefore the connection is one slot.
//! The lock of the slot stops two `connect` commands from a race for it. The
//! question for a person lives in its own lock, *not* in that slot. `connect`
//! holds the slot from its start until the connection is ready. On first contact,
//! it waits during that time for the answer to this question. One lock for both
//! would deadlock. A separate lock lets an answer arrive while the connection is
//! in progress.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::session::{Id, SessionManager};

/// How long a person has to answer a host-key question.
///
/// Nothing else limits this wait. The host-key step of the reach has no limit by
/// design, because a person operates there. A dialog that is dismissed, or a
/// frontend that goes away during a question, would hold `connect` and its locked
/// slot forever. Only a restart of pie would give an exit. This time is long
/// enough to compare a fingerprint by eye.
pub(crate) const HOST_KEY_PATIENCE: Duration = Duration::from_secs(120);

/// What the commands of one app run share.
#[derive(Debug, Default)]
pub struct AppState {
    /// Shared hands on the one connection. The session listings use their hand
    /// while `connect`/`disconnect` move the slot itself.
    pub(crate) sessions: AsyncMutex<Option<SessionManager>>,
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

/// The host-key question that a person is asked now.
#[derive(Debug, Default)]
pub(crate) struct HostKeyQuestion {
    /// The connection that asked, and the place for its answer, while the question
    /// is on screen.
    waiting: Mutex<Option<(Id, oneshot::Sender<bool>)>>,
}

impl HostKeyQuestion {
    /// Waits for an answer from `connection`. This function replaces a question
    /// without an answer.
    pub(crate) fn open(&self, connection: &Id, answer: oneshot::Sender<bool>) {
        let replaced = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace((connection.clone(), answer));
        if replaced.is_some() {
            tracing::warn!("a host-key question was still open; the new one replaces it");
        }
    }

    /// Stops the wait, if there is no person to receive the question.
    ///
    /// This function drops the question of this connection only, as it takes the
    /// answer of this connection only. One connection at a time means that these
    /// are always the same question today. Nothing here must depend on that.
    pub(crate) fn close(&self, connection: &Id) {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        if waiting.as_ref().is_some_and(|(asked, _)| asked == connection) {
            waiting.take();
        }
    }

    /// Delivers an answer, if this connection waits for one.
    ///
    /// An abandoned question can leave its dialog on screen. A person who clicks
    /// that dialog must not answer the question that replaced it, because the
    /// person did not see the keys of the new question. This function ignores a
    /// mismatched answer. The question of the answer stays open for the correct
    /// answer.
    pub(crate) fn answer(&self, connection: &str, trusted: bool) -> bool {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        match waiting.as_ref() {
            Some((asked, _)) if asked.as_str() == connection => {}
            _ => return false,
        }
        match waiting.take() {
            Some((_, answer)) => answer.send(trusted).is_ok(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(name: &str) -> Id {
        Id::new(name).expect("a usable name")
    }

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

    #[tokio::test]
    async fn an_answer_for_another_connection_cannot_land() {
        // An abandoned question can leave its dialog on screen. A click on that
        // dialog must not answer the question that replaced it. The person did not
        // see the key of the new question.
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open(&connection("first"), answer);

        assert!(!question.answer("second", true), "that is not the connection asking");
        assert!(question.answer("first", true), "the connection that asked still can");
        assert!(decision.await.expect("the answer arrives"));
    }

    #[tokio::test]
    async fn a_question_is_only_closed_by_the_connection_that_asked_it() {
        // This is the same rule as for answering. The drop of a question that no
        // person receives must not drop the question of another connection.
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open(&connection("first"), answer);

        question.close(&connection("second"));
        assert!(question.answer("first", true), "the question is still the first one's");
        assert!(decision.await.expect("the answer arrives"));

        let (answer, decision) = oneshot::channel();
        question.open(&connection("first"), answer);
        question.close(&connection("first"));
        assert!(
            decision.await.is_err(),
            "closing the question that asked drops its answer"
        );
        assert!(!question.answer("first", true), "and leaves nothing to answer");
    }

    #[tokio::test]
    async fn an_answer_without_a_question_has_nowhere_to_go() {
        let question = HostKeyQuestion::default();

        assert!(!question.answer("main", true), "nothing was asked");
    }

    #[tokio::test]
    async fn a_question_takes_one_answer_and_forgets_the_second() {
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open(&connection("main"), answer);

        assert!(question.answer("main", true), "the waiting question was answered");
        assert!(decision.await.expect("the answer arrives"));
        assert!(!question.answer("main", false), "the second answer is late");
    }

    #[tokio::test]
    async fn a_question_nobody_answered_before_the_next_one_is_dropped() {
        let question = HostKeyQuestion::default();
        let (first, first_decision) = oneshot::channel();
        question.open(&connection("main"), first);
        let (second, second_decision) = oneshot::channel();
        question.open(&connection("main"), second);

        assert!(
            first_decision.await.is_err(),
            "a question that was replaced cannot be answered"
        );
        assert!(question.answer("main", true));
        assert!(second_decision.await.expect("the replacement is answered"));
    }
}
