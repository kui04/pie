//! What the commands share.
//!
//! One host at a time is what the product needs, so the connection is a single
//! slot, and the slot's lock is what keeps two `connect`s from racing for it.
//! The question a person is being asked lives in a lock of its own, *not*
//! inside that slot: `connect` holds the slot from the moment it starts until
//! it is connected, and on first contact it spends that time waiting for the
//! answer to exactly this question - so one lock for both would deadlock, and a
//! separate one is what lets an answer arrive while the connection is being
//! made.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::connection::Connection;

/// How long a person has to answer a host-key question.
///
/// Nothing else bounds that wait: the transport's own host-key step is
/// unbounded by design, because it is the one place a person is involved. A
/// dialog that is dismissed, or a frontend that goes away mid-question, would
/// otherwise hold `connect` - and the connection slot it locked - forever, with
/// no way out but restarting pie. Long enough to compare a fingerprint by eye.
pub(crate) const HOST_KEY_PATIENCE: Duration = Duration::from_secs(120);

/// What the commands share.
#[derive(Debug, Default)]
pub struct AppState {
    /// Shared hands on the one connection: the file listings run on theirs
    /// while `connect`/`disconnect` keep the slot itself moving.
    pub(crate) connection: AsyncMutex<Option<Arc<Connection>>>,
    pub(crate) question: Arc<HostKeyQuestion>,
}

/// The host-key question a person is being asked right now.
#[derive(Debug, Default)]
pub(crate) struct HostKeyQuestion {
    /// Which connection asked, and where its answer goes, while the question is
    /// on screen.
    waiting: Mutex<Option<(String, oneshot::Sender<bool>)>>,
}

impl HostKeyQuestion {
    /// Starts waiting for an answer from `connection`, replacing a question
    /// nobody answered.
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

    /// Stops waiting, when the question could not be put to anyone.
    ///
    /// Only this connection's question is dropped, the way only this
    /// connection's answer is taken: one connection at a time means those are
    /// always the same question today, but nothing here has to rely on that.
    pub(crate) fn close(&self, connection: &str) {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        if waiting.as_ref().is_some_and(|(asked, _)| asked == connection) {
            waiting.take();
        }
    }

    /// Delivers an answer, if this connection is the one waiting for one.
    ///
    /// A question that was abandoned can leave its dialog on screen, and a
    /// person clicking that one must not be answering the question that
    /// replaced it: the keys they were shown are not the keys being asked
    /// about. A mismatched answer is ignored rather than delivered, and the
    /// question it did not belong to stays open for the answer that does.
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
        // An abandoned question can leave its dialog on screen; clicking it then
        // must not answer the question that replaced it, whose key the person
        // has not seen.
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open("first", answer);

        assert!(!question.answer("second", true), "that is not the connection asking");
        assert!(question.answer("first", true), "the connection that asked still can");
        assert!(decision.await.expect("the answer arrives"));
    }

    #[tokio::test]
    async fn a_question_is_only_closed_by_the_connection_that_asked_it() {
        // Symmetric with answering: dropping a question that could not be put to
        // anyone must not be able to drop somebody else's.
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
