//! Replays the recorded stdout of a real `pi --mode rpc` through the mirrored
//! types. The corpus and its provenance are described in `tests/fixtures`.

use std::path::PathBuf;

use pie_lib::pi_rpc::protocol::{
    AgentMessage, AssistantContentPart, AssistantMessageEvent, BashResult, CompactionReason, CompactionResult,
    DoneReason, ErrorReason, Event, ExtensionUiRequestKind, Model, ModelThinkingLevel, ModelType, NestedToolCallStatus,
    QueuedInputDisposition, Response, ServerMessage, SessionEntry, SessionState, SessionStats, StopReason,
    SystemContent, ToolResultContentPart, UserContent, UserContentPart,
};
use pie_lib::pi_rpc::protocol::{
    AvailableModelsData, AvailableThinkingLevelsData, ClearQueueData, CloneData, CommandsData, CycleModelData,
    CycleThinkingLevelData, EntriesData, ExportHtmlData, ForkData, ForkMessagesData, LastAssistantTextData,
    MessagesData, NewSessionData, PromptData, QueuedInputData, SwitchSessionData, TreeData,
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

/// Every response in a fixture.
fn responses(name: &str) -> Vec<Response> {
    fixture(name)
        .into_iter()
        .filter_map(|line| ServerMessage::parse(&line).into_response())
        .collect()
}

/// The response to one command in a fixture.
fn response(name: &str, command: &str) -> Response {
    responses(name)
        .into_iter()
        .find(|response| response.command == command)
        .unwrap_or_else(|| panic!("{name} has no `{command}` response"))
}

/// Every event in a fixture.
fn events_in(name: &str) -> Vec<Event> {
    fixture(name)
        .into_iter()
        .filter_map(|line| ServerMessage::parse(&line).into_event())
        .collect()
}

/// Every `message_update` delta in a fixture.
fn deltas_in(name: &str) -> Vec<AssistantMessageEvent> {
    events_in(name)
        .into_iter()
        .filter_map(|event| match event {
            Event::MessageUpdate {
                assistant_message_event,
                ..
            } => Some(assistant_message_event),
            _ => None,
        })
        .collect()
}

/// The messages a recorded `get_messages` response reports.
fn messages_in(name: &str) -> Vec<AgentMessage> {
    response(name, "get_messages")
        .decode::<MessagesData>()
        .unwrap_or_else(|error| panic!("{name}: {error}"))
        .messages
}

const PROBE: &str = "session-probe-0.99.2.jsonl";
const BASH: &str = "bash-session-0.99.2.jsonl";
const MODELS: &str = "model-probe-0.99.2.jsonl";
const TRANSCRIPT: &str = "transcript-0.99.2.jsonl";
const TOUR: &str = "tour-0.99.2.jsonl";
const BRANCH: &str = "branch-0.99.2.jsonl";
const FAILURES: &str = "failures-0.99.2.jsonl";
const SESSION: &str = "session-0.99.2.jsonl";
const SUPPLEMENT: &str = "derived-supplement-0.99.2.jsonl";

/// Every fixture, recorded and supplemented.
const FIXTURES: [&str; 9] = [
    PROBE, BASH, MODELS, TRANSCRIPT, TOUR, BRANCH, FAILURES, SESSION, SUPPLEMENT,
];

#[test]
fn every_record_maps_to_a_mirrored_type() {
    for name in FIXTURES {
        for line in fixture(name) {
            match ServerMessage::parse(&line) {
                ServerMessage::Unknown { raw } => panic!("{name}: no mirrored type for {raw}"),
                ServerMessage::Unparseable { error, .. } => panic!("{name}: unparseable: {error}"),
                _ => {}
            }
        }
    }
}

#[test]
fn decodes_the_session_state() {
    let response = response(PROBE, "get_state");
    assert!(response.is_success());
    let state: SessionState = response.decode().unwrap();

    assert_eq!(state.thinking_level, ModelThinkingLevel::High);
    assert!(!state.is_streaming);
    assert!(state.auto_compaction_enabled);
    assert_eq!(state.session_id, "00000000-0000-4000-8000-000000000000");

    let model = state.model.expect("the fixture session has a model");
    assert_eq!(model.api, "openai-completions");
    assert_eq!(model.model_type, None, "pi omits `type` for chat models");
    assert!(model.reasoning);
    assert_eq!(model.input, vec![pie_lib::pi_rpc::protocol::InputModality::Text]);
    let map = model.thinking_level_map.expect("thinkingLevelMap is present");
    assert_eq!(map.low, Some(Some("low".to_string())));
    assert_eq!(map.medium, Some(None), "null marks a level the model does not support");
    assert!(model.compat.is_some(), "provider compat is kept raw");
}

#[test]
fn decodes_thinking_levels_including_off() {
    let levels: AvailableThinkingLevelsData = response(PROBE, "get_available_thinking_levels").decode().unwrap();
    assert_eq!(
        levels.levels,
        vec![
            ModelThinkingLevel::Off,
            ModelThinkingLevel::Low,
            ModelThinkingLevel::High,
            ModelThinkingLevel::Max
        ]
    );
}

#[test]
fn decodes_slash_commands_with_source_metadata() {
    let commands: CommandsData = response(PROBE, "get_commands").decode().unwrap();
    assert!(!commands.commands.is_empty());

    let first = &commands.commands[0];
    assert!(!first.name.is_empty());
    assert_eq!(first.source_info.scope, pie_lib::pi_rpc::protocol::SourceScope::User);
    assert_eq!(
        first.source_info.origin,
        pie_lib::pi_rpc::protocol::SourceOrigin::Package
    );
    assert!(first.source_info.path.starts_with('/'));

    // The catalog mixes word styles: `package` here, `top-level` further down.
    assert!(
        commands
            .commands
            .iter()
            .any(|command| command.source_info.origin == pie_lib::pi_rpc::protocol::SourceOrigin::TopLevel),
        "a top-level command must decode too"
    );
}

#[test]
fn decodes_available_models() {
    let models: AvailableModelsData = response(MODELS, "get_available_models").decode().unwrap();
    assert!(!models.models.is_empty());

    for model in &models.models {
        assert_eq!(
            model.model_type,
            Some(ModelType::Chat),
            "the catalog writes the optional `type` that `get_state` omits"
        );
        assert!(model.reasoning);
        assert!(model.context_window > 0 && model.max_tokens > 0);
        assert!(!model.input.is_empty());
        assert!(model.compat.is_some(), "provider compat is kept raw");
    }

    // The two spellings of "unsupported" both appear in real output: the catalog
    // omits the level, while `get_state` lists it as `null` - which is why the
    // mirror keeps an absent key apart from an explicit `null`.
    let map = models.models[0]
        .thinking_level_map
        .as_ref()
        .expect("the first catalog entry carries a map");
    assert_eq!(map.off, None, "an unlisted level is absent");
    assert_eq!(map.medium, Some(None), "a listed but unsupported level is null");
}

#[test]
fn accepts_off_as_a_thinking_level() {
    // pi accepts `off` for `set_thinking_level`, and both the event and the
    // session state carry it - so a level is a `ModelThinkingLevel`.
    let sets: Vec<Response> = responses(MODELS)
        .into_iter()
        .filter(|response| response.command == "set_thinking_level")
        .collect();
    assert_eq!(
        sets.len(),
        2,
        "one `set_thinking_level` with `off`, one with an invalid value"
    );
    assert!(
        sets.iter().all(Response::is_success),
        "pi does not validate the level, so the mirrored type stays the documented value space"
    );

    let states: Vec<SessionState> = responses(MODELS)
        .into_iter()
        .filter(|response| response.command == "get_state")
        .map(|response| response.decode().unwrap())
        .collect();
    assert_eq!(states[0].thinking_level, ModelThinkingLevel::Off);
    assert_eq!(states[1].thinking_level, ModelThinkingLevel::Low);

    let levels: Vec<ModelThinkingLevel> = fixture(MODELS)
        .into_iter()
        .filter_map(|line| match ServerMessage::parse(&line) {
            ServerMessage::Event(Event::ThinkingLevelChanged { level }) => Some(level),
            _ => None,
        })
        .collect();
    assert_eq!(levels, vec![ModelThinkingLevel::Off, ModelThinkingLevel::Low]);
}

#[test]
fn decodes_a_cycled_thinking_level() {
    let cycled: CycleThinkingLevelData = response(MODELS, "cycle_thinking_level").decode().unwrap();
    assert_eq!(cycled.level, ModelThinkingLevel::Low);
}

#[test]
fn decodes_session_stats_with_context_usage() {
    let stats: SessionStats = response(PROBE, "get_session_stats").decode().unwrap();
    assert_eq!(stats.tokens.total, 0);
    assert_eq!(stats.total_messages, 0);
    assert_eq!(stats.session_file, None, "pi omits sessionFile when not persisted");

    let usage = stats.context_usage.expect("the fixture reports context usage");
    assert_eq!(usage.context_window, 512_000);
    assert_eq!(usage.tokens, Some(0));
}

#[test]
fn decodes_entries_and_tree_variants() {
    let entries: EntriesData = response(BASH, "get_entries").decode().unwrap();
    assert_eq!(entries.leaf_id.as_deref().map(str::len), Some(8));
    assert!(matches!(entries.entries[0], SessionEntry::ModelChange(_)));
    assert!(matches!(entries.entries[1], SessionEntry::ThinkingLevelChange(_)));
    assert!(matches!(entries.entries[2], SessionEntry::SessionInfo(_)));

    let tree: TreeData = response(BASH, "get_tree").decode().unwrap();
    let root = &tree.tree[0];
    assert!(matches!(root.entry, SessionEntry::ModelChange(_)));
    assert_eq!(root.children.len(), 1, "the tree nests children");
}

#[test]
fn decodes_an_omitted_last_assistant_text() {
    let response = response(PROBE, "get_last_assistant_text");
    assert_eq!(
        response.data,
        Some(serde_json::json!({})),
        "pi sends an empty object, not `null`"
    );
    let text: LastAssistantTextData = response.decode().unwrap();
    assert_eq!(text.text, None);
}

#[test]
fn surfaces_a_failed_command_as_an_error() {
    let unknown = response(PROBE, "bogus_command");
    assert!(!unknown.is_success());
    let error = unknown.into_result().unwrap_err();
    assert_eq!(
        error.to_string(),
        "pi rejected `bogus_command`: Unknown command: bogus_command"
    );
}

#[test]
fn surfaces_a_parse_failure_that_has_no_id() {
    let parse_error = response(PROBE, "parse");
    assert_eq!(parse_error.id, None, "parse errors are not correlated to a request");
    assert!(!parse_error.is_success());
    assert!(parse_error.error.unwrap().starts_with("Failed to parse command:"));
}

#[test]
fn decodes_events_that_arrived_during_the_session() {
    let events = events_in(BASH);

    assert!(events.iter().any(|event| matches!(
        event,
        Event::SessionInfoChanged { name: Some(name) } if name == "pie conformance"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        Event::QueueUpdate { steering, follow_up } if steering.is_empty() && follow_up.is_empty()
    )));
}

#[test]
fn decodes_extension_ui_requests_and_status_updates() {
    let requests: Vec<_> = fixture(BASH)
        .into_iter()
        .filter_map(|line| match ServerMessage::parse(&line) {
            ServerMessage::ExtensionUiRequest(request) => Some(request),
            _ => None,
        })
        .collect();
    assert!(!requests.is_empty());

    let cleared = requests
        .iter()
        .find_map(|request| match &request.request {
            ExtensionUiRequestKind::SetStatus {
                status_key,
                status_text,
            } if status_text.is_none() => Some(status_key.clone()),
            _ => None,
        })
        .expect("a setStatus request with no text");
    assert!(!cleared.is_empty());
}

#[test]
fn decodes_the_recorded_system_message() {
    let AgentMessage::System(system) = &messages_in(TRANSCRIPT)[0] else {
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
    let AgentMessage::User(user) = &messages_in(TRANSCRIPT)[1] else {
        panic!("the second message is the user turn");
    };

    let UserContent::Parts(parts) = &user.content else {
        panic!("a recorded user message carries content parts");
    };
    assert!(
        matches!(parts.as_slice(), [UserContentPart::Text(text)] if text.text.starts_with("Read package.json")),
        "unexpected parts: {parts:?}"
    );
}

#[test]
fn decodes_the_recorded_assistant_message_with_a_tool_call() {
    let AgentMessage::Assistant(assistant) = &messages_in(TRANSCRIPT)[2] else {
        panic!("the third message is the assistant turn");
    };

    assert_eq!(assistant.stop_reason, StopReason::ToolUse, "the camelCase stop reason");
    assert_eq!(assistant.provider, "openrouter");
    assert_eq!(assistant.model, "stealth/space-bunny-alpha");
    assert_eq!(assistant.raw_stop_reason.as_deref(), Some("tool_calls"));
    assert_eq!(
        assistant.usage.reasoning,
        Some(0),
        "a provider may report zero reasoning tokens"
    );
    assert!(assistant.usage.total_tokens >= assistant.usage.input);

    assert!(
        assistant.content.iter().any(|part| matches!(
            part,
            AssistantContentPart::ToolCall(call) if call.name == "bash" && call.arguments.contains_key("command")
        )),
        "the model should have called bash: {:?}",
        assistant.content
    );
}

#[test]
fn decodes_the_recorded_tool_result() {
    let AgentMessage::ToolResult(result) = &messages_in(TRANSCRIPT)[3] else {
        panic!("the fourth message is the tool result");
    };

    assert!(!result.is_error);
    assert_eq!(result.tool_name, "bash");
    assert!(matches!(
        result.content.as_slice(),
        [ToolResultContentPart::Text(text)] if text.text.contains("0.99.2")
    ));
    assert_eq!(result.nested_calls, None, "a plain tool result records no nested calls");
}

#[test]
fn decodes_the_recorded_session_entries() {
    let entries: EntriesData = response(TRANSCRIPT, "get_entries").decode().unwrap();

    assert!(
        entries
            .entries
            .iter()
            .any(|entry| matches!(entry, SessionEntry::Message(_)))
    );
    assert!(
        entries
            .entries
            .iter()
            .any(|entry| matches!(entry, SessionEntry::ModelChange(_)))
    );
    assert!(
        entries
            .entries
            .iter()
            .any(|entry| matches!(entry, SessionEntry::ThinkingLevelChange(_)))
    );

    let custom = entries
        .entries
        .iter()
        .find_map(|entry| match entry {
            SessionEntry::Custom(custom) => Some(custom),
            _ => None,
        })
        .expect("an extension stored its own entry");
    assert_eq!(custom.custom_type, "om.observations.recorded");
    assert!(custom.data.is_some(), "the extension payload is kept raw");
}

#[test]
fn decodes_the_model_a_set_model_switch_returns() {
    let model: Model = response(TRANSCRIPT, "set_model").decode().unwrap();

    assert_eq!(model.id, "stealth/space-bunny-alpha");
    assert_eq!(model.provider, "openrouter");
    assert!(model.reasoning);
    assert!(model.context_window > 0);
}

#[test]
fn decodes_the_notify_requests_pi_sends() {
    let notifications = fixture(TRANSCRIPT)
        .into_iter()
        .filter_map(|line| match ServerMessage::parse(&line) {
            ServerMessage::ExtensionUiRequest(request) => Some(request),
            _ => None,
        })
        .filter(|request| matches!(&request.request, ExtensionUiRequestKind::Notify { .. }))
        .count();

    assert!(notifications > 0, "pi notifies the client while tools run");
}

#[test]
fn decodes_a_supplemental_system_message_that_removes_a_section() {
    let AgentMessage::System(system) = &messages_in(SUPPLEMENT)[0] else {
        panic!("the supplement starts with a system message");
    };

    let sections = system.sections.as_ref().expect("the supplement declares sections");
    assert_eq!(sections.get("tools"), Some(&None), "null removes a section");
    assert!(system.tools_removed.is_some(), "the supplement also removes a tool");
}

#[test]
fn decodes_a_message_with_an_image_part() {
    let AgentMessage::User(user) = &messages_in(SUPPLEMENT)[1] else {
        panic!("the supplement carries a user message");
    };

    let UserContent::Parts(parts) = &user.content else {
        panic!("the message carries content parts");
    };
    assert!(matches!(
        parts.as_slice(),
        [UserContentPart::Text(_), UserContentPart::Image(image)] if image.mime_type == "image/png"
    ));
}

#[test]
fn decodes_an_assistant_message_with_a_thinking_part() {
    let AgentMessage::Assistant(assistant) = &messages_in(SUPPLEMENT)[2] else {
        panic!("the supplement carries an assistant message");
    };

    assert_eq!(assistant.thinking_level, Some(ModelThinkingLevel::Max));
    assert_eq!(assistant.provider_thinking_level.as_deref(), Some("max"));
    assert_eq!(assistant.usage.reasoning, Some(5));
    assert!(assistant.content.iter().any(|part| matches!(
        part,
        AssistantContentPart::Thinking(thinking)
            if thinking.redacted == Some(false) && thinking.thinking_signature.is_some()
    )));
    assert!(assistant.content.iter().any(|part| matches!(
        part,
        AssistantContentPart::ToolCall(call) if call.namespace.is_some() && call.thought_signature.is_some()
    )));
}

#[test]
fn decodes_a_tool_result_with_nested_calls() {
    let AgentMessage::ToolResult(result) = &messages_in(SUPPLEMENT)[3] else {
        panic!("the supplement ends with a tool result");
    };

    assert_eq!(
        result.details.as_ref().and_then(|details| details["lines"].as_u64()),
        Some(3)
    );
    assert!(result.usage.is_some(), "the supplement records tool usage");

    let nested = result.nested_calls.as_ref().expect("the result records nested calls");
    assert!(!nested.complete, "an unfinished call makes the record incomplete");
    assert_eq!(nested.calls[1].status, NestedToolCallStatus::Unfinished);
    assert_eq!(nested.calls[1].arguments, None, "oversized arguments are omitted");
    assert_eq!(nested.calls[1].arguments_bytes, Some(42));
}

#[test]
fn decodes_the_recorded_streaming_deltas() {
    let deltas = deltas_in(TRANSCRIPT);

    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::ToolcallStart { tool_name, .. } if tool_name == "bash"
    )));
    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::ToolcallDelta { delta, .. } if !delta.is_empty()
    )));
    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::ToolcallEnd { tool_call, .. } if tool_call.name == "bash"
    )));
    assert!(
        deltas
            .iter()
            .any(|event| matches!(event, AssistantMessageEvent::TextStart { .. }))
    );
    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::TextDelta { delta, .. } if !delta.is_empty()
    )));
    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::TextEnd { content, .. } if content == "0.99.2"
    )));
}

