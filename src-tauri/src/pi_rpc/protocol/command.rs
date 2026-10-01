//! Commands sent to pi on stdin.
//!
//! Mirrors `RpcCommand` from `packages/coding-agent/src/modes/rpc/rpc-types.ts`.
//! The `type` tag is snake_case and payload fields are camelCase, exactly as pi
//! writes them.

use serde::{Deserialize, Serialize};

use super::message::ImageContent;
use super::model::ModelThinkingLevel;

/// A command record for stdin (`RpcCommand`).
///
/// `id` is pi's correlation field - optional, and omitted from the wire when it
/// is `None`, which is what makes a command fire-and-forget. Prefer
/// [`crate::pi_rpc::Client::request`], which assigns an id and awaits the matching
/// response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Command {
    /// Correlation id. Omitted from the wire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The command itself.
    #[serde(flatten)]
    pub kind: CommandKind,
}

impl Command {
    /// Wraps a command body without an id.
    pub fn new(kind: CommandKind) -> Self {
        Self { id: None, kind }
    }

    /// Sets the correlation id.
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    /// Name pi echoes back in the matching response.
    pub fn name(&self) -> &'static str {
        self.kind.name()
    }
}

impl From<CommandKind> for Command {
    fn from(kind: CommandKind) -> Self {
        Self::new(kind)
    }
}

/// How pi queues a message that arrives while the agent is streaming.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum StreamingBehavior {
    /// Interrupt the current run and insert the message.
    Steer,
    /// Wait until the current run settles.
    FollowUp,
}

/// Queue drain mode for steering and follow-up messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum QueueMode {
    /// Drain the whole queue at once.
    All,
    /// Drain one message at a time.
    OneAtATime,
}

