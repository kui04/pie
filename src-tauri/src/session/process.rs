//! One `pi --mode rpc` process, and what pie asks of it.
//!
//! A session is a process, not a conversation: its id (`main:1`) names the pi
//! that pie started, and it holds the one conversation it was attached on
//! (`--session`). Therefore the files of pi's sessions and the processes that
//! write them are both "sessions", and they are two different things.
//!
//! Every read and every command of one session goes through the protocol client
//! that speaks to its process, so a failure below this type belongs to the layer
//! below it: the reach is [`host`](crate::host), the bytes are
//! [`channel`](crate::channel), and what pi answers is `pi_rpc`'s own error. None
//! of them is wrapped here.

use pi_rpc::client::{BashReq, Client, Config, PromptReq};
use pi_rpc::response::{BashResult, ClearQueueData, CompactionResult, EntryList, SessionState, SessionStats};
use pi_rpc::types::{ImageContent, Model, StreamingBehavior, ThinkingLevel};

use crate::channel::{Channel, Handle};
use crate::error::PieError;
use crate::host::HostPath;

use super::SessionInfo;
use super::id::Id;
use super::wire::{AvailableModelsData, AvailableThinkingLevelsData, CommandsData, LastAssistantTextData, PromptData};

/// The time for pi to stop before pie kills it.
///
/// Pi disposes its session when its standard input closes. Pie waits for that. A
/// kill leaves a half-written session file. Five seconds is longer than this step
/// needs, and short enough to look like an operation, not a hang. It is also the
/// client's own close deadline, so a close that runs out is one the kill below
/// ends.
pub(crate) const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// How long one request to pi may take before pie calls it lost.
///
/// Most commands answer from pi's own memory. Three of them run as long as the
/// work does: a prompt waits for its turn, a compaction for the summary, a shell
/// command for the command. Pie puts no timer on those - a person stops them with
/// `abort` or `abort_bash` - so this bound is a backstop for a wedged pi rather
/// than a deadline for the work, and it is a day.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// One `pi --mode rpc` process and the client that speaks to it.
///
/// A clone is another handle to the same process: the id, the directory, the
/// client and the watch of its end are all values a second hand can hold.
#[derive(Debug, Clone)]
pub struct Session {
    id: Id,
    /// The start of pi, if pie selected it. `None` means the directory of the
    /// login shell decided, or the machine has no home directory.
    cwd: Option<HostPath>,
    client: Client,
    /// The process or channel behind the client: whether it still runs, how to
    /// end it, and how to wait for its end.
    handle: Handle,
}

/// Starts the protocol client over a channel, and keeps a hand on its life.
///
/// The two travel together because neither is useful alone - the client owns the
/// records, the handle owns the process - and because the client's own deadline
/// for a close is the grace the session layer gives pi before it kills it.
///
/// # Panics
///
/// Without a Tokio runtime, like the client's own start: the read loop and the
/// watch of the channel both run in tasks.
pub(crate) fn speaking(channel: Channel) -> (Client, Handle) {
    let handle = channel.handle();
    let config = Config::default()
        .with_request_timeout(REQUEST_TIMEOUT)
        .with_close_timeout(SHUTDOWN_GRACE);
    (Client::with_config(channel, config), handle)
}

impl Session {
    /// Assembles a session from its id, its directory, and its started pi.
    pub(crate) fn new(id: Id, cwd: Option<HostPath>, client: Client, handle: Handle) -> Self {
        Self {
            id,
            cwd,
            client,
            handle,
        }
    }

    /// The id of this session, for the `pi://session/{id}/...` events.
    pub fn id(&self) -> &Id {
        &self.id
    }

    /// The start of pi, if pie selected it.
    pub fn cwd(&self) -> Option<&HostPath> {
        self.cwd.as_ref()
    }

