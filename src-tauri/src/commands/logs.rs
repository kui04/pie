//! What the webview writes into the same log as everything else.
//!
//! The frontend has no log of its own that anybody can read: the desktop webview
//! keeps its console behind a developer tool nobody opens, and on Android there
//! is no console at all. So the frontend sends its lines here, and they leave
//! through the one subscriber of [`crate::logging`] - stderr on the desktop,
//! logcat on Android - which means one file, one filter and one timestamp
//! format for the whole app.
//!
//! Every line carries the target [`UI_TARGET`]: one name for the whole webview,
//! so `RUST_LOG=info,pie_ui=debug` turns all of it up at once, while what varies
//! between lines - which command, which session, how long it took - travels as
//! their fields.
//!
//! Two things this module deliberately does not do. It does not fail a caller
//! over a log line: a line that is too long is cut rather than refused, because
//! the caller of `log` writes one line and moves on. And it is not instrumented
//! itself: a trace of the logging command would double every line the frontend
//! sends, which is a record about a record and helps nobody read either.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::PieError;

/// The target every line the webview writes carries.
pub const UI_TARGET: &str = "pie_ui";

/// How much of a message reaches the log, in bytes.
///
/// A message is a sentence somebody wrote for a reader. Past this size it is not
/// a sentence any more, and it competes for the same terminal as everything
/// else; a cut message says that it was cut, so a reader is never left with a
/// line that just stops.
const MESSAGE_LIMIT: usize = 8 * 1024;

/// How much of a field set reaches the log, in bytes.
///
/// The fields are a JSON object the frontend builds, so their size is not
/// bounded by anything on this side of the boundary, and a whole transcript in
/// a field would be a megabyte per line. Same reasoning as [`MESSAGE_LIMIT`].
const FIELDS_LIMIT: usize = 8 * 1024;

/// The level of one line the frontend writes.
///
/// Deserialization is where an unknown level fails: it arrives as an argument
/// that does not fit the command, before any subscriber sees a level it does not
/// have. `rename_all` is what makes the wire form the level's own name, as the
/// webview writes it.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    /// Something broke.
    Error,
    /// Something is worth knowing now, but did not break.
    Warn,
    /// A step of the app the reader would want in a report.
    Info,
    /// A step of the app that only matters when something is wrong.
    Debug,
    /// Everything, including what only a trace of one bug needs.
    Trace,
}

/// One line of the frontend's log.
///
/// `fields` is a JSON object and defaults to an empty one, so a line without
/// fields needs no shape of its own. It is logged as JSON text rather than as
/// one field per key: the names are the frontend's to choose, and a tracing
/// field has to be named where the line is written.
#[derive(Debug, Deserialize)]
pub struct LogLine {
    /// How important the line is.
    pub level: LogLevel,
    /// What happened, in one sentence.
    pub message: String,
    /// What it happened to.
    #[serde(default)]
    pub fields: Map<String, Value>,
}

/// Which levels are worth sending.
///
/// Every line the frontend writes costs a call into Rust, and a line the filter
/// would throw away is a call spent on nothing. So the frontend reads this once
/// and then keeps quiet about the levels that are off, which is what makes a
/// `debug` line in a hot path free when nobody asked for it.
#[derive(Debug, Serialize)]
pub struct LogLevels {
    /// Whether an error line is kept.
    pub error: bool,
    /// Whether a warning line is kept.
    pub warn: bool,
    /// Whether an informational line is kept.
    pub info: bool,
    /// Whether a debug line is kept.
    pub debug: bool,
    /// Whether a trace line is kept.
    pub trace: bool,
}

/// Writes one line of the frontend's log.
///
/// The line keeps the level the frontend gave it: the frontend knows whether it
/// reports a failure or traces a step, and a `debug` line that arrived as `info`
/// would either be hidden from a reader who asked for it, or shown to one who
/// did not.
///
/// # Errors
///
/// None. Logging a line is never worth failing the caller over, and a level that
/// is not a level is refused before this function runs.
#[tauri::command]
pub fn log(line: LogLine) -> Result<(), PieError> {
    write(line);
    Ok(())
}