/// `done` and `error` never appeared in any recording of this release: RPC mode
/// forwards `start`, `*_delta` and `*_end` only. They stay mirrored because the TS
/// union declares them.
#[test]
fn decodes_the_deltas_no_recording_reaches_yet() {
    let deltas = deltas_in(SUPPLEMENT);

    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::Done { reason: DoneReason::ToolUse, message }
            if message.stop_reason == StopReason::ToolUse
    )));
    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::Error { reason: ErrorReason::Aborted, error }
            if error.error_message.as_deref() == Some("aborted by client")
    )));
}

#[test]
fn decodes_the_recorded_tool_execution_events() {
    let events = events_in(TRANSCRIPT);

    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolExecutionStart { tool_name, parent_tool_call_id: None, args, .. }
            if tool_name == "bash" && args["command"].as_str().is_some_and(|command| command.contains("version"))
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::ToolExecutionUpdate { .. }))
    );
    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolExecutionEnd { tool_call_id, is_error: false, .. } if !tool_call_id.is_empty()
    )));
}

#[test]
fn decodes_a_nested_tool_execution() {
    let events = events_in(SUPPLEMENT);

    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolExecutionUpdate { parent_tool_call_id: Some(parent), .. } if parent == "call_1"
    )));
}

#[test]
fn decodes_the_recorded_agent_end() {
    let events = events_in(TRANSCRIPT);
    let settled = events
        .iter()
        .find_map(|event| match event {
            Event::AgentEnd { messages, will_retry } => Some((messages, will_retry)),
            _ => None,
        })
        .expect("the recording settles a run");

    assert_eq!(settled.0.len(), 5, "the settled run carries the whole transcript");
    assert!(!settled.1);
    assert!(
        events.iter().any(|event| matches!(event, Event::AgentSettled)),
        "pi reports that it became idle"
    );
}

