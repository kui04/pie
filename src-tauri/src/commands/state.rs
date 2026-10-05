//! What the commands share.
//!
//! The product keeps one host at a time. Therefore the connection is one slot.
//! The lock of the slot stops two `connect` commands from a race for it. The
//! question for a person lives in its own lock, *not* in that slot. `connect`
//! holds the slot from its start until the connection is ready. On first
//! contact, it waits during that time for the answer to this question. One lock
//! for both would deadlock. A separate lock lets an answer arrive while the
//! connection is in progress.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::connection::Connection;

/// How long a person has to answer a host-key question.
///
/// Nothing else limits this wait. The host-key step of the transport has no
/// limit by design, because a person operates there. A dialog that is dismissed,
/// or a frontend that goes away during a question, would hold `connect` and its
/// locked slot forever. Only a restart of pie would give an exit. This time is
/// long enough to compare a fingerprint by eye.
pub(crate) const HOST_KEY_PATIENCE: Duration = Duration::from_secs(120);

/// What the commands share.
#[derive(Debug, Default)]
pub struct AppState {
    /// Shared hands on the one connection. The file listings use their hand
    /// while `connect`/`disconnect` move the slot itself.
    pub(crate) connection: AsyncMutex<Option<Arc<Connection>>>,
    pub(crate) question: Arc<HostKeyQuestion>,
}

/// The host-key question that a person is asked now.
#[derive(Debug, Default)]
pub(crate) struct HostKeyQuestion {
    /// The connection that asked, and the place for its answer, while the
    /// question is on screen.
    waiting: Mutex<Option<(String, oneshot::Sender<bool>)>>,
}

impl HostKeyQuestion {
    /// Waits for an answer from `connection`. This function replaces a question
    /// without an answer.
    pub(crate) fn open(&self, connection: &str, answer: oneshot::Sender<bool>) {
        let replaced = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace((connection.to_string(), answer));
        if replaced.is_some() {
            tracing::warn!("a host-key question was still open; the new one replaces it");
        }
    }

    /// Stops the wait, if there is no person to receive the question.
    ///
    /// This function drops the question of this connection only, as it takes the
    /// answer of this connection only. One connection at a time means that these
    /// are always the same question today. Nothing here must depend on that.
    pub(crate) fn close(&self, connection: &str) {
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
            Some((asked, _)) if asked == connection => {}
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

    #[tokio::test]
    async fn an_answer_for_another_connection_cannot_land() {
        // An abandoned question can leave its dialog on screen. A click on that
        // dialog must not answer the question that replaced it. The person did
        // not see the key of the new question.
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open("first", answer);

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
        question.open("first", answer);

        question.close("second");
        assert!(question.answer("first", true), "the question is still the first one's");
        assert!(decision.await.expect("the answer arrives"));

        let (answer, decision) = oneshot::channel();
        question.open("first", answer);
        question.close("first");
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
        question.open("main", answer);

        assert!(question.answer("main", true), "the waiting question was answered");
        assert!(decision.await.expect("the answer arrives"));
        assert!(!question.answer("main", false), "the second answer is late");
    }

    #[tokio::test]
    async fn a_question_nobody_answered_before_the_next_one_is_dropped() {
        let question = HostKeyQuestion::default();
        let (first, first_decision) = oneshot::channel();
        question.open("main", first);
        let (second, second_decision) = oneshot::channel();
        question.open("main", second);

        assert!(
            first_decision.await.is_err(),
            "a question that was replaced cannot be answered"
        );
        assert!(question.answer("main", true));
        assert!(second_decision.await.expect("the replacement is answered"));
    }
}
