//! Replays the recorded stdout of a real `pi --mode rpc` through the protocol
//! crate that speaks it. The corpus and its provenance are described in
//! `tests/fixtures`.
//!
//! Pi is what these recordings are of, and the crate is what reads it: the
//! tests here are the one place where a decoding rule meets the output of the
//! release that wrote it. A record the crate cannot name - a kind, a command, a
//! field that moved - fails here rather than in a session on a device.

use std::path::PathBuf;

use pi_rpc::{
    entry::Entry,
    event::{AssistantUpdate, CompactionReason, Event},
    extui::UiRequest,
    message::{AssistantBlock, Message, NestedStatus, SystemContent, UserBlock, UserContent},
    response::{BashResult, Envelope, Response, SessionState},
    types::{CommandSource, ModelInput, QueuedInputDisposition, SourceOrigin, SourceScope, StopReason, ThinkingLevel},
};

/// Lines of one recorded fixture.
fn fixture(name: &str) -> Vec<String> {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", name].iter().collect();
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()))
        .lines()
        .map(str::to_string)
        .collect()
}

/// One line of a fixture, as a `Value`, for what the typed path hides.
fn raw(name: &str, command: &str) -> serde_json::Value {
    fixture(name)
        .into_iter()
        .find(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .is_ok_and(|value| value.get("command").and_then(|v| v.as_str()) == Some(command))
        })
        .unwrap_or_else(|| panic!("{name} has no `{command}` record"))
        .parse()
        .expect("a JSON record")
}

/// Every response in a fixture.
fn responses(name: &str) -> Vec<Envelope> {
    fixture(name)
        .into_iter()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(&line).expect("a JSON record");
            match value.get("type").and_then(|v| v.as_str()) {
                Some("response") => Some(pi_rpc::response::decode_envelope_value(value).expect(name)),
                _ => None,
            }
        })
        .collect()
}

/// The response to one command in a fixture.
fn response(name: &str, command: &str) -> Envelope {
    responses(name)
        .into_iter()
        .find(|envelope| envelope.body.tag() == command)
        .unwrap_or_else(|| panic!("{name} has no `{command}` response"))
}

/// Every event in a fixture.
fn events_in(name: &str) -> Vec<Event> {
    fixture(name)
        .into_iter()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(&line).expect("a JSON record");
            match value.get("type").and_then(|v| v.as_str()) {
                Some("response") | Some("extension_ui_request") | None => None,
                Some(_) => Some(pi_rpc::event::decode_event_value(value).expect(name)),
            }
        })
        .collect()
}

/// Every `message_update` delta in a fixture.
fn deltas_in(name: &str) -> Vec<AssistantUpdate> {
    events_in(name)
        .into_iter()
        .filter_map(|event| match event {
            Event::MessageUpdate(update) => Some(update.update),
            _ => None,
        })
        .collect()
}

/// The messages a recorded `get_messages` response reports.
fn messages_in(name: &str) -> Vec<Message> {
    match response(name, "get_messages").body {
        Response::GetMessages(messages) => messages,
        other => panic!("{name}: get_messages answered {other:?}"),
    }
}

/// The entries a recorded `get_entries` response reports.
fn entries_in(name: &str) -> Vec<Entry> {
    match response(name, "get_entries").body {
        Response::GetEntries(list) => list.entries,
        other => panic!("{name}: get_entries answered {other:?}"),
    }
}

const PROBE: &str = "session-probe-1.1.0.jsonl";
const BASH: &str = "bash-session-1.1.0.jsonl";
const MODELS: &str = "model-probe-1.1.0.jsonl";
const TRANSCRIPT: &str = "transcript-1.1.0.jsonl";
const TOUR: &str = "tour-1.1.0.jsonl";
const BRANCH: &str = "branch-1.1.0.jsonl";
const FAILURES: &str = "failures-1.1.0.jsonl";
const SESSION: &str = "session-1.1.0.jsonl";
const SUPPLEMENT: &str = "derived-supplement-1.1.0.jsonl";

/// Every fixture, recorded and supplemented.
const FIXTURES: [&str; 9] = [
    PROBE, BASH, MODELS, TRANSCRIPT, TOUR, BRANCH, FAILURES, SESSION, SUPPLEMENT,
];

