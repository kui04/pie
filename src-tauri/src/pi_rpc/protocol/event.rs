//! Events streamed from pi on stdout.
//!
//! Mirrors `JsonAgentSessionEvent` (`packages/coding-agent/src/modes/json-event.ts`),
//! which is `AgentSessionEvent` minus the cumulative `partial` snapshot pi strips
//! from `message_update` deltas, plus the streamed `usage` and the `id`/`toolName`
//! pi adds to `toolcall_start`. Events are bare records - there is no envelope.
//!
//! An event type this crate does not know degrades to
//! [`crate::pi_rpc::protocol::ServerMessage::Unknown`], never to a broken connection.

use serde::{Deserialize, Serialize};

use super::message::{AgentMessage, AssistantMessage, StopReason, ToolCall, ToolResultMessage};
use super::misc::CompactionResult;
use super::model::{ModelThinkingLevel, Usage};
use super::session_entry::SessionEntry;

/// Why pi compacted the conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum CompactionReason {
    /// Requested by the client.
    Manual,
    /// The context crossed the compaction threshold.
    Threshold,
    /// The provider rejected the request for exceeding the context window.
    Overflow,
}

/// Why an assistant response finished normally (`done` event).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum DoneReason {
    /// Natural stop.
    #[serde(rename = "stop")]
    Stop,
    /// Output token limit reached.
    #[serde(rename = "length")]
    Length,
    /// The model requested tools.
    #[serde(rename = "toolUse")]
    ToolUse,
    /// Deferred to a later turn.
    #[serde(rename = "deferred")]
    Deferred,
}

/// Why an assistant response failed (`error` event).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum ErrorReason {
    /// Aborted by the client.
    #[serde(rename = "aborted")]
    Aborted,
    /// Provider error.
    #[serde(rename = "error")]
    Error,
}

/// A streaming update inside a `message_update` event
/// (`JsonMessageUpdateEvent["assistantMessageEvent"]`).
///
/// The cumulative `partial` message is not on the wire; the deltas are, and
/// `message_start` / `message_end` bracket them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[non_exhaustive]
pub enum AssistantMessageEvent {
    /// The response began.
    Start,
    /// A text part began.
    TextStart {
        /// Index of the part in the message content.
        content_index: u32,
    },
    /// Text was appended.
    TextDelta {
        /// Index of the part in the message content.
        content_index: u32,
        /// The appended text.
        delta: String,
    },
    /// A text part finished.
    TextEnd {
        /// Index of the part in the message content.
        content_index: u32,
        /// The complete text of the part.
        content: String,
    },
    /// A reasoning part began.
    ThinkingStart {
        /// Index of the part in the message content.
        content_index: u32,
    },
    /// Reasoning text was appended.
    ThinkingDelta {
        /// Index of the part in the message content.
        content_index: u32,
        /// The appended reasoning text.
        delta: String,
    },
    /// A reasoning part finished.
    ThinkingEnd {
        /// Index of the part in the message content.
        content_index: u32,
        /// The complete reasoning text of the part.
        content: String,
    },
    /// A tool call began; `id` and `tool_name` come from the partial message.
    ToolcallStart {
        /// Index of the part in the message content.
        content_index: u32,
        /// Id of the tool call being streamed.
        id: String,
        /// Name of the tool being called.
        tool_name: String,
    },
    /// Tool call arguments were appended.
    ToolcallDelta {
        /// Index of the part in the message content.
        content_index: u32,
        /// The appended argument fragment.
        delta: String,
    },
    /// A tool call finished.
    ToolcallEnd {
        /// Index of the part in the message content.
        content_index: u32,
        /// The complete tool call.
        tool_call: ToolCall,
    },
    /// The response finished.
    Done {
        /// Why it finished.
        reason: DoneReason,
        /// The final assistant message.
        message: AssistantMessage,
    },
    /// The response failed.
    Error {
        /// Why it failed.
        reason: ErrorReason,
        /// The failed assistant message.
        error: AssistantMessage,
    },
}

/// What produced a summarization retry (`summarization_retry_attempt_start`).
///
/// Pi emits two shapes for this event; the tag is `source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[non_exhaustive]
pub enum SummarizationRetrySource {
    /// A branch summary.
    BranchSummary,
    /// A compaction.
    Compaction {
        /// Why compaction ran.
        reason: CompactionReason,
    },
}

