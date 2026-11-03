//! The frontend's own log lines, into the one log of the app.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tracing::Level;

use crate::error::PieError;

/// Most bytes one message or one field of the frontend's log keeps.
const LOG_LIMIT: usize = 8 * 1024;

/// How important one line is.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

/// One line of the frontend's log.
#[derive(Debug, Clone, Deserialize)]
pub struct LogLine {
    pub level: LogLevel,
    pub message: String,
    #[serde(default)]
    pub fields: Map<String, Value>,
}

/// Write one line of the frontend's log.
#[tauri::command(rename = "log")]
pub fn log_log(line: LogLine) -> Result<(), PieError> {
    let message = cut(&line.message);
    let fields: Map<String, Value> = line
        .fields
        .into_iter()
        .map(|(key, value)| (key, cut_value(value)))
        .collect();
    let fields = serde_json::to_string(&Value::Object(fields)).unwrap_or_else(|_| "{}".to_owned());

    // `tracing` names fields at the call site, so the map of the frontend travels
    // beside the message as one field of its own.
    //
    // A callsite also fixes its level, so one arm writes the line at each level.
    macro_rules! line_at {
        ($level:path) => {
            tracing::event!(target: "pie_ui", $level, message = %message, fields = %fields)
        };
    }

    match line.level {
        LogLevel::Error => line_at!(Level::ERROR),
        LogLevel::Warn => line_at!(Level::WARN),
        LogLevel::Info => line_at!(Level::INFO),
        LogLevel::Debug => line_at!(Level::DEBUG),
        LogLevel::Trace => line_at!(Level::TRACE),
    }

    Ok(())
}

/// `text`, cut at [`LOG_LIMIT`] bytes with the cut marked.
fn cut(text: &str) -> String {
    if text.len() <= LOG_LIMIT {
        return text.to_owned();
    }

    let mut end = LOG_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }

    format!("{}...", &text[..end])
}

/// `value`, with its text cut at [`LOG_LIMIT`] bytes; a number or a flag is short
/// already.
fn cut_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(cut(&text)),
        other => other,
    }
}

/// Which levels the filter keeps. The frontend sends only these.
#[derive(Debug, Clone, Serialize)]
pub struct LogLevels {
    pub error: bool,
    pub warn: bool,
    pub info: bool,
    pub debug: bool,
    pub trace: bool,
}

/// Which levels the frontend should send.
#[tauri::command(rename = "log_levels")]
pub fn log_log_levels() -> Result<LogLevels, PieError> {
    Ok(LogLevels {
        error: tracing::enabled!(target: "pie_ui", Level::ERROR),
        warn: tracing::enabled!(target: "pie_ui", Level::WARN),
        info: tracing::enabled!(target: "pie_ui", Level::INFO),
        debug: tracing::enabled!(target: "pie_ui", Level::DEBUG),
        trace: tracing::enabled!(target: "pie_ui", Level::TRACE),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_long_line_is_cut_and_the_cut_is_marked() {
        let long = "x".repeat(LOG_LIMIT + 10);
        let cut_at = cut(&long);

        assert!(cut_at.len() <= LOG_LIMIT + 3, "{}", cut_at.len());
        assert!(cut_at.ends_with("..."));
    }

    #[test]
    fn a_short_line_keeps_every_byte() {
        assert_eq!(cut("hello"), "hello");
    }

    #[test]
    fn a_cut_leaves_a_character_whole() {
        // Three bytes per character, so the limit falls inside one.
        let long = "\u{4e2d}".repeat(LOG_LIMIT);
        let cut_at = cut(&long);
        let body = cut_at.strip_suffix("...").expect("the cut is marked");

        assert!(long.starts_with(body));
        assert!(body.len() < LOG_LIMIT, "{}", body.len());
    }

    #[test]
    fn a_cut_field_keeps_its_kind() {
        assert_eq!(cut_value(Value::from(7)), Value::from(7));
        assert_eq!(cut_value(Value::from("short")), Value::from("short"));
    }

    #[test]
    fn the_level_report_names_every_level() {
        let levels = LogLevels {
            error: true,
            warn: false,
            info: true,
            debug: false,
            trace: true,
        };

        assert_eq!(
            serde_json::to_value(&levels).expect("levels serialize"),
            json!({ "error": true, "warn": false, "info": true, "debug": false, "trace": true })
        );
    }
}