#[test]
fn every_record_reads_as_the_kind_it_names() {
    for name in FIXTURES {
        for line in fixture(name) {
            let value: serde_json::Value = serde_json::from_str(&line).expect("a JSON record");
            match value.get("type").and_then(|v| v.as_str()) {
                Some("response") => match pi_rpc::response::decode_envelope_value(value) {
                    Ok(Envelope {
                        body: Response::Unknown(unknown),
                        ..
                    }) => panic!("{name}: no type for `{}`", unknown.command),
                    Ok(_) => {}
                    Err(error) => panic!("{name}: {error}"),
                },
                Some("extension_ui_request") => match pi_rpc::extui::decode_ui_request_value(value) {
                    Ok(UiRequest::Unknown(_)) => panic!("{name}: no type for a dialog method"),
                    Ok(_) => {}
                    Err(error) => panic!("{name}: {error}"),
                },
                Some(_) => match pi_rpc::event::decode_event_value(value) {
                    Ok(Event::Unknown(_)) => panic!("{name}: no type for an event"),
                    Ok(_) => {}
                    Err(error) => panic!("{name}: {error}"),
                },
                None => panic!("{name}: a record with no kind"),
            }
        }
    }
}

#[test]
fn decodes_the_session_state() {
    let Response::GetState(state) = response(PROBE, "get_state").body else {
        panic!("get_state answered something else");
    };

    assert_eq!(state.thinking_level, ThinkingLevel::Max);
    assert!(!state.is_streaming);
    assert!(state.auto_compaction_enabled);
    assert_eq!(state.session_id, "00000000-0000-4000-8000-000000000000");

    let model = state.model.expect("the fixture session has a model");
    assert_eq!(model.api, "openai-completions");
    assert_eq!(
        model.extra.get("type"),
        None,
        "pi omits `type` for the model of a session state"
    );
    assert!(model.reasoning);
    assert_eq!(model.input, vec![ModelInput::Text]);
    let map = model
        .extra
        .get("thinkingLevelMap")
        .expect("thinkingLevelMap is present");
    assert_eq!(map["low"], serde_json::json!("low"));
    assert_eq!(
        map["medium"],
        serde_json::Value::Null,
        "null marks a level the model does not support"
    );
    assert!(model.extra.contains_key("compat"), "provider compat is kept verbatim");
}

#[test]
fn decodes_thinking_levels_including_off() {
    let Response::GetAvailableThinkingLevels(levels) = response(PROBE, "get_available_thinking_levels").body else {
        panic!("get_available_thinking_levels answered something else");
    };
    assert_eq!(
        levels,
        vec![
            ThinkingLevel::Off,
            ThinkingLevel::Low,
            ThinkingLevel::High,
            ThinkingLevel::Max
        ]
    );
}

#[test]
fn decodes_slash_commands_with_source_metadata() {
    let Response::GetCommands(commands) = response(PROBE, "get_commands").body else {
        panic!("get_commands answered something else");
    };
    assert!(!commands.is_empty());

    let first = &commands[0];
    assert!(!first.name.is_empty());
    assert_eq!(first.source, CommandSource::Extension);
    assert_eq!(first.source_info.scope, SourceScope::User);
    assert_eq!(first.source_info.origin, SourceOrigin::Package);
    assert!(first.source_info.path.starts_with('/'));

    // The catalog mixes word styles: `package` here, `top-level` further down.
    assert!(
        commands
            .iter()
            .any(|command| command.source_info.origin == SourceOrigin::TopLevel),
        "a top-level command must decode too"
    );
}

