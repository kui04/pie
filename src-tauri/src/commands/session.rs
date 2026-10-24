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
//! A read takes the registry only long enough to find the session, never across
//! a session read. A disconnect does not wait behind it.
//!
//! A command fails with the sentence that the step which failed wrote: no
//! connection and no such session have sentences of their own, and everything
//! below is the protocol layer's own error. Neither is wrapped here.

use std::sync::PoisonError;

use pi_rpc::{
    response::{
        BashResult, ClearQueueData, CompactionResult, EntryList, ForkData, ForkMessage, SessionState, SessionStats,
        SessionSwitch,
    },
    types::{ImageContent, Model, StreamingBehavior, ThinkingLevel},
};
use tauri::{AppHandle, State};

use super::pipe;
use crate::{
    error::PieError,
    session::{
        self, CommandsData, ExtensionAnswer, ExtensionState, LastAssistantTextData, PromptData, Session, SessionInfo,
        SessionSummary,
    },
    state::AppState,
};

/// The session that a command names.
///
/// The clone is another hand to the same pi process, not a session of its own.
///
/// # Errors
///
/// [`PieError::NotConnected`] when there is no connection, and a sentence when
/// the id belongs to no session of this connection.
async fn named_session(state: &AppState, session: &str, doing: &str) -> Result<Session, PieError> {
    let session = {
        let hosts = state.hosts.lock().unwrap_or_else(PoisonError::into_inner);
        if hosts.is_empty() {
            return Err(PieError::NotConnected {
                doing: doing.to_string(),
            });
        }
        hosts
            .find_session(session)
            .ok_or_else(|| PieError::failed(format!("this connection has no session `{session}`")))?
    };
    Ok(session)
}

/// Every conversation that pi wrote on the connected machine.
///
/// The rows are the conversation files of pi, not the pi processes pie runs: a
/// session that has said nothing yet has no file, and therefore no row. No pi
/// process is needed for this read: the listing is files.
///
/// # Errors
///
/// [`PieError::NotConnected`] if there is no machine to list, and the failure of the
/// machine if pie cannot read the sessions directory.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, PieError> {
    let sessions = super::connected(&state, "listing its sessions")?;
    Ok(sessions.list_sessions().await?)
}

/// Deletes one conversation of the connected machine.
///
/// The conversation is a file of pi, and pi has no command that deletes one: the
/// frontend ends the process that holds it first (`detach_session`), then asks for
/// this. The row leaves the listing. A fork of that conversation is unaffected - a
/// branch copies the entries it keeps - and pi's own selector reads the path in its
/// header as a name that resolves to nothing, which is a root.
///
/// # Errors
///
/// [`PieError::NotConnected`] if there is no machine, a sentence for a relative
/// path, and one when the file cannot be removed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = %path))]
pub async fn delete_session(state: State<'_, AppState>, path: String) -> Result<(), PieError> {
    let sessions = super::connected(&state, "deleting a conversation")?;
    Ok(sessions.delete_conversation(&path).await?)
}

/// Starts a pi on the connected machine and hands its records to the frontend.
///
/// The one body behind `attach_session` and `start_session`: the two differ in
/// what pi is asked to start on - a session file, or a directory for a new
/// session file - and in nothing that follows.
async fn begin(
    app: AppHandle,
    state: &AppState,
    session_file: Option<&str>,
    current_dir: Option<&str>,
) -> Result<SessionInfo, PieError> {
    let sessions = super::connected(state, "starting pi")?;
    let session = sessions
        .attach(state.next_session_number(), session_file, current_dir)
        .await?;
    // The subscription happens before the task starts, not inside it, so the pipe
    // itself misses nothing that pi writes after this line.
    //
    // What the frontend hears is another matter: its listener can only start after
    // the answer of this command, because that answer is where it reads the id of
    // the session. What pi wrote before then is lost, and lost in silence - the
    // module of [`pipe`] carries the whole of that.
    pipe::forward_extensions(app.clone(), &session);
    pipe::forward(app, &session, session.events());
    Ok(session.info())
}