#[test]
fn decodes_retry_events_and_an_aborted_compaction() {
    let events = events_in(SUPPLEMENT);

    // A compaction the summarizer aborted reports `aborted: true`. The recorded
    // failures report `aborted: false` with an error message instead.
    assert!(events.iter().any(|event| matches!(
        event,
        Event::CompactionEnd {
            reason: CompactionReason::Manual,
            result: None,
            aborted: true,
            error_message: Some(message),
            ..
        } if message == "summarizer failed"
    )));

    assert!(events.iter().any(|event| matches!(
        event,
        Event::AutoRetryStart {
            attempt: 1,
            max_attempts: 3,
            delay_ms: 500,
            ..
        }
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        Event::AutoRetryEnd { success: false, final_error: Some(error), .. } if error == "overloaded"
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::SummarizationRetryScheduled { attempt: 1, .. }))
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::SummarizationRetryFinished))
    );
}

#[test]
fn decodes_extension_errors() {
    let errors: Vec<_> = fixture(SUPPLEMENT)
        .into_iter()
        .filter_map(|line| match ServerMessage::parse(&line) {
            ServerMessage::ExtensionError(error) => Some(error),
            _ => None,
        })
        .collect();

    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].event, "tool_call");
    assert_eq!(errors[0].error, "boom");
    assert!(errors[0].extension_path.ends_with("thing.ts"));
}