#[test]
fn decodes_available_models() {
    let Response::GetAvailableModels(models) = response(MODELS, "get_available_models").body else {
        panic!("get_available_models answered something else");
    };
    assert!(!models.is_empty());

    for model in &models {
        assert_eq!(
            model.extra.get("type"),
            Some(&serde_json::json!("chat")),
            "the catalog writes the optional `type` that a session state omits"
        );
        assert!(model.reasoning);
        assert!(model.context_window.is_some_and(|window| window > 0.0));
        assert!(model.max_tokens.is_some_and(|tokens| tokens > 0.0));
        assert!(!model.input.is_empty());
    }

    // A catalog entry may omit `compat`; the ones that carry it keep the
    // provider-specific bag verbatim rather than a struct of the crate's own.
    assert!(
        models
            .iter()
            .any(|model| model.extra.get("compat").is_some_and(serde_json::Value::is_object)),
        "a provider compat bag is kept verbatim"
    );

    // The two spellings of "unsupported" both appear in real output: the catalog
    // omits a level the model has no mapping for, while the session state lists
    // it as `null` - which is why an absent key stays apart from an explicit
    // `null`.
    let map = models[0]
        .extra
        .get("thinkingLevelMap")
        .expect("the first catalog entry carries a map");
    assert_eq!(map.get("minimal"), None, "an unlisted level is absent");
    assert_eq!(
        map["off"],
        serde_json::Value::Null,
        "a listed but unsupported level is null"
    );
}

#[test]
fn accepts_off_as_a_thinking_level() {
    // pi accepts `off` for `set_thinking_level`, and both the event and the
    // session state carry it.
    let sets: Vec<Response> = responses(MODELS)
        .into_iter()
        .map(|envelope| envelope.body)
        .filter(|body| body.tag() == "set_thinking_level")
        .collect();
    assert_eq!(
        sets.len(),
        2,
        "one `set_thinking_level` with `off`, one with an invalid value"
    );
    assert!(
        sets.iter().all(|body| matches!(body, Response::SetThinkingLevel)),
        "pi does not validate the level: {sets:?}"
    );

    let states: Vec<SessionState> = responses(MODELS)
        .into_iter()
        .filter_map(|envelope| match envelope.body {
            Response::GetState(state) => Some(state),
            _ => None,
        })
        .collect();
    assert_eq!(states[0].thinking_level, ThinkingLevel::Off);
    assert_eq!(states[1].thinking_level, ThinkingLevel::Low);

    let levels: Vec<ThinkingLevel> = fixture(MODELS)
        .into_iter()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(&line).expect("a JSON record");
            match pi_rpc::event::decode_event_value(value) {
                Ok(Event::ThinkingLevelChanged(changed)) => Some(changed.level),
                _ => None,
            }
        })
        .collect();
    assert_eq!(levels, vec![ThinkingLevel::Off, ThinkingLevel::Low]);
}

#[test]
fn decodes_a_cycled_thinking_level() {
    let Response::CycleThinkingLevel(Some(level)) = response(MODELS, "cycle_thinking_level").body else {
        panic!("cycle_thinking_level answered no level");
    };
    assert_eq!(level.level, ThinkingLevel::Low);
}

#[test]
fn decodes_session_stats_with_context_usage() {
    let Response::GetSessionStats(stats) = response(PROBE, "get_session_stats").body else {
        panic!("get_session_stats answered something else");
    };
    assert_eq!(stats.tokens.total, 0.0);
    assert_eq!(stats.total_messages, 0);
    assert_eq!(stats.session_file, None, "pi omits sessionFile when not persisted");

    let usage = stats.context_usage.expect("the fixture reports context usage");
    assert_eq!(usage.context_window, 512_000.0);
    assert_eq!(usage.tokens, Some(0.0));
}

#[test]
fn decodes_entries_and_tree_variants() {
    let entries = entries_in(BASH);
    assert_eq!(
        match response(BASH, "get_entries").body {
            Response::GetEntries(list) => list.leaf_id.map(|id| id.len()),
            _ => None,
        },
        Some(8)
    );
    assert!(matches!(entries[0], Entry::ModelChange(_)));
    assert!(matches!(entries[1], Entry::ThinkingLevelChange(_)));
    assert!(matches!(entries[2], Entry::SessionInfo(_)));

    let Response::GetTree(tree) = response(BASH, "get_tree").body else {
        panic!("get_tree answered something else");
    };
    let root = &tree.tree[0];
    assert!(matches!(root.entry, Entry::ModelChange(_)));
    assert_eq!(root.children.len(), 1, "the tree nests children");
}

