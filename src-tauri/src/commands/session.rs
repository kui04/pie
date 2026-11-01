//! One session of pi: what it holds, and what it is asked to do.
//!
//! Every command names the host and the conversation file, and `commands::session_at`
//! answers the machine and the pi that serves it, so no body repeats the lookup.

use anyhow::Context as _;
use pi_rpc::client::{BashReq, PromptReq};
use pi_rpc::entry::TreeNode;
use pi_rpc::message::Message;
use pi_rpc::response::{
    BashResult, ClearQueueData, CompactionResult, EntryList, ForkMessage, SessionState,
    SessionStats,
};
use pi_rpc::types::{
    ImageContent, Model, PromptDisposition, QueueMode, SlashCommand, StreamingBehavior,
    ThinkingLevel,
};
use tauri::State;
use typed_path::Utf8TypedPathBuf;

use crate::commands::session_at;
use crate::error::PieError;
use crate::host::Executor;
use crate::host::fs::typed;
use crate::session::{SessionEntryId, SessionTitle};
use crate::state::{AppState, HostId};

/// Stop the run of one session.
#[tauri::command(rename = "abort")]
pub async fn session_abort(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .abort()
        .await
        .with_context(|| format!("stopping the run of `{}`", attached.path))?;

    Ok(())
}

/// Stop the shell command of one session, if one runs.
#[tauri::command(rename = "abort_bash")]
pub async fn session_abort_bash(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .abort_bash()
        .await
        .with_context(|| format!("stopping the shell command of `{}`", attached.path))?;

    Ok(())
}

/// Stop the retry pi waits on, if one waits.
#[tauri::command(rename = "abort_retry")]
pub async fn session_abort_retry(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .abort_retry()
        .await
        .with_context(|| format!("stopping the retry of `{}`", attached.path))?;

    Ok(())
}

/// Run a shell command in the directory of one session.
#[tauri::command(rename = "bash")]
pub async fn session_bash(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    command: String,
    exclude_from_context: bool,
) -> Result<BashResult, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    // pi runs the command in the working directory of the conversation, not of pie.
    let asked = BashReq {
        command: command.clone(),
        exclude_from_context: Some(exclude_from_context),
    };

    Ok(attached
        .session
        .client()
        .bash_with(asked)
        .await
        .with_context(|| format!("running `{command}` in `{}`", attached.path))?)
}

/// Drop every queued message of one session.
#[tauri::command(rename = "clear_queue")]
pub async fn session_clear_queue(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<ClearQueueData, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .clear_queue()
        .await
        .with_context(|| format!("clearing the queue of `{}`", attached.path))?)
}

/// Where one clone left the session.
///
/// pi may cancel a clone, and a cancelled clone leaves the session on the file the
/// command named. The two outcomes carry different facts, so they are two variants.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CloneOutcome {
    /// pi copied the branch into this file and serves it now.
    Cloned {
        /// The conversation file that replaces the one the command named.
        session: Utf8TypedPathBuf,
    },
    /// pi cancelled, and the session still serves the file the command named.
    Cancelled,
}

/// Copy the whole branch of one session into a new file, and serve that file.
#[tauri::command(rename = "clone_session")]
pub async fn session_clone_session(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<CloneOutcome, PieError> {
    let attached = session_at(&state, &host, &session).await?;
    let client = attached.session.client();

    let switch = client
        .clone_session()
        .await
        .with_context(|| format!("cloning `{}`", attached.path))?;
    if switch.cancelled {
        return Ok(CloneOutcome::Cancelled);
    }

    // pi names the file it serves now only in its state, and the map key, the session,
    // and the dialog handler all have to move to it.
    let now = client
        .get_state()
        .await
        .context("pi did not answer with the state of the cloned conversation")?;
    let file = now
        .session_file
        .filter(|file| !file.is_empty())
        .context("pi cloned no conversation file")?;
    let session = typed(file, attached.host.host().family().await);

    // A clone hands the same pi another file, but pie serves it with a new process, so
    // a turn in flight does not survive the clone.
    attached.host.detach_session(&attached.path).await?;
    attached
        .host
        .attach_session(session.clone(), state.bus())
        .await?;

    Ok(CloneOutcome::Cloned { session })
}

/// Compact the conversation of one session into a summary, now.
#[tauri::command(rename = "compact")]
pub async fn session_compact(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    custom_instructions: Option<String>,
) -> Result<CompactionResult, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .compact(custom_instructions.as_deref())
        .await
        .with_context(|| format!("compacting `{}`", attached.path))?)
}

/// Where one fork left the session.
///
/// pi branches the conversation into a new file and serves it in the same process,
/// so the file the command named is no longer the one this run belongs to. The two
/// outcomes carry different facts, so they are two variants.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ForkOutcome {
    /// pi branched the conversation into this file and serves it now.
    Forked {
        /// The conversation file that replaces the one the command named.
        session: Utf8TypedPathBuf,
        /// The user message the branch starts from, when pi kept one.
        text: Option<String>,
    },
    /// pi cancelled, and the session still serves the file the command named.
    Cancelled,
}

