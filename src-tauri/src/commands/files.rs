//! File dialog selection, path inspection, and local attachment classification.
//!
//! What a person selects with system dialogs, pastes from file managers, or attaches
//! to prompts, as far as the files of this device are concerned. Staging a file on a
//! host, local or reached over SSH, belongs to [`super::attachment`].
//!
//! Both picker and reader commands are `async`, and that is what makes them safe here:
//! the body of an async command runs on the async runtime, and the blocking `blocking_*`
//! calls of the dialog plugin must not run on the main thread, where a synchronous command
//! runs (its own documentation, tauri-plugin-dialog 2.8.1; `respond_async_serialized` of
//! tauri 2.12.1 spawns the body).

use base64::Engine as _;
use camino::Utf8Path;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt};
use tokio::io::AsyncReadExt as _;
use typed_path::Utf8TypedPath;

use crate::error::PieError;
use crate::host::{Files, LocalHost, StageSource};

use pi_rpc::types::{ImageContent, ImageKind};

/// What a person can select with a file dialog.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogFilter {
    /// Label for the filter in the dialog (e.g. "Private keys", "Images").
    pub name: String,
    /// List of file extensions without dots (e.g. `["pem", "key"]`).
    pub extensions: Vec<String>,
}

/// The target of the selection dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SelectTarget {
    #[default]
    File,
    Folder,
}

/// Options configuring the native file dialog.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectOptions {
    /// Dialog title.
    pub title: Option<String>,
    /// Whether multiple items can be chosen.
    #[serde(default)]
    pub multiple: bool,
    /// Target type: file or folder.
    #[serde(default)]
    pub target: SelectTarget,
    /// File extension filters.
    #[serde(default)]
    pub filters: Vec<DialogFilter>,
}

/// One image that a person selected or pasted, with the name of the file it came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    /// The name of the file, or `Image` when the dialog gave none.
    pub name: String,
    /// The picture, as the `images` of a prompt take it.
    pub image: ImageContent,
}

/// A non-image file attachment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFile {
    /// The name of the file.
    pub name: String,
    /// Size in bytes.
    pub size: u64,
    /// Detected MIME type.
    pub mime_type: String,
    /// Local filesystem path, if directly accessible.
    pub local_path: Option<String>,
}

/// Combined list of image and non-image attachments.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCandidates {
    /// Pictures ready for the `images` array of a Pi prompt.
    pub images: Vec<ImageAttachment>,
    /// Non-image files ready for staging/uploading to the target host.
    pub files: Vec<AttachmentFile>,
}

/// How much of a file pie reads to name its type. A picture carries its signature in the
/// first bytes, and no type that pie inlines needs more.
const HEAD_BYTES: usize = 8192;

/// The first bytes of a reader, up to [`HEAD_BYTES`].
///
pub(crate) async fn read_head<R>(reader: &mut R) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut head = Vec::with_capacity(HEAD_BYTES);
    reader.take(HEAD_BYTES as u64).read_to_end(&mut head).await?;
    Ok(head)
}

/// Determines the MIME type and extension of binary data.
///
/// The bytes come first, because a name is a label: an Android `content://` URI
/// carries none, and a renamed file carries the wrong one. Only when the bytes
/// say nothing does the extension decide.
pub fn detect_mime(bytes: &[u8], ext_hint: &str) -> (String, String) {
    if let Some(kind) = infer::get(bytes) {
        return (kind.mime_type().to_string(), kind.extension().to_string());
    }
    let extension = ext_hint.trim_start_matches('.').to_ascii_lowercase();
    let mime = mime_guess::from_ext(&extension).first_or_octet_stream();
    let kept = if extension.is_empty() {
        "bin".to_string()
    } else {
        extension
    };
    (mime.to_string(), kept)
}

