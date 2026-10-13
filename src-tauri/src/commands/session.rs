//! What a session of pi is asked to do: read it, speak through it, and end it.
//!
//! Everything here names one session, and every name is the id that the connect
//! answered with (`ConnectionInfo.sessions[].id`). That id is pie's own for a
//! pi process (`main:1`); it is not the session id of pi, which is the id of the
//! conversation file that a session was attached on.
//!
//! The reads and the commands of one session are in one file because one
//! responsible thing answers them: the session, and behind it its pi process. A
//! caller that wants the effect of a change watches the events of the session,
//! not the answers of these commands: `pipe.rs` forwards them.
//!
//! A read runs on a shared hand, not on the connection slot. The slot must stay
//! free for `disconnect`.
//!
//! A command fails as the layer that owns the failure: no connection or no such
//! session is [`crate::commands::Error`] or [`crate::session::Error`], and everything below
//! is the protocol layer's own errors. Neither is wrapped here.

use tauri::{AppHandle, State};

use crate::error::PieError;
use crate::host::HostPath;
use crate::session::{self, CommandsData, LastAssistantTextData, PromptData, Session, SessionInfo, SessionSummary};

use pi_rpc::response::{BashResult, ClearQueueData, CompactionResult, EntryList, SessionState, SessionStats};
use pi_rpc::types::{ImageContent, Model, StreamingBehavior, ThinkingLevel};

use super::Error;
use super::pipe;
use crate::state::AppState;

/// The session that a command names.
///
/// The clone is another hand to the same pi process, not a session of its own.
///
/// # Errors
///
/// [`Error::NotConnected`] when there is no connection, and
/// [`session::Error::UnknownSession`] when the id belongs to no session of this
/// connection.
async fn named_session(state: &AppState, session: &str, doing: &str) -> Result<Session, PieError> {
    let sessions = state.sessions.lock().await.clone().ok_or_else(|| Error::NotConnected {
        doing: doing.to_string(),
    })?;
    sessions.session(session).ok_or_else(|| {
        session::Error::UnknownSession {
            id: session.to_string(),
        }
        .into()
    })
}

/// Every conversation that pi wrote on the connected machine.
///
/// The rows are the conversation files of pi, not the pi processes pie runs: a
/// session that has said nothing yet has no file, and therefore no row. No pi
/// process is needed for this read: the listing is files.
///
/// # Errors
///
/// [`Error::NotConnected`] if there is no machine to list, and the failure of the
/// machine if pie cannot read the sessions directory.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, PieError> {
    let sessions = state.sessions.lock().await.clone().ok_or_else(|| Error::NotConnected {
        doing: "listing its sessions".to_string(),
    })?;
    sessions.summaries().await
}

/// Starts a pi on the connected machine, and answers with the session it speaks
/// through.
///
/// The frontend asks for this when it needs to speak: on the workspace, or when
/// a person opens a conversation. Nothing about the connection is needed for the
/// listing of conversations, so a machine that is only browsed runs no pi.
///
/// `path` names the conversation file of pi to load at the start (`--session`).
/// Without one pi starts a new conversation; it creates the file at the first
/// message. A conversation belongs to one process: a pi that moved between files
/// would leave records of the left file in the machine of the next one.
/// The id of the answer is pie's own for this pi process (`main:1`), and it is
/// the name of the events of the session (`pi://session/{id}/...`). It is not the
/// session id of pi, which is the id of the conversation file.
///
/// # Errors
///
/// [`Error::NotConnected`] if there is no machine to start pi on, and
/// [`PieError::Channel`] when pi cannot be started.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn attach_session(
    state: State<'_, AppState>,
    app: AppHandle,
    path: Option<String>,
) -> Result<SessionInfo, PieError> {
    let sessions = state.sessions.lock().await.clone().ok_or_else(|| Error::NotConnected {
        doing: "starting pi".to_string(),
    })?;
    let conversation = path.map(HostPath::new);
    let session = sessions
        .attach(state.next_session_number(), conversation.as_ref())
        .await?;
    // The subscription happens before the task starts, not inside it, so the pipe
    // itself misses nothing that pi writes after this line.
    //
    // What the frontend hears is another matter: its listener can only start after
    // the answer of this command, because that answer is where it reads the id of
    // the session. What pi wrote before then is lost, and lost in silence - the
    // module of [`pipe`] carries the whole of that.
    pipe::forward(app, &session, session.events());
    pipe::answer_dialogs(&session).await;
    Ok(session.info())
}