/// Fork one session at a user message. The fork is a new conversation file, so pie
/// serves it with a new process, the way it serves a clone.
#[tauri::command(rename = "fork_session")]
pub async fn session_fork_session(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    entry_id: SessionEntryId,
) -> Result<ForkOutcome, PieError> {
    let attached = session_at(&state, &host, &session).await?;
    let client = attached.session.client();

    let fork = client
        .fork(entry_id.as_str())
        .await
        .with_context(|| format!("forking `{}` at `{entry_id}`", attached.path))?;
    if fork.cancelled {
        return Ok(ForkOutcome::Cancelled);
    }

    // The fork answer names no file, so pi's state is its only source, exactly as for
    // a clone.
    let named = match client.get_state().await {
        Ok(state) => state.session_file.filter(|file| !file.is_empty()),
        Err(error) => {
            tracing::warn!(%error, "pi did not answer with the state of the forked conversation");
            None
        }
    };

    // pi forked, so this process serves the branch and no longer the file the map
    // holds. A branch pie cannot name would leave the map lying, so the session is
    // dropped instead of mislabelled.
    let Some(file) = named else {
        attached.host.detach_session(&attached.path).await?;
        return Err(PieError::failed(
            "pi forked a conversation it did not name; pie dropped the session",
        ));
    };
    let session = typed(file, attached.host.host().family().await);

    // The process already serves the branched file, but a `Session` is named by the
    // file it was registered under and that never changes, so the branched run gets
    // a process of its own.
    attached.host.detach_session(&attached.path).await?;
    attached
        .host
        .attach_session(session.clone(), state.bus())
        .await?;

    Ok(ForkOutcome::Forked {
        session,
        text: fork.text,
    })
}

/// The models that one session can use.
#[tauri::command(rename = "get_available_models")]
pub async fn session_get_available_models(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<Vec<Model>, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .get_available_models()
        .await
        .with_context(|| format!("reading the models of `{}`", attached.path))?)
}

/// The thinking levels that one session accepts.
#[tauri::command(rename = "get_available_thinking_levels")]
pub async fn session_get_available_thinking_levels(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<Vec<ThinkingLevel>, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    // The list depends on the model the session holds now, so it is asked, never assumed.
    Ok(attached
        .session
        .client()
        .get_available_thinking_levels()
        .await
        .with_context(|| format!("reading the thinking levels of `{}`", attached.path))?)
}

/// The commands that a prompt of one session can invoke.
#[tauri::command(rename = "get_commands")]
pub async fn session_get_commands(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<Vec<SlashCommand>, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .get_commands()
        .await
        .with_context(|| format!("reading the commands of `{}`", attached.path))?)
}

/// Every entry of one session, and the leaf it points at.
#[tauri::command(rename = "get_entries")]
pub async fn session_get_entries(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<EntryList, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .get_entries(None)
        .await
        .with_context(|| format!("reading the entries of `{}`", attached.path))?)
}

/// The user messages of one session that a fork can start from.
#[tauri::command(rename = "get_fork_messages")]
pub async fn session_get_fork_messages(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<Vec<ForkMessage>, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .get_fork_messages()
        .await
        .with_context(|| format!("reading the fork points of `{}`", attached.path))?)
}

/// The text of the last assistant message of one session.
#[tauri::command(rename = "get_last_assistant_text")]
pub async fn session_get_last_assistant_text(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<Option<String>, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .get_last_assistant_text()
        .await
        .with_context(|| format!("reading the last answer of `{}`", attached.path))?)
}

/// The conversation of one session, in the order pi holds it.
///
/// A message this pie does not know yet keeps the exact record pi sent, so the two
/// never disagree about a conversation a newer pi wrote.
#[derive(Debug, Clone)]
pub struct SessionMessages(Vec<Message>);

impl SessionMessages {
    /// Takes the messages as the protocol crate decoded them.
    pub(crate) fn new(messages: Vec<Message>) -> Self {
        Self(messages)
    }
}

impl serde::Serialize for SessionMessages {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // `Message`'s derived `Serialize` renames the role of a message this pie does
        // not know yet. `encode_message_value` replays it verbatim.
        let messages = self
            .0
            .iter()
            .map(pi_rpc::message::encode_message_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(serde::ser::Error::custom)?;
        messages.serialize(serializer)
    }
}

/// The whole conversation of one session, so a session the frontend has never
/// drawn can be drawn.
#[tauri::command(rename = "get_messages")]
pub async fn session_get_messages(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<SessionMessages, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(SessionMessages::new(
        attached
            .session
            .client()
            .get_messages()
            .await
            .with_context(|| format!("reading the conversation of `{}`", attached.path))?,
    ))
}

