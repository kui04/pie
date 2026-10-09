//! What the frontend says to a session: a message, an interrupt, a shell
//! command, and the controls around them.
//!
//! These are the commands of the composer. The frontend names the session as the
//! reads of `commands/session.rs` do: the id that `connect` answered under
//! (`ConnectionInfo.sessions[].id`). That id is pie's own (`main:1`); it is not
//! the session id of pi, which is the id of the session file.
//!
//! A command here ends in one of three ways, and none of them needs a report of
//! its own: pi answers with a disposition, a queue, a result, or nothing, and
//! every lasting change reports itself as an event of the session, which
//! [`super::pipe`] forwards. A caller that wants the effect of a model change or
//! a compaction watches those events, not this layer.
//!
//! A command fails as the layer that owns the failure: an absent connection or an
//! absent session is [`connection::Error`], and everything below them, including
//! a refusal of pi itself, is [`crate::pi_rpc::Error`]. Neither is wrapped here.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use crate::connection::{self, Session};
use crate::error::PieError;
use crate::pi_rpc::protocol::{
    AvailableModelsData, AvailableThinkingLevelsData, BashResult, ClearQueueData, CommandsData, CompactionResult,
    ImageContent, ImagePartType, LastAssistantTextData, Model, ModelThinkingLevel, PromptData, StreamingBehavior,
};

use super::state::AppState;

/// The session that a composer command names.
///
/// The clone is another handle to the same pi process, not a session of its own.
///
/// # Errors
///
/// [`connection::Error::NotConnected`] when there is no host, and
/// [`connection::Error::UnknownSession`] when the id belongs to no session of the
/// connection.
async fn named_session(state: &AppState, session: &str, doing: &str) -> Result<Session, PieError> {
    let connection = state
        .connection
        .lock()
        .await
        .clone()
        .ok_or_else(|| connection::Error::NotConnected {
            doing: doing.to_string(),
        })?;
    connection.session(session).cloned().ok_or_else(|| {
        connection::Error::UnknownSession {
            id: session.to_string(),
        }
        .into()
    })
}

/// One image that a person picked, with the name of the file it came from.
///
/// The name is for the chip of the reader in the composer; pi never sees it
/// (`ImageContent` carries no name). A picker on Android answers with a
/// `content://` URI, which may have no name of its own; such a picture is
/// `Image`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedImage {
    /// The name of the file, or `Image` when the picker gave none.
    pub name: String,
    /// The picture, as the `images` of a prompt take it.
    pub image: ImageContent,
}

/// Asks the person for images to attach to a message.
///
/// The answer is what pi takes for the `images` of a prompt: base64 with a MIME
/// type. `None` means that the person closed the picker, which is not a failure.
/// A file that cannot be read is [`PieError::Io`].
///
/// The type of a picture comes from its first bytes, and from the name of its file
/// when the bytes do not say: a picker on Android answers with a `content://` URI,
/// which has no name of its own. A file of no known type travels as
/// `application/octet-stream` — whether it is an image is a decision of pi, not of
/// pie.
///
/// # Errors
///
/// The failure of the read of a selected file. The picker itself reports no
/// failure: one that cannot be shown answers as a closed picker.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn pick_images(app: AppHandle) -> Result<Option<Vec<PickedImage>>, PieError> {
    picked_images(&app)
}

/// The command without the async shell.
///
/// `async` on [`pick_images`] moves this work off the main thread, as
/// [`super::keys::pick_private_key`] does: the blocking dialog needs the event
/// loop, and the event loop belongs to the main thread.
fn picked_images(app: &AppHandle) -> Result<Option<Vec<PickedImage>>, PieError> {
    use base64::Engine as _;

    let Some(chosen) = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
        .blocking_pick_files()
    else {
        return Ok(None);
    };

    let mut picked = Vec::with_capacity(chosen.len());
    for file in chosen {
        let name = file
            .as_path()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_string);
        let extension = file
            .as_path()
            .and_then(|path| path.extension())
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_string();
        // The filesystem of the plugin, not `tokio::fs`: on Android the picker
        // answers with a `content://` URI. Only the plugin can open that URI.
        let bytes = app.fs().read(file).map_err(PieError::file)?;
        picked.push(PickedImage {
            name: name.unwrap_or_else(|| "Image".to_string()),
            image: ImageContent {
                part_type: ImagePartType::Image,
                data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                mime_type: image_mime_type(&extension, &bytes).to_string(),
            },
        });
    }
    Ok(Some(picked))
}