#[test]
fn decodes_an_omitted_last_assistant_text() {
    let answer = raw(PROBE, "get_last_assistant_text");
    assert_eq!(
        answer.get("data"),
        Some(&serde_json::json!({})),
        "pi sends an empty object, not `null`"
    );
    assert!(
        matches!(
            response(PROBE, "get_last_assistant_text").body,
            Response::GetLastAssistantText(None)
        ),
        "an empty object is no text"
    );
}

#[test]
fn surfaces_a_failed_command_as_an_error() {
    let Response::Error(failed) = response(PROBE, "bogus_command").body else {
        panic!("an unknown command answered something else");
    };
    assert_eq!(failed.command, "bogus_command", "the refusal echoes what was sent");
    assert_eq!(failed.error, "Unknown command: bogus_command");
}

#[test]
fn surfaces_a_parse_failure_that_has_no_id() {
    let answer = raw(PROBE, "parse");
    assert_eq!(answer.get("id"), None, "parse errors are not correlated to a request");
    let Response::Error(failed) = response(PROBE, "parse").body else {
        panic!("a parse failure answered something else");
    };
    assert!(
        failed.error.starts_with("Failed to parse command:"),
        "got {}",
        failed.error
    );
}

#[test]
fn decodes_events_that_arrived_during_the_session() {
    let events = events_in(BASH);

    assert!(events.iter().any(|event| matches!(
        event,
        Event::SessionInfoChanged(info) if info.name.as_deref() == Some("pie recording bash")
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        Event::QueueUpdate(queue) if queue.steering.is_empty() && queue.follow_up.is_empty()
    )));
}

#[test]
fn decodes_extension_ui_requests_and_status_updates() {
    let requests: Vec<UiRequest> = fixture(BASH)
        .into_iter()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(&line).expect("a JSON record");
            match value.get("type").and_then(|v| v.as_str()) {
                Some("extension_ui_request") => Some(pi_rpc::extui::decode_ui_request_value(value).expect(BASH)),
                _ => None,
            }
        })
        .collect();
    assert!(!requests.is_empty());

    let cleared = requests
        .iter()
        .find_map(|request| match request {
            UiRequest::SetStatus(status) if status.status_text.is_none() => Some(&status.status_key),
            _ => None,
        })
        .expect("a setStatus request with no text");
    assert!(!cleared.is_empty());
}

#[test]
fn decodes_the_recorded_system_message() {
    let Message::System(system) = &messages_in(TRANSCRIPT)[0] else {
        panic!("the first message is the system prompt");
    };

    // pi sends an empty `content` and carries the prompt in named sections; the
    // sanitization of this fixture trims what is inside them.
    assert_eq!(system.content, SystemContent::Text(String::new()));
    let sections = system.sections.as_ref().expect("the prompt declares sections");
    assert!(sections.len() > 1, "the prompt is split into named sections");
    assert!(sections.values().all(Option::is_some), "this run removes no section");
    assert!(system.tools_added.is_some(), "the prompt declares the tools it adds");
}

#[test]
fn decodes_the_recorded_user_message() {
    let Message::User(user) = &messages_in(TRANSCRIPT)[1] else {
        panic!("the second message is the user turn");
    };

    let UserContent::Blocks(parts) = &user.content else {
        panic!("a recorded user message carries content blocks");
    };
    assert!(
        matches!(parts.as_slice(), [UserBlock::Text(text)] if text.text.starts_with("Use the bash tool")),
        "unexpected blocks: {parts:?}"
    );
}

#[test]
fn decodes_the_recorded_assistant_message_with_a_tool_call() {
    let Message::Assistant(assistant) = &messages_in(TRANSCRIPT)[2] else {
        panic!("the third message is the assistant turn");
    };

    assert_eq!(assistant.stop_reason, StopReason::ToolUse);
    assert_eq!(assistant.provider, "cheapest");
    assert_eq!(assistant.model, "@preset/deepseek-v4-flash-0731");
    assert_eq!(assistant.raw_stop_reason.as_deref(), Some("tool_calls"));
    assert!(
        assistant.usage.reasoning.is_some_and(|reasoning| reasoning > 0.0),
        "a reasoning model reports the tokens it spent thinking"
    );
    assert!(assistant.usage.total_tokens >= assistant.usage.input);

    assert!(
        assistant.content.iter().any(|block| matches!(
            block,
            AssistantBlock::ToolCall(call) if call.name == "bash" && call.arguments.contains_key("command")
        )),
        "the model should have called bash: {:?}",
        assistant.content
    );
}

