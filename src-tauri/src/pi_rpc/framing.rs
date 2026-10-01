//! JSONL framing, byte-for-byte compatible with Pi's `jsonl.ts`.
//!
//! Pi writes one compact JSON object per record, terminated by a single LF, and
//! reads stdin the same way. Only `\n` separates records: Unicode separators such
//! as U+2028 or U+2029 are payload when they appear inside a JSON string, so a
//! reader must never treat them as boundaries. One trailing CR is stripped, which
//! makes CRLF streams readable. A final record without a trailing newline is
//! still emitted when the stream ends.

use serde::Serialize;

use crate::pi_rpc::error::{Error, Result};

/// Serializes one record and appends the LF that terminates it.
///
/// # Errors
///
/// [`Error::Encode`] when the value cannot be serialized, which for the wire
/// types of this module is a bug in this crate rather than a runtime failure.
pub fn encode_line<T: Serialize>(value: &T) -> Result<String> {
    let mut line = serde_json::to_string(value).map_err(Error::Encode)?;
    line.push('\n');
    Ok(line)
}

/// Incremental LF splitter over a byte stream.
///
/// Feed it whatever the transport read; it buffers partial records and hands
/// back complete ones. Invalid UTF-8 is replaced, matching the UTF-8
/// `StringDecoder` pi uses on its own side.
#[derive(Debug, Default)]
pub struct LineDecoder {
    buffer: Vec<u8>,
}

impl LineDecoder {
    /// Creates an empty decoder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends received bytes. Incomplete records stay buffered.
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Removes and returns the next complete record, if one is buffered.
    pub fn next_line(&mut self) -> Option<String> {
        let newline = self.buffer.iter().position(|byte| *byte == b'\n')?;
        let mut line: Vec<u8> = self.buffer.drain(..=newline).collect();
        line.pop();
        Some(decode(&mut line))
    }

    /// Removes and returns a trailing record that was not LF-terminated.
    ///
    /// Call this when the stream ended; pi flushes a final partial record the
    /// same way.
    pub fn finish(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let mut line = std::mem::take(&mut self.buffer);
        Some(decode(&mut line))
    }
}

/// Strips one trailing CR and decodes a record body.
fn decode(line: &mut Vec<u8>) -> String {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8_lossy(line).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_lf_and_strips_one_cr() {
        let mut decoder = LineDecoder::new();
        decoder.push(b"{\"a\":1}\n{\"b\":2}\r\n");
        assert_eq!(decoder.next_line().as_deref(), Some("{\"a\":1}"));
        assert_eq!(decoder.next_line().as_deref(), Some("{\"b\":2}"));
        assert_eq!(decoder.next_line(), None);
    }

    #[test]
    fn keeps_unicode_separators_inside_a_record() {
        let mut decoder = LineDecoder::new();
        decoder.push("{\"text\":\"a\u{2028}b\u{2029}c\"}\n".as_bytes());
        assert_eq!(
            decoder.next_line().as_deref(),
            Some("{\"text\":\"a\u{2028}b\u{2029}c\"}")
        );
    }

    #[test]
    fn buffers_partial_records_across_chunks() {
        let mut decoder = LineDecoder::new();
        decoder.push(b"{\"id\":\"1\",\"ty");
        assert_eq!(decoder.next_line(), None);
        decoder.push(b"pe\":\"get_state\"}\n");
        assert_eq!(
            decoder.next_line().as_deref(),
            Some("{\"id\":\"1\",\"type\":\"get_state\"}")
        );
    }

    #[test]
    fn decodes_a_multibyte_character_split_across_chunks() {
        let text = "{\"name\":\"\u{4f60}\u{597d}\"}\n";
        let (head, tail) = text.as_bytes().split_at(12);
        let mut decoder = LineDecoder::new();
        decoder.push(head);
        assert_eq!(decoder.next_line(), None);
        decoder.push(tail);
        assert_eq!(decoder.next_line().as_deref(), Some("{\"name\":\"\u{4f60}\u{597d}\"}"));
    }

    #[test]
    fn finish_emits_an_unterminated_trailing_record_once() {
        let mut decoder = LineDecoder::new();
        decoder.push(b"{\"a\":1}");
        assert_eq!(decoder.finish().as_deref(), Some("{\"a\":1}"));
        assert_eq!(decoder.finish(), None);
    }

    #[test]
    fn encode_line_terminates_with_exactly_one_lf() {
        assert_eq!(encode_line(&serde_json::json!({"a": 1})).unwrap(), "{\"a\":1}\n");
    }
}
