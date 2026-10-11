//! What a person selects with a system dialog: a private key, and pictures for a
//! message.
//!
//! Both were JavaScript of the dialog and filesystem plugins, called from the
//! bridge, until the frontend stopped reaching plugins at all. They are commands
//! now, for two reasons: the frontend must not call a plugin itself, and a file
//! the person selected has to fail under a name that says so - a file that cannot
//! be read is [`PieError::Io`], not a mistake of pie, and only Rust knows which
//! one it was.
//!
//! Both commands are `async`, and that is what makes them safe here: the body of
//! an async command runs on the async runtime, and the blocking `blocking_*`
//! calls of the dialog plugin must not run on the main thread, where a
//! synchronous command runs (its own documentation, tauri-plugin-dialog 2.8.1;
//! `respond_async_serialized` of tauri 2.12.1 spawns the body).

use base64::Engine as _;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use crate::error::PieError;

use pi_rpc::types::{ImageContent, ImageKind};

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

/// Asks the person for a private key. Returns the text of the key.
///
/// The function returns the text, not the location. The two platforms answer the
/// picker differently: a path on desktop, a `content://` URI on Android. A plain
/// read can open only one of these.
///
/// `None` means that the person closed the picker. A closed picker is not a
/// failure. A file that cannot be read is [`PieError::Io`]. Therefore the toast
/// blames the selected file, not pie.
///
/// # Errors
///
/// The failure of the read of the selected file. The plugin reports no failure for
/// the picker itself: a picker that it cannot show answers as a closed picker.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn pick_private_key(app: AppHandle) -> Result<Option<String>, PieError> {
    let Some(chosen) = app.dialog().file().blocking_pick_file() else {
        return Ok(None);
    };
    // The filesystem of the plugin, not `tokio::fs`: on Android the picker answers
    // with a `content://` URI. Only the plugin can open that URI.
    app.fs().read_to_string(chosen).map(Some).map_err(PieError::file)
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
/// `application/octet-stream` - whether it is an image is a decision of pi, not of
/// pie.
///
/// # Errors
///
/// The failure of the read of a selected file. The picker itself reports no
/// failure: one that cannot be shown answers as a closed picker.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn pick_images(app: AppHandle) -> Result<Option<Vec<PickedImage>>, PieError> {
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
        // The filesystem of the plugin, not `tokio::fs`, for the reason above.
        let bytes = app.fs().read(file).map_err(PieError::file)?;
        picked.push(PickedImage {
            name: name.unwrap_or_else(|| "Image".to_string()),
            image: ImageContent {
                kind: ImageKind::Image,
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
/// The bytes come first: a name is a label, and a `content://` URI carries none.
/// The four types are the ones that pi inlines; anything else it may convert or
/// omit on its own.
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
/// These are the signatures of the four types that pi inlines. The list is pi's,
/// not a general catalogue: a picture of another type goes through as it is, and
/// pi says whether it can use it.
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
}