#[test]
fn decodes_the_recorded_tool_result() {
    let Message::ToolResult(result) = &messages_in(TRANSCRIPT)[3] else {
        panic!("the fourth message is the tool result");
    };

    assert!(!result.is_error);
    assert_eq!(result.tool_name, "bash");
    assert!(matches!(
        result.content.as_slice(),
        [UserBlock::Text(text)] if text.text.contains("1.1.0")
    ));
    assert_eq!(result.nested_calls, None, "a plain tool result records no nested calls");
}

#[test]
fn decodes_the_recorded_session_entries() {
    let entries = entries_in(TRANSCRIPT);

    assert!(entries.iter().any(|entry| matches!(entry, Entry::Message(_))));
    assert!(entries.iter().any(|entry| matches!(entry, Entry::ModelChange(_))));
    assert!(
        entries
            .iter()
            .any(|entry| matches!(entry, Entry::ThinkingLevelChange(_)))
    );

    let custom = entries
        .iter()
        .find_map(|entry| match entry {
            Entry::Custom(custom) => Some(custom),
            _ => None,
        })
        .expect("an extension stored its own entry");
    assert_eq!(custom.custom_type, "om.observations.recorded");
    assert!(custom.data.is_some(), "the extension payload is kept verbatim");
}

#[test]
fn decodes_the_model_a_set_model_switch_returns() {
    let Response::SetModel(model) = response(TRANSCRIPT, "set_model").body else {
        panic!("set_model answered something else");
    };

    assert_eq!(model.id, "@preset/deepseek-v4-flash-0731");
    assert_eq!(model.provider, "cheapest");
    assert!(model.reasoning);
    assert!(model.context_window.is_some_and(|window| window > 0.0));
}

#[test]
fn decodes_the_notify_requests_pi_sends() {
    let notifications = fixture(TRANSCRIPT)
        .into_iter()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(&line).expect("a JSON record");
            match value.get("type").and_then(|v| v.as_str()) {
                Some("extension_ui_request") => Some(pi_rpc::extui::decode_ui_request_value(value).expect(TRANSCRIPT)),
                _ => None,
            }
        })
        .filter(|request| matches!(request, UiRequest::Notify(_)))
        .count();

    assert!(notifications > 0, "pi notifies the client while tools run");
}

#[test]
fn decodes_a_supplemental_system_message_that_removes_a_section() {
    let Message::System(system) = &messages_in(SUPPLEMENT)[0] else {
        panic!("the supplement starts with a system message");
    };

    let sections = system.sections.as_ref().expect("the supplement declares sections");
    assert_eq!(sections.get("tools"), Some(&None), "null removes a section");
    assert!(system.tools_removed.is_some(), "the supplement also removes a tool");
}

#[test]
fn decodes_a_message_with_an_image_part() {
    let Message::User(user) = &messages_in(SUPPLEMENT)[1] else {
        panic!("the supplement carries a user message");
    };

    let UserContent::Blocks(parts) = &user.content else {
        panic!("the message carries content blocks");
    };
    assert!(matches!(
        parts.as_slice(),
        [UserBlock::Text(_), UserBlock::Image(image)] if image.mime_type == "image/png"
    ));
}

#[test]
fn decodes_an_assistant_message_with_a_thinking_part() {
    let Message::Assistant(assistant) = &messages_in(SUPPLEMENT)[2] else {
        panic!("the supplement carries an assistant message");
    };

    assert_eq!(assistant.thinking_level, Some(ThinkingLevel::Max));
    assert_eq!(assistant.provider_thinking_level.as_deref(), Some("max"));
    assert_eq!(assistant.usage.reasoning, Some(5.0));
    assert!(assistant.content.iter().any(|block| matches!(
        block,
        AssistantBlock::Thinking(thinking)
            if thinking.redacted == Some(false) && thinking.thinking_signature.is_some()
    )));
    assert!(assistant.content.iter().any(|block| matches!(
        block,
        AssistantBlock::ToolCall(call) if call.namespace.is_some() && call.thought_signature.is_some()
    )));
}