/// Checks whether a MIME type is a supported image format for Pi prompts.
pub fn is_supported_image_mime(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

/// One picture, in the shape that a prompt takes it.
fn image_of(name: String, mime_type: String, bytes: &[u8]) -> ImageAttachment {
    ImageAttachment {
        name,
        image: ImageContent {
            kind: ImageKind::Image,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            mime_type,
        },
    }
}

/// Converts a [`FilePath`] into a displayable or storage string.
fn file_path_to_string(fp: &FilePath) -> String {
    match fp {
        FilePath::Url(u) => u.to_string(),
        FilePath::Path(p) => Utf8Path::from_path(p)
            .map(|path| path.as_str().to_string())
            .unwrap_or_else(|| p.to_string_lossy().to_string()),
    }
}

/// Parses a URI or path string into a [`FilePath`].
///
/// Where a URL ends and a path begins is the filesystem plugin's own rule
/// (the [`FromStr`](std::str::FromStr) impl of [`FilePath`]): a scheme of one
/// letter is a Windows drive, not a scheme, and the plugin keeps the two
/// spellings in step with its own reads.
/// What pie adds is the refusal. A relative path belongs to no machine, a `file`
/// URL becomes the path it names, and the only URL that stays a URL is an
/// Android `content` handover.
pub fn parse_uri_or_path(raw: &str) -> Option<FilePath> {
    let clean = raw.trim();
    if clean.is_empty() {
        return None;
    }
    match clean.parse::<FilePath>().ok()? {
        FilePath::Path(path) if path.is_absolute() || Utf8TypedPath::derive(clean).is_absolute() => {
            Some(FilePath::Path(path))
        }
        FilePath::Url(url) if url.scheme() == "content" => Some(FilePath::Url(url)),
        // The plugin keeps a `file` URL a URL. Both callers below work on paths, and a path
        // is what lets an attachment keep the file where it lies instead of copying it.
        FilePath::Url(url) if url.scheme() == "file" => url.to_file_path().ok().map(FilePath::Path),
        _ => None,
    }
}

/// Internal helper to inspect a list of file paths or URIs.
pub async fn inspect_paths_internal(app: &AppHandle, paths: Vec<String>) -> Result<AttachmentCandidates, PieError> {
    let mut images = Vec::new();
    let mut files = Vec::new();

    for raw in paths {
        let Some(file_path) = parse_uri_or_path(&raw) else {
            return Err(PieError::BadArgument {
                reason: format!("invalid file path or URI: {raw}"),
            });
        };

        if let Some(path) = file_path.as_path() {
            let metadata = tokio::fs::metadata(path).await?;
            let size = metadata.len();
            let utf8_path = Utf8Path::from_path(path).ok_or_else(|| PieError::BadArgument {
                reason: format!("path is not valid utf-8: {}", path.display()),
            })?;

            let name = utf8_path.file_name().unwrap_or("Attachment").to_string();
            let ext = utf8_path.extension().unwrap_or_default();

            // The type comes from the first bytes. A pipe or a FUSE mount answers with fewer
            // bytes than it was asked for, so the head is gathered until it is whole.
            let mut file = tokio::fs::File::open(path).await?;
            let head = read_head(&mut file).await?;
            let (mime, _) = detect_mime(&head, ext);

            if is_supported_image_mime(&mime) {
                // The head is the start of this file: the rest is read on, not read again.
                let mut bytes = head;
                file.read_to_end(&mut bytes).await?;
                images.push(image_of(name, mime, &bytes));
            } else {
                files.push(AttachmentFile {
                    name,
                    size,
                    mime_type: mime,
                    local_path: Some(utf8_path.as_str().to_string()),
                });
            }
        } else {
            let bytes = app.fs().read(file_path.clone())?;
            let name = match &file_path {
                FilePath::Url(u) => u
                    .path_segments()
                    .and_then(|mut s| s.next_back())
                    .unwrap_or("Attachment")
                    .to_string(),
                _ => "Attachment".to_string(),
            };
            let ext_hint = Utf8Path::new(&name).extension().unwrap_or_default();
            let (mime, ext) = detect_mime(&bytes, ext_hint);

            if is_supported_image_mime(&mime) {
                images.push(image_of(name, mime, &bytes));
            } else {
                let size = bytes.len() as u64;
                let local_host = LocalHost::new(None);
                let path = local_host
                    .stage_file(&name, &ext, StageSource::Bytes(&bytes), Box::new(|_, _| {}))
                    .await?;
                files.push(AttachmentFile {
                    name,
                    size,
                    mime_type: mime,
                    local_path: Some(path),
                });
            }
        }
    }

    Ok(AttachmentCandidates { images, files })
}

/// Opens a native system dialog to select files or folders.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn select_paths(app: AppHandle, options: Option<SelectOptions>) -> Result<Option<Vec<String>>, PieError> {
    let opts = options.unwrap_or_default();
    let mut builder = app.dialog().file();

    if let Some(ref title) = opts.title {
        builder = builder.set_title(title);
    }

    for filter in &opts.filters {
        let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &exts);
    }

    match opts.target {
        SelectTarget::File => {
            if opts.multiple {
                let chosen = builder.blocking_pick_files();
                Ok(chosen.map(|list| list.iter().map(file_path_to_string).collect()))
            } else {
                let chosen = builder.blocking_pick_file();
                Ok(chosen.map(|fp| vec![file_path_to_string(&fp)]))
            }
        }
        SelectTarget::Folder => {
            #[cfg(desktop)]
            {
                if opts.multiple {
                    let chosen = builder.blocking_pick_folders();
                    Ok(chosen.map(|list| list.iter().map(file_path_to_string).collect()))
                } else {
                    let chosen = builder.blocking_pick_folder();
                    Ok(chosen.map(|fp| vec![file_path_to_string(&fp)]))
                }
            }
            #[cfg(mobile)]
            {
                Err(PieError::NotSupported {
                    what: "folder selection on mobile".to_string(),
                })
            }
        }
    }
}