/// Ends one pi. The machine stays reached, and the conversation file stays.
///
/// The frontend asks for this when it is done speaking through that session. A
/// new session speaks again: a pick attaches one on the conversation file it
/// names, so a process never leaves the conversation it opened with.
///
/// # Errors
///
/// [`Error::NotConnected`] if there is no machine, and
/// [`session::Error::UnknownSession`] when the id belongs to no session of this
/// connection.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn detach_session(state: State<'_, AppState>, session: String) -> Result<(), PieError> {
    let sessions = state.sessions.lock().await.clone().ok_or_else(|| Error::NotConnected {
        doing: "ending the session".to_string(),
    })?;
    sessions.detach(&session).await
}

/// The state of one session: its model, its run, its name, its counts.
///
/// # Errors
///
/// [`Error::NotConnected`] and [`session::Error::UnknownSession`], and the
/// failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_state(state: State<'_, AppState>, session: String) -> Result<SessionState, PieError> {
    named_session(&state, &session, "reading the state of a session")
        .await?
        .state()
        .await
}

/// Every entry of one session, and the leaf it points at.
///
/// The entries are the raw set: other branches of a fork are in it, and the
/// entries that a compaction summarized stay in it. The frontend builds the view
/// of the transcript from this.
///
/// # Errors
///
/// The same as [`get_state`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_entries(state: State<'_, AppState>, session: String) -> Result<EntryList, PieError> {
    named_session(&state, &session, "reading the transcript of a session")
        .await?
        .entries()
        .await
}

/// The usage of one session: its counts, its tokens, its cost, its context.
///
/// # Errors
///
/// The same as [`get_state`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_session_stats(state: State<'_, AppState>, session: String) -> Result<SessionStats, PieError> {
    named_session(&state, &session, "reading the usage of a session")
        .await?
        .stats()
        .await
}

/// Switches one session to another conversation, in another session file.
///
/// The file is one that [`list_sessions`] gave back, by its `path`. The pi process
/// of this session keeps running; it opens the file and continues from the leaf of
/// that conversation. Pie never builds such a path: pi opens one that holds no file
/// as a new conversation in its own directory.
///
/// Sends a message to one session.
///
/// `behavior` names how the message joins a run that streams: `steer` interrupts
/// the run at its next step, and `followUp` waits for the run to settle. While
/// nothing streams, pi ignores the behavior and the message starts a run.
/// Therefore a caller does not have to be right about the stream: it names the key
/// that the person pressed.
///
/// `images` are the pictures of the message, as [`super::pick::pick_images`]
/// answered them; pi processes them itself.
///
/// The answer says what happened: `started`, `queued`, or `handled` for a message
/// that a command of an extension took without a run.
///
/// # Errors
///
/// [`Error::NotConnected`], [`session::Error::UnknownSession`], and the failure of
/// the protocol - including a refusal of pi itself: no model, no credentials, or a
/// compaction in progress.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, chars = message.chars().count(), images = images.as_ref().map_or(0, Vec::len), behavior = ?behavior))]
pub async fn prompt(
    state: State<'_, AppState>,
    session: String,
    message: String,
    images: Option<Vec<ImageContent>>,
    behavior: Option<StreamingBehavior>,
) -> Result<PromptData, PieError> {
    named_session(&state, &session, "sending a message to a session")
        .await?
        .prompt(&message, images, behavior)
        .await
}

/// Stops the run of one session, and a compaction in progress with it.
///
/// The answer arrives when the session is idle. The events of the end of the run
/// are on their way when it does.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn abort(state: State<'_, AppState>, session: String) -> Result<(), PieError> {
    named_session(&state, &session, "stopping the run of a session")
        .await?
        .abort()
        .await
}

/// Drops every queued message of one session.
///
/// The answer carries the two queues that were dropped: `steering` and
/// `followUp`. The protocol has no way to take back one message.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn clear_queue(state: State<'_, AppState>, session: String) -> Result<ClearQueueData, PieError> {
    named_session(&state, &session, "clearing the queue of a session")
        .await?
        .clear_queue()
        .await
}

/// Runs a shell command on the machine of one session, in the directory of that
/// session.
///
/// The command runs through pi, so its result enters the transcript like the result
/// of a tool. While it runs, `bash_execution_update` events stream what it prints.
/// `exclude_from_context` keeps the command and its output out of the context of
/// the model (the `!!` form of the composer).
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, chars = command.chars().count(), excluded = exclude_from_context))]
pub async fn bash(
    state: State<'_, AppState>,
    session: String,
    command: String,
    exclude_from_context: bool,
) -> Result<BashResult, PieError> {
    named_session(&state, &session, "running a shell command in a session")
        .await?
        .bash(&command, exclude_from_context)
        .await
}

/// Stops the shell command of one session, if one runs.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn abort_bash(state: State<'_, AppState>, session: String) -> Result<(), PieError> {
    named_session(&state, &session, "stopping the shell command of a session")
        .await?
        .abort_bash()
        .await
}