/// Starts a pi on the connected machine, on a conversation file, and answers
/// with the session it speaks through.
///
/// The frontend asks for this when a person opens a conversation. Nothing about
/// the connection is needed for the listing of conversations, so a machine that
/// is only browsed runs no pi.
///
/// `path` names the conversation file of pi to load at the start (`--session`).
/// Pi starts in the directory recorded in that file; the working directory is the
/// file's, not pie's to choose. A conversation belongs to one process: a pi that
/// moved between files would leave records of the left file in the machine of the
/// next one. The id of the answer is pie's own for this pi process (`main:1`), and
/// it is the name of the events of the session (`pi://session/{id}/...`). It is not
/// the session id of pi, which is the id of the conversation file.
///
/// # Errors
///
/// [`PieError::NotConnected`] if there is no machine to start pi on, and a
/// sentence when pi cannot be started.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(path = %path))]
pub async fn attach_session(state: State<'_, AppState>, app: AppHandle, path: String) -> Result<SessionInfo, PieError> {
    begin(app, &state, Some(&path), None).await
}

/// Starts a pi on the connected machine in a directory, and answers with the
/// session it speaks through.
///
/// The frontend asks for this on "New session": a new conversation, with no file
/// yet. `cwd` is a directory of the machine, as the directory picker wrote it.
/// The directory is where the new conversation is recorded
/// (pi writes it into the header of the session file) and where the tools of that
/// session run, so the choice is the one fact that decides what the conversation
/// is about.
///
/// # Errors
///
/// [`PieError::NotConnected`] if there is no machine to start pi on, and a
/// sentence when pi cannot be started in that directory.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(cwd = %cwd))]
pub async fn start_session(state: State<'_, AppState>, app: AppHandle, cwd: String) -> Result<SessionInfo, PieError> {
    begin(app, &state, None, Some(&cwd)).await
}

/// Ends one pi. The machine stays reached, and the conversation file stays.
///
/// The frontend asks for this when it is done speaking through that session. A
/// new session speaks again: a pick attaches one on the conversation file it
/// names, so a process never leaves the conversation it opened with.
///
/// # Errors
///
/// [`PieError::NotConnected`] if there is no machine, and a sentence when the id
/// belongs to no session of this connection.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn detach_session(state: State<'_, AppState>, session: String) -> Result<(), PieError> {
    let sessions = super::connected(&state, "ending the session")?;
    Ok(sessions.detach(&session).await?)
}

/// The state of one session: its model, its run, its name, its counts.
///
/// # Errors
///
/// [`PieError::NotConnected`] and a sentence for a missing session, and the
/// failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_state(state: State<'_, AppState>, session: String) -> Result<SessionState, PieError> {
    Ok(named_session(&state, &session, "reading the state of a session")
        .await?
        .state()
        .await?)
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
    Ok(named_session(&state, &session, "reading the transcript of a session")
        .await?
        .entries()
        .await?)
}

/// The usage of one session: its counts, its tokens, its cost, its context.
///
/// # Errors
///
/// The same as [`get_state`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_session_stats(state: State<'_, AppState>, session: String) -> Result<SessionStats, PieError> {
    Ok(named_session(&state, &session, "reading the usage of a session")
        .await?
        .stats()
        .await?)
}