/// The usage of one session: counts, tokens, cost, context.
#[tauri::command(rename = "get_session_stats")]
pub async fn session_get_session_stats(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<SessionStats, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .get_session_stats()
        .await
        .with_context(|| format!("reading the usage of `{}`", attached.path))?)
}

/// The state of one session: its model, its run, its name, its counts.
#[tauri::command(rename = "get_state")]
pub async fn session_get_state(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<SessionState, PieError> {
    let attached = session_at(&state, &host, &session).await?;
    let now = attached
        .session
        .client()
        .get_state()
        .await
        .with_context(|| format!("reading the state of `{}`", attached.path))?;

    // The file pi reports never replaces the key this session is registered under.
    let mut info = attached.session.info();
    info.apply_rpc_state(&now);
    attached.session.set_info(info);

    Ok(now)
}

/// The conversation of one session as a tree, and the entry pi shows now.
///
/// An entry this pie does not know yet keeps the exact record pi sent at every
/// depth, so the two never disagree about a conversation a newer pi wrote.
#[derive(Debug, Clone)]
pub struct SessionTree {
    pub tree: Vec<TreeNode>,
    pub leaf_id: Option<SessionEntryId>,
}

impl serde::Serialize for SessionTree {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // `Entry`'s derived `Serialize` renames an unknown kind, and an unknown
        // message role inside a message entry. `encode_tree_node_value` replays both
        // verbatim, at every depth.
        let tree = self
            .tree
            .iter()
            .map(pi_rpc::entry::encode_tree_node_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(serde::ser::Error::custom)?;

        SessionTreeWire {
            tree,
            leaf_id: &self.leaf_id,
        }
        .serialize(serializer)
    }
}

/// The fields of [`SessionTree`] as the wire names them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionTreeWire<'a> {
    tree: Vec<serde_json::Value>,
    leaf_id: &'a Option<SessionEntryId>,
}

/// The conversation of one session as a tree, with the entry pi shows now.
#[tauri::command(rename = "get_tree")]
pub async fn session_get_tree(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
) -> Result<SessionTree, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    let list = attached
        .session
        .client()
        .get_tree()
        .await
        .with_context(|| format!("reading the tree of `{}`", attached.path))?;

    Ok(SessionTree {
        tree: list.tree,
        leaf_id: list.leaf_id.map(SessionEntryId::new),
    })
}

/// Send a message to one session.
#[tauri::command(rename = "prompt")]
pub async fn session_prompt(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    message: String,
    images: Option<Vec<ImageContent>>,
    attachments: Option<Vec<String>>,
    behavior: Option<StreamingBehavior>,
) -> Result<PromptDisposition, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    // Attachments travel as text: pi takes no `@file` argument in rpc mode, and its
    // prompt carries images but no other file.
    let message = match attachments {
        Some(attachments) if !attachments.is_empty() => {
            let mut text = message;
            text.push_str("\n\nAttachments:");

            let family = attached.host.host().family().await;
            for attachment in attachments {
                let path = typed(attachment, family);
                text.push_str("\n- ");
                text.push_str(path.as_str());
            }

            text
        }
        _ => message,
    };

    Ok(attached
        .session
        .client()
        .prompt_with(PromptReq {
            message,
            images,
            streaming_behavior: behavior,
        })
        .await
        .with_context(|| format!("sending a prompt to `{}`", attached.path))?)
}

/// Turn automatic compaction of one session on or off.
#[tauri::command(rename = "set_auto_compaction")]
pub async fn session_set_auto_compaction(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    enabled: bool,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .set_auto_compaction(enabled)
        .await
        .with_context(|| format!("setting automatic compaction of `{}`", attached.path))?;

    Ok(())
}

/// Let pi retry a turn that a transient failure ended.
///
/// pi keeps this setting out of `get_state`, so a caller cannot read it back: the
/// caller that turns it on holds the value.
#[tauri::command(rename = "set_auto_retry")]
pub async fn session_set_auto_retry(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    enabled: bool,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .set_auto_retry(enabled)
        .await
        .with_context(|| format!("setting automatic retry of `{}`", attached.path))?;

    Ok(())
}

/// How a follow-up message of one session joins the queue.
#[tauri::command(rename = "set_follow_up_mode")]
pub async fn session_set_follow_up_mode(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    mode: QueueMode,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .set_follow_up_mode(mode)
        .await
        .with_context(|| format!("setting the follow-up mode of `{}`", attached.path))?;

    Ok(())
}