/// The commands that a prompt of one session can invoke.
///
/// The answer holds the commands of the extensions, the prompt templates and the
/// skills of pi. The built-in commands of pi are not in it: the frontend answers
/// those itself.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_commands(state: State<'_, AppState>, session: String) -> Result<CommandsData, PieError> {
    named_session(&state, &session, "reading the commands of a session")
        .await?
        .commands()
        .await
}

/// The models that one session can use.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_available_models(
    state: State<'_, AppState>,
    session: String,
) -> Result<session::AvailableModelsData, PieError> {
    named_session(&state, &session, "reading the models of a session")
        .await?
        .available_models()
        .await
}

/// The thinking levels that one session accepts.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_available_thinking_levels(
    state: State<'_, AppState>,
    session: String,
) -> Result<session::AvailableThinkingLevelsData, PieError> {
    named_session(&state, &session, "reading the thinking levels of a session")
        .await?
        .available_thinking_levels()
        .await
}

/// Selects the model of one session and answers the one that is now active.
///
/// The session reports the change as a `model_change` entry and as the model of
/// its `get_state`; the frontend reads those.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol - including a model
/// that pi does not know.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, provider = %provider, model = %model_id))]
pub async fn set_model(
    state: State<'_, AppState>,
    session: String,
    provider: String,
    model_id: String,
) -> Result<Model, PieError> {
    named_session(&state, &session, "choosing the model of a session")
        .await?
        .set_model(&provider, &model_id)
        .await
}

/// Sets the thinking level of one session.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol - including a level
/// that the session does not support.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, level = ?level))]
pub async fn set_thinking_level(
    state: State<'_, AppState>,
    session: String,
    level: ThinkingLevel,
) -> Result<(), PieError> {
    named_session(&state, &session, "setting the thinking level of a session")
        .await?
        .set_thinking_level(level)
        .await
}

/// Turns automatic compaction of one session on or off.
///
/// The new state is the `autoCompactionEnabled` of the next `get_state`; the
/// frontend reads it again after this.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, enabled))]
pub async fn set_auto_compaction(state: State<'_, AppState>, session: String, enabled: bool) -> Result<(), PieError> {
    named_session(&state, &session, "changing automatic compaction of a session")
        .await?
        .set_auto_compaction(enabled)
        .await
}

/// Compacts the conversation of one session into a summary, now.
///
/// `customInstructions` steers the summary. The answer arrives when pi has written
/// it. Compaction reports itself on the event channel, so the transcript hears of
/// it whether or not this call is the one that asked.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol - including a
/// compaction that already runs.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, instructed = custom_instructions.is_some()))]
pub async fn compact(
    state: State<'_, AppState>,
    session: String,
    custom_instructions: Option<String>,
) -> Result<CompactionResult, PieError> {
    named_session(&state, &session, "compacting the conversation of a session")
        .await?
        .compact(custom_instructions.as_deref())
        .await
}

/// The text of the last assistant message of one session.
///
/// Pi answers no text when the session has no assistant message.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_last_assistant_text(
    state: State<'_, AppState>,
    session: String,
) -> Result<LastAssistantTextData, PieError> {
    named_session(&state, &session, "reading the last answer of a session")
        .await?
        .last_assistant_text()
        .await
}

/// Names one session.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol - including an empty
/// name, which pi refuses.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, chars = name.chars().count()))]
pub async fn set_session_name(state: State<'_, AppState>, session: String, name: String) -> Result<(), PieError> {
    named_session(&state, &session, "naming a session")
        .await?
        .set_session_name(&name)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_command_without_a_connection_fails_as_the_ipc_layer() {
        // The frontend matches on the pair below. The name of the layer says which
        // part of pie failed: no connection is a state of the IPC layer's own slot.
        let state = AppState::default();
        let error = named_session(&state, "main:9", "sending a message to a session")
            .await
            .unwrap_err();
        let sent = serde_json::to_value(&error).expect("a failure serializes");

        assert_eq!(sent["type"], "commands");
        assert_eq!(sent["error"]["kind"], "not_connected");
        assert_eq!(
            sent["message"],
            "connect to a host before sending a message to a session"
        );
    }

    #[tokio::test]
    async fn a_session_that_is_not_there_fails_as_the_session_layer() {
        let _state = AppState::default();
        // A connection is needed before a session can be absent from it, so this
        // holds the name of the layer that a missing session belongs to.
        let error = PieError::from(session::Error::UnknownSession {
            id: "main:9".to_string(),
        });
        let sent = serde_json::to_value(&error).expect("a failure serializes");

        assert_eq!(sent["type"], "session");
        assert_eq!(sent["error"]["kind"], "unknown_session");
        assert_eq!(sent["message"], "this connection has no session `main:9`");
    }
}