#[test]
fn decodes_a_tool_result_with_nested_calls() {
    let Message::ToolResult(result) = &messages_in(SUPPLEMENT)[3] else {
        panic!("the supplement ends with a tool result");
    };

    assert_eq!(
        result.details.as_ref().and_then(|details| details["lines"].as_u64()),
        Some(3)
    );
    assert!(result.usage.is_some(), "the supplement records tool usage");

    let nested = result.nested_calls.as_ref().expect("the result records nested calls");
    assert!(!nested.complete, "an unfinished call makes the record incomplete");
    assert_eq!(nested.calls[1].status, NestedStatus::Unfinished);
    assert_eq!(nested.calls[1].arguments, None, "oversized arguments are omitted");
    assert_eq!(nested.calls[1].arguments_bytes, Some(42.0));
}

#[test]
fn decodes_the_recorded_streaming_deltas() {
    let deltas = deltas_in(TRANSCRIPT);

    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::ToolcallStart(start) if start.tool_name == "bash"
    )));
    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::ToolcallDelta(delta) if !delta.delta.is_empty()
    )));
    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::ToolcallEnd(end) if end.tool_call.name == "bash"
    )));
    assert!(
        deltas
            .iter()
            .any(|update| matches!(update, AssistantUpdate::TextStart(_)))
    );
    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::TextDelta(delta) if !delta.delta.is_empty()
    )));
    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::TextEnd(end) if end.content == "1.1.0"
    )));
}

/// `done` and `error` never appeared in any recording of this release: RPC mode
/// forwards `start`, `*_delta` and `*_end` only. The supplement holds them
/// because the TS union declares them.
#[test]
fn decodes_the_deltas_no_recording_reaches_yet() {
    let deltas = deltas_in(SUPPLEMENT);

    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::Done(done)
            if done.reason == StopReason::ToolUse && done.message.stop_reason == StopReason::ToolUse
    )));
    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::Error(failed)
            if failed.reason == StopReason::Aborted
                && failed.error.error_message.as_deref() == Some("aborted by client")
    )));
}

#[test]
fn decodes_the_recorded_tool_execution_events() {
    let events = events_in(TRANSCRIPT);

    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolExecutionStart(start)
            if start.tool_name == "bash"
                && start.parent_tool_call_id.is_none()
                && start.args["command"].as_str().is_some_and(|command| command.contains("version"))
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::ToolExecutionUpdate(_)))
    );
    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolExecutionEnd(end) if !end.tool_call_id.is_empty() && !end.is_error
    )));
}

#[test]
fn decodes_a_nested_tool_execution() {
    let events = events_in(SUPPLEMENT);

    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolExecutionUpdate(update)
            if update.parent_tool_call_id.as_deref() == Some("call_1")
    )));
}

#[test]
fn decodes_the_recorded_agent_end() {
    let events = events_in(TRANSCRIPT);
    let settled = events
        .iter()
        .find_map(|event| match event {
            Event::AgentEnd(end) => Some(end),
            _ => None,
        })
        .expect("the recording settles a run");

    assert_eq!(
        settled.messages.len(),
        5,
        "the settled run carries the whole transcript"
    );
    assert!(!settled.will_retry);
    assert!(
        events.iter().any(|event| matches!(event, Event::AgentSettled(_))),
        "pi reports that it became idle"
    );
}

#[test]
fn every_recorded_run_reports_whether_it_was_aborted() {
    // `aborted` arrived with pi 1.1.0 and is required, so a client that reads
    // the field can tell a stopped run from a finished one.
    for name in FIXTURES {
        for event in events_in(name) {
            if let Event::AgentSettled(settled) = event {
                assert!(!settled.aborted, "{name}: a recorded run finished on its own");
            }
        }
    }
}

