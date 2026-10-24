//! The host-key questions that wait for a person, one per connection.

use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
};

use tokio::sync::oneshot;

use crate::session::Id;

/// The host-key questions that a person is asked now.
#[derive(Debug, Default)]
pub struct HostKeyQuestion {
    waiting: Mutex<HashMap<Id, oneshot::Sender<bool>>>,
}

impl HostKeyQuestion {
    /// Waits for an answer from `connection`. A question that was already open for
    /// the same connection is replaced, and its sender is dropped.
    pub fn open(&self, connection: &Id, answer: oneshot::Sender<bool>) {
        let replaced = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(connection.clone(), answer);
        if replaced.is_some() {
            tracing::warn!(connection = %connection, "a host-key question was still open; the new one replaces it");
        }
    }

    /// Stops the wait of `connection`, if there is no person to receive it.
    pub fn close(&self, connection: &Id) {
        self.waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(connection);
    }

    /// Delivers an answer, if this connection waits for one.
    ///
    /// An abandoned question can leave its dialog on screen. A person who clicks
    /// that dialog must not answer the question that replaced it, because the
    /// person did not see the keys of the new question. A mismatched answer is
    /// ignored, and the question of the right connection stays open.
    pub fn answer(&self, connection: &str, trusted: bool) -> bool {
        let answer = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(connection);
        match answer {
            Some(answer) => answer.send(trusted).is_ok(),
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

    #[tokio::test]
    async fn an_answer_for_another_connection_cannot_land() {
        let question = HostKeyQuestion::default();
        let (answer, decision) = oneshot::channel();
        question.open(&connection("first"), answer);

        assert!(!question.answer("second", true), "that is not the connection asking");
        assert!(question.answer("first", true), "the connection that asked still can");
        assert!(decision.await.expect("the answer arrives"));
    }

    #[tokio::test]
    async fn two_connections_wait_at_once() {
        let question = HostKeyQuestion::default();
        let (first, first_decision) = oneshot::channel();
        let (second, mut second_decision) = oneshot::channel();
        question.open(&connection("first"), first);
        question.open(&connection("second"), second);

        assert!(question.answer("first", true), "the first question is answered");
        assert!(first_decision.await.expect("the first answer arrives"));
        assert!(
            matches!(
                second_decision.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "the question of the other connection still waits"
        );
        assert!(question.answer("second", false), "the second question is answered");
        assert!(!second_decision.await.expect("the second answer arrives"));
    }

    #[tokio::test]
    async fn a_question_is_only_closed_by_the_connection_that_asked_it() {
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