/// Sends a message to one session.
///
/// `behavior` names how the message joins a run that streams: `steer` interrupts
/// the run at its next step, and `followUp` waits for the run to settle. While
/// nothing streams, pi ignores the behavior and the message starts a run.
/// Therefore a caller does not have to be right about the stream: it names the key
/// that the person pressed.
///
/// `images` are the pictures of the message, as [`super::files::ImageAttachment`]
/// carries them; pi processes them itself.
///
/// The answer says what happened: `started`, `queued`, or `handled` for a message
/// that a command of an extension took without a run.
///
/// # Errors
///
/// [`PieError::NotConnected`], a sentence for a missing session, and the failure of
/// the protocol - including a refusal of pi itself: no model, no credentials, or a
/// compaction in progress.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, chars = message.chars().count(), images = images.as_ref().map_or(0, Vec::len), attachments = attachments.as_ref().map_or(0, Vec::len), behavior = ?behavior))]
pub async fn prompt(
    state: State<'_, AppState>,
    session: String,
    message: String,
    images: Option<Vec<ImageContent>>,
    attachments: Option<Vec<String>>,
    behavior: Option<StreamingBehavior>,
) -> Result<PromptData, PieError> {
    let wire_message = match attachments {
        Some(ref list) if !list.is_empty() => compose_prompt_message(&message, list),
        _ => message,
    };
    Ok(named_session(&state, &session, "sending a message to a session")
        .await?
        .prompt(&wire_message, images, behavior)
        .await?)
}

/// Quotes a path with double quotes if it contains whitespace, backslashes, or quotes.
pub fn quote_path(path: &str) -> String {
    if path.contains([' ', '\t', '\n', '\r', '\\', '"']) {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

/// Composes a wire prompt message by labeling and quoting attached file paths.
pub fn compose_prompt_message(message: &str, attachments: &[String]) -> String {
    let text = message.trim();
    if attachments.is_empty() {
        return text.to_string();
    }

    let mut block = String::from("Attachments:");
    for path in attachments {
        block.push('\n');
        block.push_str("- ");
        block.push_str(&quote_path(path));
    }

    if text.is_empty() {
        block
    } else {
        format!("{text}\n\n{block}")
    }
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
    Ok(named_session(&state, &session, "stopping the run of a session")
        .await?
        .abort()
        .await?)
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
    Ok(named_session(&state, &session, "clearing the queue of a session")
        .await?
        .clear_queue()
        .await?)
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
    Ok(named_session(&state, &session, "running a shell command in a session")
        .await?
        .bash(&command, exclude_from_context)
        .await?)
}

/// Stops the shell command of one session, if one runs.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn abort_bash(state: State<'_, AppState>, session: String) -> Result<(), PieError> {
    Ok(
        named_session(&state, &session, "stopping the shell command of a session")
            .await?
            .abort_bash()
            .await?,
    )
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
    Ok(named_session(&state, &session, "reading the commands of a session")
        .await?
        .commands()
        .await?)
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
    Ok(named_session(&state, &session, "reading the models of a session")
        .await?
        .available_models()
        .await?)
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
    Ok(
        named_session(&state, &session, "reading the thinking levels of a session")
            .await?
            .available_thinking_levels()
            .await?,
    )
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
    Ok(named_session(&state, &session, "choosing the model of a session")
        .await?
        .set_model(&provider, &model_id)
        .await?)
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
    Ok(
        named_session(&state, &session, "setting the thinking level of a session")
            .await?
            .set_thinking_level(level)
            .await?,
    )
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
    Ok(
        named_session(&state, &session, "changing automatic compaction of a session")
            .await?
            .set_auto_compaction(enabled)
            .await?,
    )
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
    Ok(
        named_session(&state, &session, "compacting the conversation of a session")
            .await?
            .compact(custom_instructions.as_deref())
            .await?,
    )
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
    Ok(named_session(&state, &session, "reading the last answer of a session")
        .await?
        .last_assistant_text()
        .await?)
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
    Ok(named_session(&state, &session, "naming a session")
        .await?
        .set_session_name(&name)
        .await?)
}

/// The user messages of one session that a fork can start from.
///
/// Pi lists every user message with text, on the current branch and on the
/// others of a fork: this is the list its own selector shows
/// (`getUserMessagesForForking` of the pinned `core/agent-session.ts`).
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_fork_messages(state: State<'_, AppState>, session: String) -> Result<Vec<ForkMessage>, PieError> {
    Ok(named_session(&state, &session, "reading the fork points of a session")
        .await?
        .fork_messages()
        .await?)
}

/// Forks one session at a user message, in the same process.
///
/// Pi writes a new conversation file - the header, then the entries up to the
/// parent of that message - and the process holds it from here; the old file stays
/// where pi wrote it. The session keeps its id, which is the process and not the
/// conversation, so a screen that drew the old conversation must clear it and read
/// the state and the entries again. `text` is the selected message, for a screen
/// that offers it back to the person.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol - including a
/// conversation with no file yet ("send a message before cloning or forking it").
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, entry = %entry_id))]
pub async fn fork_session(state: State<'_, AppState>, session: String, entry_id: String) -> Result<ForkData, PieError> {
    Ok(named_session(&state, &session, "forking a session")
        .await?
        .fork(&entry_id)
        .await?)
}