#[test]
fn decodes_retry_events_and_an_aborted_compaction() {
    let events = events_in(SUPPLEMENT);

    // A compaction the summarizer aborted reports `aborted: true`. The recorded
    // failures report `aborted: false` with an error message instead.
    assert!(events.iter().any(|event| matches!(
        event,
        Event::CompactionEnd(done)
            if done.reason == CompactionReason::Manual
                && done.result.is_none()
                && done.aborted
                && done.error_message.as_deref() == Some("summarizer failed")
    )));

    assert!(events.iter().any(|event| matches!(
        event,
        Event::AutoRetryStart(start)
            if start.attempt == 1 && start.max_attempts == 3 && start.delay_ms == 500
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        Event::AutoRetryEnd(end)
            if !end.success && end.final_error.as_deref() == Some("overloaded")
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::SummarizationRetryScheduled(_)))
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::SummarizationRetryFinished))
    );
}

#[test]
fn decodes_extension_errors() {
    let errors: Vec<_> = events_in(SUPPLEMENT)
        .into_iter()
        .filter_map(|event| match event {
            Event::ExtensionError(fault) => Some(fault),
            _ => None,
        })
        .collect();

    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].event, "tool_call");
    assert_eq!(errors[0].error, "boom");
    assert!(errors[0].extension_path.ends_with("thing.ts"));
}

/// The strongest invariant in this file: every payload a recorded success
/// carries must decode into the type its command documents, and a command that
/// answers with nothing must carry no payload at all.
#[test]
fn every_recorded_payload_decodes() {
    /// The commands whose answer is the success flag alone.
    const EMPTY: [&str; 9] = [
        "abort",
        "abort_bash",
        "abort_retry",
        "set_auto_compaction",
        "set_auto_retry",
        "set_follow_up_mode",
        "set_session_name",
        "set_steering_mode",
        "set_thinking_level",
    ];

    for name in FIXTURES {
        for line in fixture(name) {
            let value: serde_json::Value = serde_json::from_str(&line).expect("a JSON record");
            if value.get("type").and_then(|kind| kind.as_str()) != Some("response") {
                continue;
            }
            if value.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
                continue;
            }
            let command = value
                .get("command")
                .and_then(|one| one.as_str())
                .unwrap_or_default()
                .to_string();
            if EMPTY.contains(&command.as_str()) {
                assert_eq!(value.get("data"), None, "{name}: `{command}` answered with a payload");
            }
            match pi_rpc::response::decode_envelope_value(value) {
                Ok(Envelope {
                    body: Response::Unknown(unknown),
                    ..
                }) => panic!("{name}: no type for `{}`", unknown.command),
                Ok(Envelope {
                    body: Response::Error(failed),
                    ..
                }) => panic!("{name}: a recorded success answered {}", failed.error),
                Ok(_) => {}
                Err(error) => panic!("{name}: `{command}` did not decode: {error}"),
            }
        }
    }
}

#[test]
fn decodes_a_recorded_bash_execution_message() {
    let messages = messages_in(TOUR);
    let execution = messages
        .iter()
        .find_map(|message| match message {
            Message::BashExecution(execution) => Some(execution),
            _ => None,
        })
        .expect("a recorded session keeps its `!` command in the transcript");

    assert_eq!(execution.command, "for i in 1 2 3; do echo tick $i; sleep 1; done");
    assert_eq!(execution.exit_code, Some(0.0));
    assert!(!execution.cancelled && !execution.truncated);
    assert!(execution.timestamp > 0.0);
}

#[test]
fn decodes_recorded_bash_results() {
    let answers: Vec<BashResult> = responses(TOUR)
        .into_iter()
        .filter_map(|envelope| match envelope.body {
            Response::Bash(result) => Some(result),
            _ => None,
        })
        .collect();

    assert_eq!(answers.len(), 2, "one finished command and one that was aborted");
    assert!(
        answers
            .iter()
            .any(|result| result.exit_code == Some(0.0) && !result.cancelled),
        "the finished command reports its code: {answers:?}"
    );
    let aborted = answers.iter().find(|result| result.cancelled).expect("one was aborted");
    assert_eq!(aborted.exit_code, None, "a killed command reports no exit code");
    assert!(aborted.output.is_empty());
}

