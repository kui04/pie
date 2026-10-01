//! Responses pi emitted on stdout.
//!
//! Mirrors `RpcResponse` from `packages/coding-agent/src/modes/rpc/rpc-types.ts`.
//! Pi's TS type is a union discriminated by `command` and `success`; because the
//! `command` field is an *open* string on the wire - an unknown command is
//! echoed back verbatim, see `tests/fixtures` - the envelope is mirrored as one
//! struct and the per-command `data` payloads as typed structs in
//! [`super::data`], decoded on demand with [`Response::decode`].

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::pi_rpc::error::{Error, Result};

/// A response to one command (`RpcResponse`).
///
/// `success: false` carries `error`; successful commands carry `data`, which may
/// be absent or `null` (pi sends `null` for `cycle_model` when there is nothing
/// to cycle).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    /// Id of the command this answers; absent for parse errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Command name as pi echoed it.
    pub command: String,
    /// Whether the command succeeded.
    pub success: bool,
    /// Command-specific payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Failure message when `success` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    /// Whether this response reports success.
    pub fn is_success(&self) -> bool {
        self.success
    }

    /// Turns a failed response into [`Error::Rpc`], passing a successful one through.
    ///
    /// # Errors
    ///
    /// [`Error::Rpc`] carrying pi's own message, or `no error message` when pi
    /// failed without one.
    pub fn into_result(self) -> Result<Self> {
        if self.success {
            return Ok(self);
        }
        Err(Error::Rpc {
            command: self.command,
            message: self.error.unwrap_or_else(|| "no error message".to_string()),
        })
    }

    /// Decodes the payload into the mirrored type of this command, one of the
    /// payload structs of this module.
    ///
    /// # Errors
    ///
    /// [`Error::Payload`] when the payload is missing a field or has a shape
    /// this mirror does not know - which means pi changed and the type needs to
    /// be re-read from the pinned checkout.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T> {
        let data = self.data.clone().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(data).map_err(|error| Error::Payload {
            command: self.command.clone(),
            message: error.to_string(),
        })
    }

    /// Decodes an optional payload: `None` when pi sent no `data` or `null`.
    pub fn decode_opt<T: DeserializeOwned>(&self) -> Result<Option<T>> {
        if matches!(self.data, None | Some(serde_json::Value::Null)) {
            return Ok(None);
        }
        self.decode().map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi_rpc::protocol::ModelThinkingLevel;
    use crate::pi_rpc::protocol::{AvailableThinkingLevelsData, LastAssistantTextData};

    /// A successful response to `command` with `data`.
    fn response(command: &str, data: Option<serde_json::Value>) -> Response {
        Response {
            id: Some("1".to_string()),
            command: command.to_string(),
            success: true,
            data,
            error: None,
        }
    }

    #[test]
    fn decode_reads_a_payload_into_its_mirrored_type() {
        let answered = response(
            "get_available_thinking_levels",
            Some(serde_json::json!({ "levels": ["off", "high"] })),
        );

        let levels: AvailableThinkingLevelsData = answered.decode().unwrap();

        assert_eq!(levels.levels, vec![ModelThinkingLevel::Off, ModelThinkingLevel::High]);
    }

    #[test]
    fn decode_fills_omitted_optional_fields_from_defaults() {
        // The recorded corpus answers `get_last_assistant_text` with `{}`.
        let answered = response("get_last_assistant_text", Some(serde_json::json!({})));

        let text: LastAssistantTextData = answered.decode().unwrap();

        assert_eq!(text.text, None);
    }

    #[test]
    fn decode_opt_answers_none_for_absent_or_null_data() {
        // Absent: pi omits `data` for commands that answer with nothing.
        let absent: Response =
            serde_json::from_str(r#"{"id":"1","type":"response","command":"abort","success":true}"#).unwrap();
        assert_eq!(absent.data, None);
        assert_eq!(absent.decode_opt::<LastAssistantTextData>().unwrap(), None);

        // `null`: pi's `cycle_model` sends it when there is nothing to cycle, and
        // serde folds it onto the same "no payload" state.
        let null: Response =
            serde_json::from_str(r#"{"id":"2","type":"response","command":"cycle_model","success":true,"data":null}"#)
                .unwrap();
        assert_eq!(null.data, None, "a null payload deserializes as absent");
        assert_eq!(null.decode_opt::<LastAssistantTextData>().unwrap(), None);

        // A hand-built `Some(null)` answers the same way.
        let built = response("cycle_model", Some(serde_json::Value::Null));
        assert_eq!(built.decode_opt::<LastAssistantTextData>().unwrap(), None);
    }

    #[test]
    fn decode_reports_a_shape_mismatch_as_a_payload_error() {
        let answered = response(
            "get_available_thinking_levels",
            Some(serde_json::json!({ "levels": "not an array" })),
        );

        let error = answered.decode::<AvailableThinkingLevelsData>().unwrap_err();

        match error {
            Error::Payload { command, message } => {
                assert_eq!(command, "get_available_thinking_levels");
                assert!(!message.is_empty(), "the decoder's reason is carried through");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn into_result_passes_success_through_and_reports_failure() {
        assert!(response("get_state", None).into_result().is_ok());

        let failed = Response {
            id: Some("2".to_string()),
            command: "abort".to_string(),
            success: false,
            data: None,
            error: Some("nothing to abort".to_string()),
        };
        match failed.into_result() {
            Err(Error::Rpc { command, message }) => {
                assert_eq!(command, "abort");
                assert_eq!(message, "nothing to abort");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }

        // A failure without a message still reports one.
        let silent = Response {
            id: None,
            command: "abort".to_string(),
            success: false,
            data: None,
            error: None,
        };
        match silent.into_result() {
            Err(Error::Rpc { message, .. }) => assert_eq!(message, "no error message"),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }
}