/// Says which levels the frontend should send.
///
/// It answers for the same target the lines will carry, so what the frontend
/// skips is exactly what the filter would have dropped.
///
/// # Errors
///
/// None.
#[tauri::command]
pub fn log_levels() -> Result<LogLevels, PieError> {
    use tracing::Level;

    Ok(LogLevels {
        error: tracing::enabled!(target: UI_TARGET, Level::ERROR),
        warn: tracing::enabled!(target: UI_TARGET, Level::WARN),
        info: tracing::enabled!(target: UI_TARGET, Level::INFO),
        debug: tracing::enabled!(target: UI_TARGET, Level::DEBUG),
        trace: tracing::enabled!(target: UI_TARGET, Level::TRACE),
    })
}

/// The fields of a line as one JSON object.
///
/// A JSON object has no `Display` of its own, and a tracing field is a value
/// whose name is written where the line is written - which is exactly what the
/// frontend cannot provide, since it chooses its own field names. So the whole
/// object travels as the text of one field, and a reader sees the names the
/// frontend used.
fn fields_json(fields: &Map<String, Value>) -> String {
    Value::Object(fields.clone()).to_string()
}

/// Sends one line to the subscriber at its own level.
///
/// One arm per level rather than one event with a level passed as a value: a
/// callsite then carries a level a filter can decide before the fields are
/// built, so a subscriber that has the level off pays nothing for the line.
fn write(line: LogLine) {
    let LogLine { level, message, fields } = line;

    match level {
        LogLevel::Error => {
            tracing::error!(target: UI_TARGET, message = %cut(&message, MESSAGE_LIMIT), fields = %cut(&fields_json(&fields), FIELDS_LIMIT));
        }
        LogLevel::Warn => {
            tracing::warn!(target: UI_TARGET, message = %cut(&message, MESSAGE_LIMIT), fields = %cut(&fields_json(&fields), FIELDS_LIMIT));
        }
        LogLevel::Info => {
            tracing::info!(target: UI_TARGET, message = %cut(&message, MESSAGE_LIMIT), fields = %cut(&fields_json(&fields), FIELDS_LIMIT));
        }
        LogLevel::Debug => {
            tracing::debug!(target: UI_TARGET, message = %cut(&message, MESSAGE_LIMIT), fields = %cut(&fields_json(&fields), FIELDS_LIMIT));
        }
        LogLevel::Trace => {
            tracing::trace!(target: UI_TARGET, message = %cut(&message, MESSAGE_LIMIT), fields = %cut(&fields_json(&fields), FIELDS_LIMIT));
        }
    }
}