/// Reads the entire contents of a file or content URI as a string.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn read_text(app: AppHandle, path: String) -> Result<String, PieError> {
    let Some(file_path) = parse_uri_or_path(&path) else {
        return Err(PieError::BadArgument {
            reason: format!("path must be absolute or a content URI: {path}"),
        });
    };
    if let Some(fs_path) = file_path.as_path() {
        Ok(tokio::fs::read_to_string(fs_path).await?)
    } else {
        app.fs().read_to_string(file_path).map_err(PieError::from)
    }
}

/// Inspects given file paths or URIs and classifies them as images or file attachments.
#[tauri::command]
#[tracing::instrument(level = "debug", skip_all, err)]
pub async fn inspect_paths(app: AppHandle, paths: Vec<String>) -> Result<AttachmentCandidates, PieError> {
    inspect_paths_internal(&app, paths).await
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn detects_image_types_by_magic_bytes() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00];
        let (mime, ext) = detect_mime(&png, "png");
        assert_eq!(mime, "image/png");
        assert_eq!(ext, "png");
        assert!(is_supported_image_mime(&mime));
    }

    #[tokio::test]
    async fn the_head_of_a_file_arrives_whole_from_an_reader_that_answers_in_pieces() {
        use tokio::io::AsyncWriteExt as _;

        // A duplex with a tiny buffer answers each read with a few bytes, the way a pipe or a
        // network share does. One read would leave a signature in pieces and name the wrong
        // type, which turns a picture into a file attachment.
        let png: Vec<u8> = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00].to_vec();
        let (mut writer, mut reader) = tokio::io::duplex(3);
        let written = png.clone();
        let feeding = tokio::spawn(async move {
            writer.write_all(&written).await.expect("the write");
        });

        let head = read_head(&mut reader).await.expect("the head");
        feeding.await.expect("the feed");

        assert_eq!(head, png, "a head in pieces is still the whole head");
        assert_eq!(detect_mime(&head, "").0, "image/png");
    }

    #[tokio::test]
    async fn the_head_of_a_file_stops_at_the_bound() {
        use tokio::io::AsyncWriteExt as _;

        let long = vec![b'a'; HEAD_BYTES * 2];
        let (mut writer, mut reader) = tokio::io::duplex(64);
        let feeding = tokio::spawn(async move {
            let _ = writer.write_all(&long).await;
        });

        let head = read_head(&mut reader).await.expect("the head");
        feeding.abort();

        assert_eq!(head.len(), HEAD_BYTES, "a long file is not read past its head");
    }

    #[test]
    fn detects_non_image_types_by_magic_bytes_and_extension() {
        let pdf = b"%PDF-1.4 header text";
        let (mime, _) = detect_mime(pdf, "pdf");
        assert_eq!(mime, "application/pdf");
        assert!(!is_supported_image_mime(&mime));

        let (mime_json, _) = detect_mime(b"{\"key\": 1}", "json");
        assert_eq!(mime_json, "application/json");
        assert!(!is_supported_image_mime(&mime_json));
    }

    #[test]
    fn parses_file_urls_and_absolute_paths() {
        // A `file` URL becomes the path it names: both callers work on paths, and a path is
        // what lets an attachment keep the file where it lies instead of copying it.
        assert!(matches!(
            parse_uri_or_path("file:///tmp/test.txt"),
            Some(FilePath::Path(_))
        ));
        let url_path = parse_uri_or_path("file:///tmp/test.txt");
        assert_eq!(
            url_path.and_then(|fp| fp.into_path().ok()),
            Some(PathBuf::from("/tmp/test.txt"))
        );

        let abs_path = parse_uri_or_path("/var/log/syslog");
        assert_eq!(
            abs_path.and_then(|fp| fp.into_path().ok()),
            Some(PathBuf::from("/var/log/syslog"))
        );

        let win_path = parse_uri_or_path(r"C:\Users\me\a.pdf");
        assert!(win_path.is_some());

        let rel_path = parse_uri_or_path("relative/path.txt");
        assert!(rel_path.is_none());
    }

    #[test]
    fn an_android_handover_stays_a_url() {
        // Only the plugin opens a `content://` URI, so it may not be turned into a path.
        assert!(matches!(
            parse_uri_or_path("content://com.android.providers.media/a.png"),
            Some(FilePath::Url(_))
        ));
        assert!(parse_uri_or_path("https://example.com/a.png").is_none());
    }
}
