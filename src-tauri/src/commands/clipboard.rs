//! Native OS clipboard operations.
//!
//! WebKitGTK on Linux (WebKit Bug #218519) and sandboxed webviews fail to translate
//! native clipboard screenshots into DOM DataTransfer objects. We route clipboard
//! access directly through Rust for cross-platform reliability.

use base64::Engine as _;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::commands;
use crate::commands::files::{self, PickedAttachments, PickedImage};
use crate::error::PieError;

use pi_rpc::types::{ImageContent, ImageKind};

/// Encodes raw RGBA bytes into a PNG buffer.
fn encode_rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, PieError> {
    let mut buf = Vec::new();
    let mut encoder = png::Encoder::new(&mut buf, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| PieError::from(commands::Error::Clipboard { reason: e.to_string() }))?;
    writer
        .write_image_data(rgba)
        .map_err(|e| PieError::from(commands::Error::Clipboard { reason: e.to_string() }))?;
    drop(writer);
    Ok(buf)
}

/// Reads image data or file references directly from the native OS clipboard.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn read_clipboard(app: AppHandle) -> Result<Option<PickedAttachments>, PieError> {
    if let Ok(image) = app.clipboard().read_image() {
        let png_bytes = encode_rgba_to_png(image.rgba(), image.width(), image.height())?;
        let data = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        return Ok(Some(PickedAttachments {
            images: vec![PickedImage {
                name: "Pasted image".to_string(),
                image: ImageContent {
                    kind: ImageKind::Image,
                    data,
                    mime_type: "image/png".to_string(),
                },
            }],
            files: Vec::new(),
        }));
    }

    if let Ok(text) = app.clipboard().read_text() {
        let paths = paths_in(&text);
        if !paths.is_empty() {
            let result = files::import_paths_internal(&app, paths).await?;
            if !result.images.is_empty() || !result.files.is_empty() {
                return Ok(Some(result));
            }
        }
    }

    Ok(None)
}

/// The lines of a clipboard text that name a file, in the order they were copied.
///
/// A clipboard holds a path and words at the same time: a file manager copies the
/// name of what it selected, and people paste it under a sentence. A line that
/// names no file is not a failure of the lines that do, so it goes before the
/// import sees it.
pub fn paths_in(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| files::parse_uri_or_path(line).is_some())
        .map(String::from)
        .collect()
}

/// Reads plain text from the native OS clipboard.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn read_clipboard_text(app: AppHandle) -> Result<Option<String>, PieError> {
    // The command is async so Tauri runs it off the main UI thread via respond_async_serialized.
    match app.clipboard().read_text() {
        Ok(text) => Ok(Some(text)),
        Err(_) => Ok(None),
    }
}

/// Writes plain text to the native OS clipboard.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(app, text), err)]
pub async fn write_clipboard_text(app: AppHandle, text: String) -> Result<(), PieError> {
    // The command is async so Tauri runs it off the main UI thread via respond_async_serialized.
    app.clipboard()
        .write_text(text)
        .map_err(|e| PieError::from(commands::Error::Clipboard { reason: e.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clipboard_of_paths_and_words_gives_the_paths() {
        let pasted = "/tmp/a.png\nsee this\n/home/me/report.pdf\n";

        assert_eq!(paths_in(pasted), ["/tmp/a.png", "/home/me/report.pdf"]);
    }

    #[test]
    fn a_clipboard_of_words_only_gives_nothing() {
        assert!(paths_in("see this file\nand this one").is_empty());
        assert!(paths_in("").is_empty());
    }

    #[test]
    fn a_clipboard_keeps_a_file_url_and_a_content_handover() {
        assert_eq!(
            paths_in("file:///tmp/a.png\ncontent://com.android.providers.media/a.png"),
            ["file:///tmp/a.png", "content://com.android.providers.media/a.png"]
        );
    }
}