    /// The client that speaks to the pi of this session.
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// The stream of what this session's pi says, as it says it.
    pub fn events(&self) -> pi_rpc::client::EventStream {
        self.client.subscribe()
    }

    /// The watch of the process or channel behind this session.
    pub fn handle(&self) -> &Handle {
        &self.handle
    }

    /// What the frontend is told about this session.
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            cwd: self.cwd.clone(),
        }
    }

    /// The state of this session: its model, its run, its name, its counts.
    ///
    /// Pi builds this answer from memory. It does not wait for the run in
    /// progress. Therefore this read is safe while a turn streams.
    ///
    /// # Errors
    ///
    /// The failure of the protocol: pi refuses the command, or its answer does
    /// not match the mirrored type, or the pi of this session is gone.
    pub async fn state(&self) -> Result<SessionState, PieError> {
        Ok(self.client.get_state().await?)
    }

    /// Every entry of this session, and the leaf the session points at.
    ///
    /// The answer is the raw set. It holds the entries of the other branches of
    /// a fork, and it keeps the entries that a compaction summarized. The view
    /// of the transcript - the path from the root to the leaf, with the
    /// compactions folded - is the task of the frontend.
    ///
    /// # Errors
    ///
    /// The same as [`Session::state`].
    pub async fn entries(&self) -> Result<EntryList, PieError> {
        Ok(self.client.get_entries(None).await?)
    }

    /// The usage of this session: its counts, its tokens, its cost.
    ///
    /// # Errors
    ///
    /// The same as [`Session::state`].
    pub async fn stats(&self) -> Result<SessionStats, PieError> {
        Ok(self.client.get_session_stats().await?)
    }

    /// Sends a message to this session: it starts a run when nothing streams, and
    /// when a run streams, `behavior` says how the message joins it.
    ///
    /// `images` are the pictures that the person attached to the message. Pi
    /// processes them itself (it resizes them and converts what it can), so pie
    /// passes them through as they were picked.
    ///
    /// Pi decides which of the two happened, and its answer says which it was:
    /// `disposition` is `started` for a run that began, `queued` for a message that
    /// waits in the queue, and `handled` for one that a command of an extension
    /// took without a run. A `behavior` while nothing streams is ignored, and the
    /// message starts a run (the `prompt` method of `core/agent-session.ts`).
    /// Therefore the frontend does not have to be right about the stream: it names
    /// the key that the person pressed.
    ///
    /// Pi refuses a prompt while a compaction runs, and one without a model or
    /// credentials. A refusal arrives as the protocol layer's own command failure,
    /// with pi's message.
    ///
    /// # Errors
    ///
    /// The failure of the protocol, including the refusals above.
    pub async fn prompt(
        &self,
        message: &str,
        images: Option<Vec<ImageContent>>,
        behavior: Option<StreamingBehavior>,
    ) -> Result<PromptData, PieError> {
        let disposition = self
            .client
            .prompt_with(PromptReq {
                message: message.to_string(),
                images,
                streaming_behavior: behavior,
            })
            .await?;
        Ok(PromptData { disposition })
    }

    /// Stops the run of this session, and a compaction or branch summary in
    /// progress with it.
    ///
    /// The answer arrives when the session is idle: pi waits for that (`abort` of
    /// `core/agent-session.ts`). The events that report the end of the run are
    /// therefore on their way when this returns. An abort with nothing to stop is
    /// not a failure.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn abort(&self) -> Result<(), PieError> {
        Ok(self.client.abort().await?)
    }

    /// Drops every queued message of this session and answers which ones they were.
    ///
    /// The protocol has no way to take back one message: this drops the steering
    /// queue and the follow-up queue together. The two lists of the answer let a
    /// screen say what went.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn clear_queue(&self) -> Result<ClearQueueData, PieError> {
        Ok(self.client.clear_queue().await?)
    }

    /// Runs a shell command on the machine of pi, in the directory of this
    /// session.
    ///
    /// The command runs through pi, so its result can enter the transcript like the
    /// result of a tool. While it runs, `bash_execution_update` events stream what it
    /// prints; [`Session::abort_bash`] stops it. `exclude_from_context` keeps the
    /// command and its output out of the context of the model (the `!!` form of the
    /// composer).
    ///
    /// The wait has no limit and needs none: `abort_bash` is the handle for a command
    /// that does not end, and the failure of the protocol reports a pi that went away.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn bash(&self, command: &str, exclude_from_context: bool) -> Result<BashResult, PieError> {
        Ok(self
            .client
            .bash_with(BashReq {
                command: command.to_string(),
                exclude_from_context: Some(exclude_from_context),
            })
            .await?)
    }

    /// Stops the shell command of this session, if one runs.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn abort_bash(&self) -> Result<(), PieError> {
        Ok(self.client.abort_bash().await?)
    }

    /// The commands that a prompt of this session can invoke.
    ///
    /// Pi answers the commands of its extensions, its prompt templates and its skills.
    /// Its own commands are not in this list: the client answers those itself
    /// (`BUILTIN_SLASH_COMMANDS` of `core/slash-commands.ts`).
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn commands(&self) -> Result<CommandsData, PieError> {
        Ok(CommandsData {
            commands: self.client.get_commands().await?,
        })
    }

    /// The models that this session can use.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn available_models(&self) -> Result<AvailableModelsData, PieError> {
        Ok(AvailableModelsData {
            models: self.client.get_available_models().await?,
        })
    }

    /// The thinking levels that this session accepts.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn available_thinking_levels(&self) -> Result<AvailableThinkingLevelsData, PieError> {
        Ok(AvailableThinkingLevelsData {
            levels: self.client.get_available_thinking_levels().await?,
        })
    }

    /// Selects the model of this session and answers the one that is now active.
    ///
    /// # Errors
    ///
    /// The failure of the protocol, including a model that pi does not know.
    pub async fn set_model(&self, provider: &str, model_id: &str) -> Result<Model, PieError> {
        Ok(self.client.set_model(provider, model_id).await?)
    }

    /// Sets the thinking level of this session.
    ///
    /// # Errors
    ///
    /// The failure of the protocol, including a level that the session does not support.
    pub async fn set_thinking_level(&self, level: ThinkingLevel) -> Result<(), PieError> {
        Ok(self.client.set_thinking_level(level).await?)
    }

    /// Turns automatic compaction of this session on or off.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn set_auto_compaction(&self, enabled: bool) -> Result<(), PieError> {
        Ok(self.client.set_auto_compaction(enabled).await?)
    }

    /// Compacts the conversation of this session into a summary, now.
    ///
    /// `custom_instructions` steers the summary. The answer arrives when pi has
    /// written it, and [`Session::abort`] stops it. Compaction reports itself on the
    /// event channel (`compaction_start`, `compaction_end`), so the transcript hears of
    /// it whether or not this call is the one that asked.
    ///
    /// # Errors
    ///
    /// The failure of the protocol, including a compaction that already runs.
    pub async fn compact(&self, custom_instructions: Option<&str>) -> Result<CompactionResult, PieError> {
        Ok(self.client.compact(custom_instructions).await?)
    }

    /// The text of the last assistant message of this session.
    ///
    /// Pi answers no `text` when the session has no assistant message.
    ///
    /// # Errors
    ///
    /// The failure of the protocol.
    pub async fn last_assistant_text(&self) -> Result<LastAssistantTextData, PieError> {
        Ok(LastAssistantTextData {
            text: self.client.get_last_assistant_text().await?,
        })
    }

    /// Names this session.
    ///
    /// # Errors
    ///
    /// The failure of the protocol, including an empty name, which pi refuses.
    pub async fn set_session_name(&self, name: &str) -> Result<(), PieError> {
        Ok(self.client.set_session_name(name).await?)
    }
}
