//! Everything pi can send on stdout, with graceful degradation.
//!
//! Pi writes four kinds of record: responses, session events, extension UI
//! requests, and extension errors. [`ServerMessage::parse`] sorts one line into
//! them. A record whose `type` this crate does not know - or whose shape changed
//! under a known `type` - becomes [`ServerMessage::Unknown`] with the original
//! JSON kept intact, so a protocol addition on pi's side never breaks a running
//! client. A line that is not JSON at all becomes
//! [`ServerMessage::Unparseable`] and is likewise not fatal.

use serde::de::DeserializeOwned;
use serde_json::Value;

use super::event::Event;
use super::extension::{ExtensionError, ExtensionUiRequest};
use super::response::Response;

/// One record read from pi's stdout.
///
/// Kept unboxed on purpose: records are parsed once, moved into the fan-out
/// channel, and matched by every consumer, so paying for an allocation and a
/// pointer chase on each of pi's streaming deltas would cost more than the
/// hundred-odd bytes of enum padding it saves.
#[expect(
    clippy::large_enum_variant,
    reason = "records are matched and moved as values, not boxed"
)]
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ServerMessage {
    /// A response to a command.
    Response(Response),
    /// A session event.
    Event(Event),
    /// A dialog or status update from an extension.
    ExtensionUiRequest(ExtensionUiRequest),
    /// An extension handler failure.
    ExtensionError(ExtensionError),
    /// A record this crate does not mirror; the raw JSON is preserved.
    Unknown {
        /// The record as pi wrote it.
        raw: Value,
    },
    /// A line that could not be parsed as JSON.
    Unparseable {
        /// The line as received.
        line: String,
        /// Why it could not be parsed.
        error: String,
    },
}

impl ServerMessage {
    /// Sorts one JSONL record into a message.
    pub fn parse(line: &str) -> Self {
        let raw: Value = match serde_json::from_str(line) {
            Ok(raw) => raw,
            Err(error) => {
                return Self::Unparseable {
                    line: line.to_string(),
                    error: error.to_string(),
                };
            }
        };

        match raw.get("type").and_then(Value::as_str) {
            Some("response") => decode_or_unknown(raw, Self::Response),
            Some("extension_ui_request") => decode_or_unknown(raw, Self::ExtensionUiRequest),
            Some("extension_error") => decode_or_unknown(raw, Self::ExtensionError),
            // Every remaining record with a `type` is a session event.
            Some(_) => decode_or_unknown(raw, Self::Event),
            None => Self::Unknown { raw },
        }
    }

    /// Value of the `type` field, when the record has one.
    pub fn message_type(&self) -> Option<&str> {
        match self {
            Self::Response(_) => Some("response"),
            Self::Event(_) => Some("event"),
            Self::ExtensionUiRequest(_) => Some("extension_ui_request"),
            Self::ExtensionError(_) => Some("extension_error"),
            Self::Unknown { raw } => raw.get("type").and_then(Value::as_str),
            Self::Unparseable { .. } => None,
        }
    }

    /// The event, when this is one.
    pub fn as_event(&self) -> Option<&Event> {
        match self {
            Self::Event(event) => Some(event),
            _ => None,
        }
    }

    /// The response, when this is one.
    pub fn as_response(&self) -> Option<&Response> {
        match self {
            Self::Response(response) => Some(response),
            _ => None,
        }
    }

    /// The extension UI request, when this is one.
    pub fn as_extension_ui_request(&self) -> Option<&ExtensionUiRequest> {
        match self {
            Self::ExtensionUiRequest(request) => Some(request),
            _ => None,
        }
    }

    /// Consumes the message, returning the event if it is one.
    pub fn into_event(self) -> Option<Event> {
        match self {
            Self::Event(event) => Some(event),
            _ => None,
        }
    }

    /// Consumes the message, returning the response if it is one.
    pub fn into_response(self) -> Option<Response> {
        match self {
            Self::Response(response) => Some(response),
            _ => None,
        }
    }
}

/// Decodes a known record kind, keeping the raw JSON when its shape changed.
fn decode_or_unknown<T: DeserializeOwned>(raw: Value, wrap: impl FnOnce(T) -> ServerMessage) -> ServerMessage {
    match serde_json::from_value::<T>(raw.clone()) {
        Ok(message) => wrap(message),
        Err(error) => {
            tracing::debug!(%error, "protocol record did not match the mirrored type; keeping it raw");
            ServerMessage::Unknown { raw }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_each_record_kind() {
        assert!(matches!(
            ServerMessage::parse(r#"{"id":"1","type":"response","command":"get_state","success":true}"#),
            ServerMessage::Response(_)
        ));
        assert!(matches!(
            ServerMessage::parse(r#"{"type":"agent_settled"}"#),
            ServerMessage::Event(Event::AgentSettled)
        ));
        assert!(matches!(
            ServerMessage::parse(r#"{"type":"extension_error","extensionPath":"p","event":"e","error":"x"}"#),
            ServerMessage::ExtensionError(_)
        ));
        assert!(matches!(
            ServerMessage::parse(r#"{"type":"extension_ui_request","id":"1","method":"setTitle","title":"t"}"#),
            ServerMessage::ExtensionUiRequest(_)
        ));
    }

    #[test]
    fn keeps_unknown_and_changed_records_raw() {
        let unknown = ServerMessage::parse(r#"{"type":"brand_new_event","payload":1}"#);
        assert_eq!(
            unknown,
            ServerMessage::Unknown {
                raw: serde_json::json!({"type": "brand_new_event", "payload": 1})
            }
        );

        // `agent_settled` with a shape we do not mirror must not be fatal either.
        let drifted = ServerMessage::parse(r#"{"type":"queue_update","steering":"not an array"}"#);
        assert!(matches!(drifted, ServerMessage::Unknown { .. }));
    }

    #[test]
    fn marks_non_json_lines_unparseable() {
        match ServerMessage::parse("hello") {
            ServerMessage::Unparseable { line, .. } => assert_eq!(line, "hello"),
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn parses_a_failed_response_with_an_open_command() {
        let wire =
            r#"{"id":"11","type":"response","command":"bogus","success":false,"error":"Unknown command: bogus"}"#;
        let ServerMessage::Response(response) = ServerMessage::parse(wire) else {
            panic!("expected a response");
        };
        assert_eq!(response.command, "bogus");
        assert!(!response.is_success());
    }
}