/// One event from pi's session event stream (`JsonAgentSessionEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[non_exhaustive]
pub enum Event {
    /// A run started.
    AgentStart,
    /// A run ended.
    AgentEnd {
        /// Messages produced by the run.
        messages: Vec<AgentMessage>,
        /// Whether pi will retry the run.
        will_retry: bool,
    },
    /// A turn started: one assistant response plus the tool calls it made.
    TurnStart,
    /// A turn ended.
    TurnEnd {
        /// The assistant message of the turn.
        message: AgentMessage,
        /// Tool results of the turn.
        tool_results: Vec<ToolResultMessage>,
    },
    /// A message was added to the transcript.
    MessageStart {
        /// The message.
        message: AgentMessage,
    },
    /// An assistant message is streaming.
    MessageUpdate {
        /// Cumulative usage of the response.
        usage: Usage,
        /// The streaming delta.
        assistant_message_event: AssistantMessageEvent,
    },
    /// A message finished.
    MessageEnd {
        /// The final message.
        message: AgentMessage,
    },
    /// A tool call started.
    ToolExecutionStart {
        /// Id of the call.
        tool_call_id: String,
        /// Name of the tool.
        tool_name: String,
        /// Validated arguments.
        args: serde_json::Value,
        /// Calling tool, when the call came from another tool.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    /// A tool call streamed a partial result.
    ToolExecutionUpdate {
        /// Id of the call.
        tool_call_id: String,
        /// Name of the tool.
        tool_name: String,
        /// Validated arguments.
        args: serde_json::Value,
        /// The partial result.
        partial_result: serde_json::Value,
        /// Calling tool, when the call came from another tool.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    /// A tool call finished.
    ToolExecutionEnd {
        /// Id of the call.
        tool_call_id: String,
        /// Name of the tool.
        tool_name: String,
        /// The tool result.
        result: serde_json::Value,
        /// Whether the tool failed.
        is_error: bool,
        /// Calling tool, when the call came from another tool.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    /// The agent became idle and every listener finished.
    AgentSettled,
    /// The queue of steering and follow-up messages changed.
    QueueUpdate {
        /// Queued steering messages.
        steering: Vec<String>,
        /// Queued follow-up messages.
        follow_up: Vec<String>,
    },
    /// Compaction started.
    CompactionStart {
        /// Why it ran.
        reason: CompactionReason,
    },
    /// Compaction finished.
    CompactionEnd {
        /// Why it ran.
        reason: CompactionReason,
        /// The summary, absent when compaction produced none.
        result: Option<CompactionResult>,
        /// Whether it was aborted.
        aborted: bool,
        /// Whether pi will retry.
        will_retry: bool,
        /// Error text when it failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
    /// An entry was appended to the session.
    EntryAppended {
        /// The appended entry.
        entry: SessionEntry,
    },
    /// The session display name changed.
    SessionInfoChanged {
        /// The new name; absent when the name was cleared.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    /// The thinking level changed.
    ThinkingLevelChanged {
        /// The new level.
        level: ModelThinkingLevel,
    },
    /// An automatic retry was scheduled.
    AutoRetryStart {
        /// Attempt number.
        attempt: u32,
        /// Maximum attempts.
        max_attempts: u32,
        /// Delay before the attempt.
        delay_ms: u64,
        /// Error that triggered the retry.
        error_message: String,
    },
    /// An automatic retry finished.
    AutoRetryEnd {
        /// Whether the retry succeeded.
        success: bool,
        /// Attempt number.
        attempt: u32,
        /// Final error when the retries were exhausted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_error: Option<String>,
    },
    /// A summarization retry was scheduled.
    SummarizationRetryScheduled {
        /// Attempt number.
        attempt: u32,
        /// Maximum attempts.
        max_attempts: u32,
        /// Delay before the attempt.
        delay_ms: u64,
        /// Error that triggered the retry.
        error_message: String,
    },
    /// A summarization retry attempt started.
    SummarizationRetryAttemptStart {
        /// What is being summarized.
        #[serde(flatten)]
        source: SummarizationRetrySource,
    },
    /// Summarization retries finished.
    SummarizationRetryFinished,
    /// A shell command streamed output.
    BashExecutionUpdate {
        /// Id of the bash execution, when pi assigned one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// The streamed output fragment.
        delta: String,
    },
}

/// Stop reason of a failed message, for consumers that want the full union.
impl From<ErrorReason> for StopReason {
    fn from(reason: ErrorReason) -> Self {
        match reason {
            ErrorReason::Aborted => Self::Aborted,
            ErrorReason::Error => Self::Error,
        }
    }
}

/// Stop reason of a finished message, for consumers that want the full union.
impl From<DoneReason> for StopReason {
    fn from(reason: DoneReason) -> Self {
        match reason {
            DoneReason::Stop => Self::Stop,
            DoneReason::Length => Self::Length,
            DoneReason::ToolUse => Self::ToolUse,
            DoneReason::Deferred => Self::Deferred,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_streaming_delta_without_a_partial_message() {
        let wire = r#"{"type":"message_update","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hi"}}"#;
        let event: Event = serde_json::from_str(wire).unwrap();
        match event {
            Event::MessageUpdate {
                assistant_message_event: AssistantMessageEvent::TextDelta { content_index, delta },
                ..
            } => {
                assert_eq!(content_index, 0);
                assert_eq!(delta, "hi");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn parses_both_summarization_retry_shapes() {
        let branch: Event =
            serde_json::from_str(r#"{"type":"summarization_retry_attempt_start","source":"branchSummary"}"#).unwrap();
        assert!(matches!(
            branch,
            Event::SummarizationRetryAttemptStart {
                source: SummarizationRetrySource::BranchSummary
            }
        ));

        let compaction: Event = serde_json::from_str(
            r#"{"type":"summarization_retry_attempt_start","source":"compaction","reason":"overflow"}"#,
        )
        .unwrap();
        assert!(matches!(
            compaction,
            Event::SummarizationRetryAttemptStart {
                source: SummarizationRetrySource::Compaction {
                    reason: CompactionReason::Overflow
                }
            }
        ));
    }

    #[test]
    fn keeps_the_flat_event_shape() {
        let wire = r#"{"type":"queue_update","steering":[],"followUp":["a"]}"#;
        let event: Event = serde_json::from_str(wire).unwrap();
        assert_eq!(serde_json::to_string(&event).unwrap(), wire);
    }
}