#[test]
fn decodes_recorded_queue_updates() {
    let Response::Steer(steer) = response(TOUR, "steer").body else {
        panic!("steer answered something else");
    };
    let Response::FollowUp(follow_up) = response(TOUR, "follow_up").body else {
        panic!("follow_up answered something else");
    };

    assert_eq!(steer.disposition, QueuedInputDisposition::Queued);
    assert_eq!(follow_up.disposition, QueuedInputDisposition::Queued);
    assert!(
        events_in(TOUR)
            .iter()
            .any(|event| matches!(event, Event::QueueUpdate(_))),
        "pi reports the queue back while a run is streaming"
    );
}

#[test]
fn decodes_recorded_thinking() {
    // The message keeps the reasoning block next to the text it produced.
    let messages = messages_in(TOUR);
    let assistant = messages
        .iter()
        .find_map(|message| match message {
            Message::Assistant(assistant) => Some(assistant),
            _ => None,
        })
        .expect("the recording has an assistant turn");
    assert!(assistant.content.iter().any(|block| matches!(
        block,
        AssistantBlock::Thinking(thinking) if !thinking.thinking.is_empty()
    )));

    let deltas = deltas_in(TOUR);
    assert!(
        deltas
            .iter()
            .any(|update| matches!(update, AssistantUpdate::ThinkingStart(_)))
    );
    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::ThinkingDelta(delta) if !delta.delta.is_empty()
    )));
    assert!(deltas.iter().any(|update| matches!(
        update,
        AssistantUpdate::ThinkingEnd(end) if !end.content.is_empty()
    )));
}

#[test]
fn decodes_a_recorded_compaction() {
    let entry = entries_in(BRANCH)
        .into_iter()
        .find_map(|entry| match entry {
            Entry::Compaction(compaction) => Some(compaction),
            _ => None,
        })
        .expect("the recorded session compacted");
    assert!(!entry.summary.is_empty());
    assert!(entry.tokens_before > 0.0);

    let done = events_in(BRANCH)
        .into_iter()
        .find_map(|event| match event {
            Event::CompactionEnd(done) if done.result.is_some() => Some(done),
            _ => None,
        })
        .expect("the recording compacted");
    assert_eq!(done.reason, CompactionReason::Manual);
    assert!(!done.aborted);
    let result = done.result.expect("the recorded compaction carries its result");
    assert_eq!(
        result.first_kept_entry_id, entry.first_kept_entry_id,
        "the event and the appended entry describe the same compaction"
    );
    assert!(result.usage.is_some(), "the summary call's usage is reported");
}

#[test]
fn decodes_a_recorded_fork() {
    let Response::GetForkMessages(forkable) = response(BRANCH, "get_fork_messages").body else {
        panic!("get_fork_messages answered something else");
    };
    assert!(!forkable.is_empty(), "the recording has something to fork from");

    let Response::Fork(forked) = response(BRANCH, "fork").body else {
        panic!("fork answered something else");
    };
    assert!(!forked.cancelled);
    assert_eq!(
        forked.text.as_deref(),
        Some(forkable[0].text.as_str()),
        "the fork echoes the entry it started from"
    );
}

#[test]
fn decodes_a_recorded_session_switch() {
    let Response::GetState(state) = response(SESSION, "get_state").body else {
        panic!("get_state answered something else");
    };
    assert!(state.session_file.is_some(), "a file-backed session reports its path");

    let Response::SwitchSession(switched) = response(SESSION, "switch_session").body else {
        panic!("switch_session answered something else");
    };
    assert!(!switched.cancelled);
}

#[test]
fn decodes_a_recorded_rejection() {
    let Response::Error(rejected) = response(FAILURES, "set_model").body else {
        panic!("a model outside the catalog answered something else");
    };
    assert!(
        rejected.error.contains("Model not found"),
        "a model outside the catalog is refused: {}",
        rejected.error
    );

    // A compaction that could not run reports the reason on the event, not as an
    // abort, and produces no result.
    let failed = events_in(FAILURES)
        .into_iter()
        .find_map(|event| match event {
            Event::CompactionEnd(done) => Some(done),
            _ => None,
        })
        .expect("the recording attempted a compaction");
    assert!(failed.result.is_none() && !failed.aborted);
    assert!(
        failed
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("Nothing to compact")),
        "got {:?}",
        failed.error_message
    );
}