/// The strongest invariant in this file: every payload a recorded response carries
/// must decode into the type its command documents. The envelope check above
/// cannot see this - a payload of the wrong *shape* is still a valid response.
/// This is what caught `bashExecution`, a message role the app adds by TS
/// declaration merging.
#[test]
fn every_recorded_payload_decodes() {
    for name in FIXTURES {
        for response in responses(name) {
            if !response.is_success() {
                continue;
            }
            let command = response.command.as_str();
            match command {
                "prompt" => drop(response.decode::<PromptData>().unwrap()),
                "steer" | "follow_up" => drop(response.decode::<QueuedInputData>().unwrap()),
                "clear_queue" => drop(response.decode::<ClearQueueData>().unwrap()),
                "new_session" => drop(response.decode::<NewSessionData>().unwrap()),
                "get_state" => drop(response.decode::<SessionState>().unwrap()),
                "set_model" => drop(response.decode::<Model>().unwrap()),
                "cycle_model" => drop(response.decode_opt::<CycleModelData>().unwrap()),
                "get_available_models" => drop(response.decode::<AvailableModelsData>().unwrap()),
                "cycle_thinking_level" => drop(response.decode_opt::<CycleThinkingLevelData>().unwrap()),
                "get_available_thinking_levels" => drop(response.decode::<AvailableThinkingLevelsData>().unwrap()),
                "compact" => drop(response.decode::<CompactionResult>().unwrap()),
                "bash" => drop(response.decode::<BashResult>().unwrap()),
                "get_session_stats" => drop(response.decode::<SessionStats>().unwrap()),
                "export_html" => drop(response.decode::<ExportHtmlData>().unwrap()),
                "switch_session" => drop(response.decode::<SwitchSessionData>().unwrap()),
                "fork" => drop(response.decode::<ForkData>().unwrap()),
                "clone" => drop(response.decode::<CloneData>().unwrap()),
                "get_fork_messages" => drop(response.decode::<ForkMessagesData>().unwrap()),
                "get_entries" => drop(response.decode::<EntriesData>().unwrap()),
                "get_tree" => drop(response.decode::<TreeData>().unwrap()),
                "get_last_assistant_text" => drop(response.decode::<LastAssistantTextData>().unwrap()),
                "get_messages" => drop(response.decode::<MessagesData>().unwrap()),
                "get_commands" => drop(response.decode::<CommandsData>().unwrap()),
                // Commands that answer with nothing at all.
                "abort"
                | "abort_bash"
                | "abort_retry"
                | "set_auto_compaction"
                | "set_auto_retry"
                | "set_follow_up_mode"
                | "set_session_name"
                | "set_steering_mode"
                | "set_thinking_level" => {
                    assert_eq!(response.data, None, "{name}: `{command}` answered with a payload");
                }
                other => panic!("{name}: no payload mapping for `{other}`"),
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
            AgentMessage::BashExecution(execution) => Some(execution),
            _ => None,
        })
        .expect("a recorded session keeps its `!` command in the transcript");

    assert_eq!(execution.command, "for i in 1 2 3; do echo tick $i; sleep 1; done");
    assert_eq!(execution.exit_code, Some(0));
    assert!(!execution.cancelled && !execution.truncated);
    assert!(execution.timestamp > 0);
}

#[test]
fn decodes_recorded_bash_results() {
    let results: Vec<BashResult> = responses(TOUR)
        .into_iter()
        .filter(|response| response.command == "bash")
        .map(|response| response.decode().unwrap())
        .collect();

    assert_eq!(results.len(), 2, "one finished command and one that was aborted");
    assert!(
        results
            .iter()
            .any(|result| result.exit_code == Some(0) && !result.cancelled),
        "the finished command reports its code: {results:?}"
    );
    let aborted = results.iter().find(|result| result.cancelled).expect("one was aborted");
    assert_eq!(aborted.exit_code, None, "a killed command reports no exit code");
    assert!(aborted.output.is_empty());
}

#[test]
fn decodes_recorded_queue_updates() {
    let steer: QueuedInputData = response(TOUR, "steer").decode().unwrap();
    let follow_up: QueuedInputData = response(TOUR, "follow_up").decode().unwrap();

    assert_eq!(steer.disposition, QueuedInputDisposition::Queued);
    assert_eq!(follow_up.disposition, QueuedInputDisposition::Queued);
    assert!(
        events_in(TOUR)
            .iter()
            .any(|event| matches!(event, Event::QueueUpdate { .. })),
        "pi reports the queue back while a run is streaming"
    );
}

#[test]
fn decodes_recorded_thinking() {
    // The message keeps the reasoning part next to the text it produced.
    let messages = messages_in(TOUR);
    let assistant = messages
        .iter()
        .find_map(|message| match message {
            AgentMessage::Assistant(assistant) => Some(assistant),
            _ => None,
        })
        .expect("the recording has an assistant turn");
    assert!(assistant.content.iter().any(|part| matches!(
        part,
        AssistantContentPart::Thinking(thinking) if !thinking.thinking.is_empty()
    )));

    let deltas = deltas_in(TOUR);
    assert!(
        deltas
            .iter()
            .any(|event| matches!(event, AssistantMessageEvent::ThinkingStart { .. }))
    );
    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::ThinkingDelta { delta, .. } if !delta.is_empty()
    )));
    assert!(deltas.iter().any(|event| matches!(
        event,
        AssistantMessageEvent::ThinkingEnd { content, .. } if !content.is_empty()
    )));
}