/// Select the model of one session.
#[tauri::command(rename = "set_model")]
pub async fn session_set_model(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    provider: String,
    model_id: String,
) -> Result<Model, PieError> {
    let attached = session_at(&state, &host, &session).await?;

    Ok(attached
        .session
        .client()
        .set_model(&provider, &model_id)
        .await
        .with_context(|| {
            format!(
                "setting the model of `{}` to `{provider}/{model_id}`",
                attached.path
            )
        })?)
}

/// Name one session.
#[tauri::command(rename = "set_session_name")]
pub async fn session_set_session_name(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    name: String,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .set_session_name(&name)
        .await
        .with_context(|| format!("naming `{}` `{name}`", attached.path))?;

    // The listing shows the chosen name without a rescan, so the cache takes it too.
    let mut info = attached.session.info();
    let title = SessionTitle::renamed(&name, info.first_prompt.as_deref());
    info.title = title;
    attached.session.set_info(info);

    Ok(())
}

/// How a message sent mid-run joins the queue of one session.
#[tauri::command(rename = "set_steering_mode")]
pub async fn session_set_steering_mode(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    mode: QueueMode,
) -> Result<(), PieError> {
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .set_steering_mode(mode)
        .await
        .with_context(|| format!("setting the steering mode of `{}`", attached.path))?;

    Ok(())
}

/// Set the thinking level of one session.
#[tauri::command(rename = "set_thinking_level")]
pub async fn session_set_thinking_level(
    state: State<'_, AppState>,
    host: HostId,
    session: Utf8TypedPathBuf,
    level: ThinkingLevel,
) -> Result<(), PieError> {
    // A failure names the level pi could not take, so it is read before the call moves it.
    let asked = format!("{level:?}");
    let attached = session_at(&state, &host, &session).await?;

    attached
        .session
        .client()
        .set_thinking_level(level)
        .await
        .with_context(|| {
            format!(
                "setting the thinking level of `{}` to `{asked}`",
                attached.path
            )
        })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clone_outcome_names_the_file_or_the_cancel() {
        let cloned = CloneOutcome::Cloned {
            session: Utf8TypedPathBuf::from_unix("/work/a.jsonl"),
        };

        assert_eq!(
            serde_json::to_value(&cloned).expect("a clone serializes"),
            serde_json::json!({ "type": "cloned", "session": "/work/a.jsonl" })
        );
        assert_eq!(
            serde_json::to_value(CloneOutcome::Cancelled).expect("a cancel serializes"),
            serde_json::json!({ "type": "cancelled" })
        );
    }

    #[test]
    fn a_fork_outcome_names_the_branched_file_or_the_cancel() {
        let forked = ForkOutcome::Forked {
            session: Utf8TypedPathBuf::from_unix("/work/b.jsonl"),
            text: Some("why?".to_owned()),
        };

        assert_eq!(
            serde_json::to_value(&forked).expect("a fork serializes"),
            serde_json::json!({
                "type": "forked",
                "session": "/work/b.jsonl",
                "text": "why?",
            })
        );
        assert_eq!(
            serde_json::to_value(ForkOutcome::Cancelled).expect("a cancel serializes"),
            serde_json::json!({ "type": "cancelled" })
        );
    }

    #[test]
    fn a_tree_keeps_an_entry_this_pie_does_not_know_at_every_depth() {
        fn unknown(id: &str) -> TreeNode {
            TreeNode {
                entry: pi_rpc::entry::Entry::Unknown(pi_rpc::types::RawRecord::new(
                    "type",
                    serde_json::json!({ "type": "unknownKind", "id": id }),
                )),
                children: Vec::new(),
                label: None,
                label_timestamp: None,
            }
        }

        let tree = SessionTree {
            tree: vec![TreeNode {
                children: vec![unknown("b")],
                ..unknown("a")
            }],
            leaf_id: Some(SessionEntryId::new("b")),
        };

        let wire = serde_json::to_value(&tree).expect("a tree serializes");

        assert_eq!(wire["tree"][0]["entry"]["type"], "unknownKind");
        assert_eq!(wire["tree"][0]["children"][0]["entry"]["id"], "b");
        assert_eq!(wire["leafId"], "b");
    }

    #[test]
    fn a_message_this_pie_does_not_know_keeps_the_record_pi_sent() {
        let unknown = pi_rpc::types::RawRecord::new(
            "role",
            serde_json::json!({ "role": "weirdRole", "payload": { "n": 1 } }),
        );
        let messages = SessionMessages::new(vec![
            pi_rpc::message::Message::Unknown(unknown),
            pi_rpc::message::Message::User(pi_rpc::message::UserMessage {
                content: pi_rpc::message::UserContent::Text("hi".to_owned()),
                timestamp: 1.5,
            }),
        ]);

        let wire = serde_json::to_value(&messages).expect("a conversation serializes");

        assert_eq!(
            wire[0],
            serde_json::json!({ "role": "weirdRole", "payload": { "n": 1 } })
        );
        assert_eq!(wire[1]["role"], "user");
    }
}