/// Cuts a text to a limit, whole characters only, and says that it was cut.
///
/// The cut lands on a character boundary: half a character is not text a
/// terminal can show, and the message of a log line is read by a person.
fn cut(text: &str, limit: usize) -> Cow<'_, str> {
    if text.len() <= limit {
        return Cow::Borrowed(text);
    }

    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }

    Cow::Owned(format!("{}… (cut at {limit} bytes)", &text[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::test_sink::capture;
    use serde_json::json;

    fn line(level: LogLevel, message: &str, fields: Map<String, Value>) -> String {
        capture("trace", || {
            log(LogLine {
                level,
                message: message.to_string(),
                fields,
            })
            .expect("the command has no failure")
        })
        .0
    }

    #[test]
    fn a_line_keeps_the_wire_shape_the_frontend_writes() {
        // Field for field, as `src/lib/bridge/log.ts` sends it: a name that drifts
        // on either side of the boundary has to fail here, not in a log that stays
        // silent about it.
        let line: LogLine = serde_json::from_value(json!({
            "level": "warn",
            "message": "a call did not reach a command",
            "fields": { "command": "log" },
        }))
        .expect("the frontend's shape is the one this takes");

        assert!(matches!(line.level, LogLevel::Warn));
        assert_eq!(line.message, "a call did not reach a command");
        assert_eq!(line.fields.get("command"), Some(&json!("log")));
    }

    #[test]
    fn a_line_without_fields_is_a_line() {
        let line: LogLine = serde_json::from_value(json!({ "level": "info", "message": "a conversation was picked" }))
            .expect("the fields of a line are optional");

        assert!(line.fields.is_empty());
    }

    #[test]
    fn a_level_that_is_not_a_level_is_refused_before_a_subscriber_sees_it() {
        let refused = serde_json::from_value::<LogLine>(json!({ "level": "loud", "message": "x" }));

        assert!(refused.is_err(), "an unknown level is an argument that does not fit");
    }

    #[test]
    fn a_line_arrives_with_its_level_its_target_and_its_fields() {
        let written = line(
            LogLevel::Warn,
            "the sheet refused a pick",
            Map::from_iter([("session".to_string(), json!("main:1"))]),
        );

        assert!(written.contains("WARN"), "{written}");
        assert!(written.contains(UI_TARGET), "{written}");
        assert!(written.contains("the sheet refused a pick"), "{written}");
        assert!(written.contains("main:1"), "{written}");
    }

    #[test]
    fn a_level_the_filter_has_off_is_not_written() {
        // The default filter keeps `pie_ui` at `info`: a debug line of the
        // frontend is dropped before it reaches the writer.
        let written = capture("", || {
            write(LogLine {
                level: LogLevel::Debug,
                message: "a record arrived".to_string(),
                fields: Map::new(),
            })
        })
        .0;

        assert!(written.is_empty(), "{written}");
    }

    #[test]
    fn a_message_past_the_limit_is_cut_and_says_so() {
        let written = line(LogLevel::Info, &"x".repeat(MESSAGE_LIMIT + 1), Map::new());

        assert!(written.contains("… (cut at 8192 bytes)"), "{written}");
    }

    #[test]
    fn a_cut_lands_between_characters() {
        // `é` is two bytes, so a limit of 5 lands inside one of them: half a
        // character is not text a terminal can show, and a person reads a log
        // line.
        assert_eq!(cut("éééé", 5), "éé… (cut at 5 bytes)");
    }

    #[test]
    fn a_field_set_past_the_limit_is_cut_too() {
        let fields = Map::from_iter([("transcript".to_string(), json!("x".repeat(FIELDS_LIMIT * 2)))]);

        let written = line(LogLevel::Info, "a read answered", fields);

        assert!(written.contains("(cut at 8192 bytes)"), "{written}");
    }

    #[test]
    fn a_short_line_is_untouched() {
        assert_eq!(cut("nothing to cut", MESSAGE_LIMIT), "nothing to cut");
    }

    #[test]
    fn the_levels_the_frontend_asks_for_are_the_ones_the_filter_keeps() {
        let asked = |filter: &str| {
            capture(filter, || {
                let levels = log_levels().expect("the command has no failure");
                // The answer this command gives and what the subscriber would
                // do with a line of that level are the same fact twice.
                assert_eq!(
                    levels.error,
                    tracing::enabled!(target: UI_TARGET, tracing::Level::ERROR)
                );
                assert_eq!(levels.warn, tracing::enabled!(target: UI_TARGET, tracing::Level::WARN));
                assert_eq!(levels.info, tracing::enabled!(target: UI_TARGET, tracing::Level::INFO));
                assert_eq!(
                    levels.debug,
                    tracing::enabled!(target: UI_TARGET, tracing::Level::DEBUG)
                );
                assert_eq!(
                    levels.trace,
                    tracing::enabled!(target: UI_TARGET, tracing::Level::TRACE)
                );
                levels
            })
            .1
        };

        let default = asked("");
        assert!(default.info, "the frontend's own lines are kept by default");
        assert!(!default.debug, "and what it would only trace is not");

        let everything = asked("trace");
        assert!(everything.trace, "one name for the whole webview turns all of it up");

        let nothing = asked("off");
        assert!(!nothing.error, "and off means every level is off, the loudest one too");
    }
}