#[test]
fn decodes_a_recorded_compaction() {
    let entries: EntriesData = response(BRANCH, "get_entries").decode().unwrap();
    let entry = entries
        .entries
        .iter()
        .find_map(|entry| match entry {
            SessionEntry::Compaction(compaction) => Some(compaction),
            _ => None,
        })
        .expect("the recorded session compacted");
    assert!(!entry.summary.is_empty());
    assert!(entry.tokens_before > 0);

    let ended = events_in(BRANCH)
        .into_iter()
        .find_map(|event| match event {
            Event::CompactionEnd {
                reason,
                result: Some(result),
                aborted,
                ..
            } => Some((reason, result, aborted)),
            _ => None,
        })
        .expect("the recording compacted");
    assert_eq!(ended.0, CompactionReason::Manual);
    assert!(!ended.2);
    assert_eq!(
        ended.1.first_kept_entry_id, entry.first_kept_entry_id,
        "the event and the appended entry describe the same compaction"
    );
    assert!(ended.1.usage.is_some(), "the summary call's usage is reported");
}

#[test]
fn decodes_a_recorded_fork() {
    let forkable: ForkMessagesData = response(BRANCH, "get_fork_messages").decode().unwrap();
    assert!(
        !forkable.messages.is_empty(),
        "the recording has something to fork from"
    );

    let forked: ForkData = response(BRANCH, "fork").decode().unwrap();
    assert!(!forked.cancelled);
    assert_eq!(
        forked.text, forkable.messages[0].text,
        "the fork echoes the entry it started from"
    );
}

#[test]
fn decodes_a_recorded_session_switch() {
    let state: SessionState = response(SESSION, "get_state").decode().unwrap();
    assert!(state.session_file.is_some(), "a file-backed session reports its path");

    let switched: SwitchSessionData = response(SESSION, "switch_session").decode().unwrap();
    assert!(!switched.cancelled);
}

#[test]
fn decodes_a_recorded_rejection() {
    let rejected = response(FAILURES, "set_model");
    assert!(!rejected.is_success());
    assert!(
        rejected
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("Model not found"),
        "a model outside the catalog is refused"
    );

    // A compaction that could not run reports the reason on the event, not as an
    // abort, and produces no result.
    let failed = events_in(FAILURES)
        .into_iter()
        .find_map(|event| match event {
            Event::CompactionEnd {
                result,
                aborted,
                error_message,
                ..
            } => Some((result, aborted, error_message)),
            _ => None,
        })
        .expect("the recording attempted a compaction");
    assert!(failed.0.is_none() && !failed.1);
    assert!(
        failed
            .2
            .as_deref()
            .is_some_and(|message| message.contains("Nothing to compact")),
        "got {:?}",
        failed.2
    );
}