/// The tagged body of a [`Command`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[non_exhaustive]
pub enum CommandKind {
    /// Submit a user message.
    Prompt {
        /// The message text.
        message: String,
        /// Image attachments.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageContent>>,
        /// How to queue the message when the agent is streaming.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<StreamingBehavior>,
    },
    /// Insert a message into the running turn.
    Steer {
        /// The message text.
        message: String,
        /// Image attachments.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageContent>>,
    },
    /// Queue a message for after the running turn.
    FollowUp {
        /// The message text.
        message: String,
        /// Image attachments.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageContent>>,
    },
    /// Stop the running turn.
    Abort,
    /// Drop every queued message.
    ClearQueue,
    /// Start a new session, optionally forked from a parent session.
    NewSession {
        /// Parent session to inherit context from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_session: Option<String>,
    },
    /// Read the session state.
    GetState,
    /// Select the active model.
    SetModel {
        /// Provider id.
        provider: String,
        /// Model id.
        model_id: String,
    },
    /// Switch to the next scoped model.
    CycleModel,
    /// List the models pi can use.
    GetAvailableModels,
    /// Set the thinking level.
    SetThinkingLevel {
        /// The level to use.
        level: ModelThinkingLevel,
    },
    /// Switch to the next thinking level.
    CycleThinkingLevel,
    /// List the thinking levels this session supports.
    GetAvailableThinkingLevels,
    /// Choose how steering messages are drained.
    SetSteeringMode {
        /// Queue drain mode.
        mode: QueueMode,
    },
    /// Choose how follow-up messages are drained.
    SetFollowUpMode {
        /// Queue drain mode.
        mode: QueueMode,
    },
    /// Compact the conversation into a summary.
    Compact {
        /// Instructions for the summarizer.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
    /// Enable or disable automatic compaction.
    SetAutoCompaction {
        /// Whether automatic compaction is on.
        enabled: bool,
    },
    /// Enable or disable automatic retries.
    SetAutoRetry {
        /// Whether automatic retries are on.
        enabled: bool,
    },
    /// Cancel a pending automatic retry.
    AbortRetry,
    /// Run a shell command through pi.
    Bash {
        /// The command line.
        command: String,
        /// Whether the result stays out of the model context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exclude_from_context: Option<bool>,
    },
    /// Stop the running shell command.
    AbortBash,
    /// Read aggregate session statistics.
    GetSessionStats,
    /// Export the session as HTML.
    ExportHtml {
        /// File to write; pi picks a path when omitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_path: Option<String>,
    },
    /// Continue an existing session file.
    SwitchSession {
        /// Path of the session file.
        session_path: String,
    },
    /// Fork the session at an entry.
    Fork {
        /// Entry to fork from.
        entry_id: String,
    },
    /// Duplicate the session at its current point.
    Clone,
    /// List the entries a fork can start from.
    GetForkMessages,
    /// Read session entries.
    GetEntries {
        /// Only return entries after this id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    /// Read the session tree.
    GetTree,
    /// Read the text of the last assistant message.
    GetLastAssistantText,
    /// Set the session display name.
    SetSessionName {
        /// The new name.
        name: String,
    },
    /// Read the conversation messages.
    GetMessages,
    /// List the commands a prompt can invoke.
    GetCommands,
}

impl CommandKind {
    /// Name pi echoes back in the matching response.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Prompt { .. } => "prompt",
            Self::Steer { .. } => "steer",
            Self::FollowUp { .. } => "follow_up",
            Self::Abort => "abort",
            Self::ClearQueue => "clear_queue",
            Self::NewSession { .. } => "new_session",
            Self::GetState => "get_state",
            Self::SetModel { .. } => "set_model",
            Self::CycleModel => "cycle_model",
            Self::GetAvailableModels => "get_available_models",
            Self::SetThinkingLevel { .. } => "set_thinking_level",
            Self::CycleThinkingLevel => "cycle_thinking_level",
            Self::GetAvailableThinkingLevels => "get_available_thinking_levels",
            Self::SetSteeringMode { .. } => "set_steering_mode",
            Self::SetFollowUpMode { .. } => "set_follow_up_mode",
            Self::Compact { .. } => "compact",
            Self::SetAutoCompaction { .. } => "set_auto_compaction",
            Self::SetAutoRetry { .. } => "set_auto_retry",
            Self::AbortRetry => "abort_retry",
            Self::Bash { .. } => "bash",
            Self::AbortBash => "abort_bash",
            Self::GetSessionStats => "get_session_stats",
            Self::ExportHtml { .. } => "export_html",
            Self::SwitchSession { .. } => "switch_session",
            Self::Fork { .. } => "fork",
            Self::Clone => "clone",
            Self::GetForkMessages => "get_fork_messages",
            Self::GetEntries { .. } => "get_entries",
            Self::GetTree => "get_tree",
            Self::GetLastAssistantText => "get_last_assistant_text",
            Self::SetSessionName { .. } => "set_session_name",
            Self::GetMessages => "get_messages",
            Self::GetCommands => "get_commands",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omits_the_id_and_uses_camel_case_payload_fields() {
        let command = Command::new(CommandKind::SetModel {
            provider: "anthropic".to_string(),
            model_id: "claude".to_string(),
        });
        assert_eq!(
            serde_json::to_string(&command).unwrap(),
            r#"{"type":"set_model","provider":"anthropic","modelId":"claude"}"#
        );
    }

    #[test]
    fn round_trips_every_tag_style() {
        let commands = [
            r#"{"type":"get_state"}"#,
            r#"{"id":"7","type":"set_steering_mode","mode":"one-at-a-time"}"#,
            r#"{"type":"prompt","message":"hi","streamingBehavior":"followUp"}"#,
            r#"{"type":"bash","command":"ls","excludeFromContext":true}"#,
            r#"{"type":"compact","customInstructions":"be terse"}"#,
        ];
        for wire in commands {
            let command: Command = serde_json::from_str(wire).unwrap();
            assert_eq!(serde_json::to_string(&command).unwrap(), wire);
        }
    }

    /// Every variant must serialize to the tag its own `name()` reports: request
    /// correlation and the timeout error both rely on that agreement.
    #[test]
    fn every_variant_round_trips_under_its_reported_name() {
        let variants = [
            CommandKind::Prompt {
                message: "m".to_string(),
                images: None,
                streaming_behavior: Some(StreamingBehavior::Steer),
            },
            CommandKind::Steer {
                message: "m".to_string(),
                images: None,
            },
            CommandKind::FollowUp {
                message: "m".to_string(),
                images: None,
            },
            CommandKind::Abort,
            CommandKind::ClearQueue,
            CommandKind::NewSession { parent_session: None },
            CommandKind::GetState,
            CommandKind::SetModel {
                provider: "anthropic".to_string(),
                model_id: "claude".to_string(),
            },
            CommandKind::CycleModel,
            CommandKind::GetAvailableModels,
            CommandKind::SetThinkingLevel {
                level: ModelThinkingLevel::High,
            },
            CommandKind::CycleThinkingLevel,
            CommandKind::GetAvailableThinkingLevels,
            CommandKind::SetSteeringMode {
                mode: QueueMode::OneAtATime,
            },
            CommandKind::SetFollowUpMode { mode: QueueMode::All },
            CommandKind::Compact {
                custom_instructions: None,
            },
            CommandKind::SetAutoCompaction { enabled: true },
            CommandKind::SetAutoRetry { enabled: false },
            CommandKind::AbortRetry,
            CommandKind::Bash {
                command: "ls".to_string(),
                exclude_from_context: None,
            },
            CommandKind::AbortBash,
            CommandKind::GetSessionStats,
            CommandKind::ExportHtml { output_path: None },
            CommandKind::SwitchSession {
                session_path: "/tmp/s".to_string(),
            },
            CommandKind::Fork {
                entry_id: "e1".to_string(),
            },
            CommandKind::Clone,
            CommandKind::GetForkMessages,
            CommandKind::GetEntries { since: None },
            CommandKind::GetTree,
            CommandKind::GetLastAssistantText,
            CommandKind::SetSessionName { name: "n".to_string() },
            CommandKind::GetMessages,
            CommandKind::GetCommands,
        ];
        // Transcribed from `RpcCommand` in
        // `packages/coding-agent/src/modes/rpc/rpc-types.ts`: a known answer, so a
        // renamed or dropped tag fails here instead of being silently accepted by
        // pi, which ignores unknown fields and does not validate tag values.
        let documented = [
            "abort",
            "abort_bash",
            "abort_retry",
            "bash",
            "clear_queue",
            "clone",
            "compact",
            "cycle_model",
            "cycle_thinking_level",
            "export_html",
            "follow_up",
            "fork",
            "get_available_models",
            "get_available_thinking_levels",
            "get_commands",
            "get_entries",
            "get_fork_messages",
            "get_last_assistant_text",
            "get_messages",
            "get_session_stats",
            "get_state",
            "get_tree",
            "new_session",
            "prompt",
            "set_auto_compaction",
            "set_auto_retry",
            "set_follow_up_mode",
            "set_model",
            "set_session_name",
            "set_steering_mode",
            "set_thinking_level",
            "steer",
            "switch_session",
        ];
        let mut reported: Vec<&str> = variants.iter().map(CommandKind::name).collect();
        reported.sort_unstable();
        assert_eq!(reported, documented, "the command mirror matches rpc-types.ts");

        for kind in variants {
            let name = kind.name();
            let command = Command::new(kind);
            let wire = serde_json::to_value(&command).unwrap();

            assert_eq!(wire["type"], name, "`name()` disagrees with the serialized tag");
            assert!(wire.get("id").is_none(), "an unawaited command carries no id");

            let parsed: Command = serde_json::from_value(wire).unwrap();
            assert_eq!(parsed, command, "`{name}` does not round-trip");
        }
    }
}