/// Copies the whole branch of one session into a new file, in the same process.
///
/// This is a fork at the leaf: the new file holds every entry of the current
/// branch, and the process holds it from here. Like [`fork_session`], the session
/// keeps its id and its conversation changes, so the state and the entries are read
/// again.
///
/// # Errors
///
/// The same as [`fork_session`].
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn clone_session(state: State<'_, AppState>, session: String) -> Result<SessionSwitch, PieError> {
    Ok(named_session(&state, &session, "cloning a session")
        .await?
        .clone_session()
        .await?)
}

/// The extension UI state of one session: pending dialogs and the current
/// fire-and-forget values.
///
/// A listener reads this after it subscribes. The event channel only shortens
/// the wait for the next read; a request that arrived before the listener is
/// still here.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session))]
pub async fn get_extension_state(state: State<'_, AppState>, session: String) -> Result<ExtensionState, PieError> {
    Ok(named_session(&state, &session, "reading the extension UI of a session")
        .await?
        .extension()
        .snapshot())
}

/// Answers one pending dialog of one session.
///
/// The answer is false when no request waits under that id: a dialog that
/// timed out, or an answer that raced one. A late answer is not an error.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, id = %id))]
pub async fn answer_extension(
    state: State<'_, AppState>,
    session: String,
    id: String,
    answer: ExtensionAnswer,
) -> Result<bool, PieError> {
    Ok(named_session(&state, &session, "answering an extension dialog")
        .await?
        .extension()
        .answer(&id, answer.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_command_without_a_connection_carries_the_name_of_its_state() {
        // The frontend reads the name below when it must tell this failure from
        // another: no connection is the state of the IPC layer's own slot.
        let state = AppState::default();
        let error = named_session(&state, "main:9", "sending a message to a session")
            .await
            .unwrap_err();
        let sent = serde_json::to_value(&error).expect("a failure serializes");

        assert_eq!(sent["kind"], "not_connected");
        assert_eq!(
            sent["message"],
            "connect to a host before sending a message to a session"
        );
        assert_eq!(sent["doing"], "sending a message to a session");
    }

    #[tokio::test]
    async fn a_session_that_is_not_there_is_a_sentence_with_no_name() {
        let _state = AppState::default();
        // A connection is needed before a session can be absent from it, so this
        // holds the sentence that a missing session carries.
        let error = PieError::failed("this connection has no session `main:9`");
        let sent = serde_json::to_value(&error).expect("a failure serializes");

        assert_eq!(sent["kind"], "failed");
        assert_eq!(sent["message"], "this connection has no session `main:9`");
    }

    #[test]
    fn composes_prompt_with_labeled_and_quoted_attachments() {
        let empty: Vec<String> = Vec::new();
        assert_eq!(compose_prompt_message("hello", &empty), "hello");

        let attachments = vec![
            "/tmp/plain.txt".to_string(),
            "/tmp/with space.pdf".to_string(),
            r"C:\Windows\file.txt".to_string(),
        ];
        let composed = compose_prompt_message("look here", &attachments);
        assert_eq!(
            composed,
            "look here\n\nAttachments:\n- /tmp/plain.txt\n- \"/tmp/with space.pdf\"\n- \"C:\\Windows\\file.txt\""
        );

        let only_files = compose_prompt_message("", &attachments[..1]);
        assert_eq!(only_files, "Attachments:\n- /tmp/plain.txt");
    }
}