/// The MIME type of a picture, from its first bytes or from the extension of its
/// name (`png`, `jpeg`, as [`Path::extension`](std::path::Path::extension) gives it).
///
/// The bytes come first: a name is a label, and a `content://` URI carries none. The
/// four types are the ones that pi inlines; anything else it may convert or omit on
/// its own.
fn image_mime_type(extension: &str, bytes: &[u8]) -> &'static str {
    if let Some(kind) = mime_of_magic(bytes) {
        return kind;
    }
    match extension.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// The MIME type that the first bytes of a file name, or `None`.
///
/// These are the signatures of the four types that pi inlines. The list is pi's, not
/// a general catalogue: a picture of another type goes through as it is, and pi says
/// whether it can use it.
fn mime_of_magic(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Sends a message to one session.
///
/// `behavior` names how the message joins a run that streams: `steer` interrupts
/// the run at its next step, and `followUp` waits for the run to settle. While
/// nothing streams, pi ignores the behavior and the message starts a run.
///
/// `images` are the pictures that the person attached to the message, as
/// [`pick_images`] answered them.
///
/// The answer says what happened: `started`, `queued`, or `handled` for a message
/// that a command of an extension took without a run.
///
/// # Errors
///
/// [`connection::Error::NotConnected`] if there is no host,
/// [`connection::Error::UnknownSession`] if the id belongs to no session of this
/// connection, and the failure of the protocol — including a refusal of pi
/// itself: no model, no credentials, or a compaction in progress.
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

/// Runs a shell command on the host of one session, in the directory of that
/// session.
///
/// The command runs through pi, so its result enters the transcript like the
/// result of a tool. While it runs, `bash_execution_update` events stream what it
/// prints. `exclude_from_context` keeps the command and its output out of the
/// context of the model (the `!!` form of the composer).
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
) -> Result<AvailableModelsData, PieError> {
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
) -> Result<AvailableThinkingLevelsData, PieError> {
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
/// The same as [`prompt`], and the failure of the protocol — including a model
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
/// The same as [`prompt`], and the failure of the protocol — including a level
/// that the session does not support.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err, fields(session = %session, level = ?level))]
pub async fn set_thinking_level(
    state: State<'_, AppState>,
    session: String,
    level: ModelThinkingLevel,
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
/// `customInstructions` steers the summary. The answer arrives when pi has
/// written it. Compaction reports itself on the event channel, so the transcript
/// hears of it whether or not this call is the one that asked.
///
/// # Errors
///
/// The same as [`prompt`], and the failure of the protocol — including a
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
/// The same as [`prompt`], and the failure of the protocol — including an empty
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

    #[test]
    fn an_image_is_named_by_its_bytes_then_by_its_name() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00];
        assert_eq!(image_mime_type("", &png), "image/png", "a URI carries no name");
        assert_eq!(
            image_mime_type("jpg", &png),
            "image/png",
            "the bytes are the file; a name is a label"
        );

        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00];
        assert_eq!(image_mime_type("jpeg", &jpeg), "image/jpeg");
        assert_eq!(
            image_mime_type("JPG", &jpeg),
            "image/jpeg",
            "a name is not case-sensitive"
        );

        assert_eq!(image_mime_type("", b"GIF89a\x01"), "image/gif");
        assert_eq!(image_mime_type("gif", b"GIF87a\x01"), "image/gif");

        let mut webp = Vec::from(b"RIFF\x00\x00\x00\x00WEBP".as_slice());
        webp.extend_from_slice(&[0x00, 0x00]);
        assert_eq!(image_mime_type("", &webp), "image/webp");

        // A format that pi knows and this list does not: it travels unnamed, and
        // pi decides whether it can use it.
        assert_eq!(
            image_mime_type("heic", b"\x00\x00\x00\x18ftypheic"),
            "application/octet-stream"
        );
        assert_eq!(image_mime_type("", b""), "application/octet-stream");
    }

    #[tokio::test]
    async fn a_command_without_a_connection_fails_as_the_connection_layer() {
        // The frontend matches on the pair below. The name of the layer says
        // which part of pie failed: this one is not the protocol.
        let state = AppState::default();
        let error = named_session(&state, "main:9", "sending a message to a session")
            .await
            .unwrap_err();
        let sent = serde_json::to_value(&error).expect("a failure serializes");

        assert_eq!(sent["type"], "connection");
        assert_eq!(sent["error"]["kind"], "not_connected");
        assert_eq!(
            sent["message"],
            "connect to a host before sending a message to a session"
        );
    }
}
