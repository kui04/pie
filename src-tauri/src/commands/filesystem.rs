//! Files of the machine pie runs on: dialogs, metadata, and content.

use anyhow::Context as _;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use camino::{Utf8Path, Utf8PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use tokio::io::AsyncReadExt as _;
use url::Url;

use crate::error::PieError;

/// Bytes read from the head of a file to name its type.
const SNIFF_BYTES: usize = 8 * 1024;

/// The text a picker answered and the frontend kept, before pie knows what it names.
///
/// A value says only "one text": a path and a URL arrive the same way. The text stays
/// text until a command parses it, because a refusal is a [`PieError`] and Tauri answers
/// an argument that does not fit with a bare string.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(transparent)]
pub struct PickedText(String);

/// Where one local file comes from.
///
/// A picker answers one text: a path on a desktop, an absolute URL on Android
/// (`content://`). The two are read in different ways, so a value exists only after
/// [`LocalFileSource::parse`] says which one it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalFileSource {
    /// A path of the machine pie runs on.
    Path(Utf8PathBuf),
    /// An absolute URL of a file, as a mobile picker answers one.
    Uri(String),
}

impl LocalFileSource {
    /// Parses the text of a pick into the source it names.
    pub fn parse(picked: PickedText) -> Result<Self, PieError> {
        let text = picked.0;

        // The rule `tauri_plugin_fs::FilePath` applies: text that parses as a URL whose
        // scheme is longer than one character is a URL, so `C:\x` stays a path.
        if let Ok(url) = Url::parse(&text)
            && url.scheme().len() != 1
        {
            return Ok(Self::Uri(text));
        }

        let path = Utf8PathBuf::from(&text);
        if !path.is_absolute() {
            return Err(PieError::BadArgument {
                reason: format!("`{text}` is no absolute path of this machine"),
            });
        }

        Ok(Self::Path(path))
    }

    /// The text that names this source, as the frontend holds it.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Path(path) => path.as_str(),
            Self::Uri(uri) => uri,
        }
    }
}

impl serde::Serialize for LocalFileSource {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Make a local directory, with parents as needed.
#[tauri::command(rename = "create_local_dir_all")]
pub async fn filesystem_create_dir_all(path: PickedText) -> Result<(), PieError> {
    let path = match LocalFileSource::parse(path)? {
        LocalFileSource::Path(path) => path,
        LocalFileSource::Uri(uri) => {
            return Err(PieError::BadArgument {
                reason: format!("`{uri}` names no directory pie creates"),
            });
        }
    };

    tokio::fs::create_dir_all(path.as_std_path())
        .await
        .with_context(|| format!("making the directory `{path}`"))?;

    Ok(())
}

/// The content of one local file.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum File {
    /// An image a prompt can carry.
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        base64: String,
    },
    /// Text, decoded as UTF-8.
    Text {
        #[serde(rename = "mimeType")]
        mime_type: String,
        content: String,
    },
}

/// Read one local file.
#[tauri::command(rename = "read")]
pub async fn filesystem_read(app: AppHandle, path: PickedText) -> Result<File, PieError> {
    let source = LocalFileSource::parse(path)?;
    let picked = match &source {
        LocalFileSource::Path(path) => FilePath::Path(path.as_std_path().to_owned()),
        LocalFileSource::Uri(uri) => {
            FilePath::Url(Url::parse(uri).map_err(|error| PieError::BadArgument {
                reason: format!("`{uri}` is no URL: {error}"),
            })?)
        }
    };

    let mut options = OpenOptions::new();
    options.read(true);
    let file = app
        .fs()
        .open(picked, options)
        .with_context(|| format!("opening `{}`", source.as_str()))?;

    let mut file = tokio::fs::File::from_std(file);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .await
        .with_context(|| format!("reading `{}`", source.as_str()))?;

    let head = &bytes[..bytes.len().min(SNIFF_BYTES)];
    let named = match &source {
        LocalFileSource::Path(path) => Some(path.as_path()),
        LocalFileSource::Uri(_) => None,
    };
    let mime_type = file_type(head, named);

    if mime_type.starts_with("image/") {
        return Ok(File::Image {
            mime_type,
            base64: STANDARD.encode(&bytes),
        });
    }

    Ok(match String::from_utf8(bytes) {
        Ok(content) => File::Text { mime_type, content },
        Err(error) => {
            tracing::warn!(
                path = %source.as_str(),
                mime_type = %mime_type,
                bytes = error.as_bytes().len(),
                "a picked file is neither an image nor text"
            );

            return Err(PieError::BadArgument {
                reason: format!("`{}` is neither an image nor text", source.as_str()),
            });
        }
    })
}

/// What pie reads about one local path.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub path: Utf8PathBuf,
    pub mime_type: String,
    pub size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub readonly: bool,
    pub created: Option<jiff::Timestamp>,
    pub modified: Option<jiff::Timestamp>,
}

/// Read the metadata of one local path.
#[tauri::command(rename = "read_metadata")]
pub async fn filesystem_read_metadata(path: PickedText) -> Result<FileMetadata, PieError> {
    let path = match LocalFileSource::parse(path)? {
        LocalFileSource::Path(path) => path,
        LocalFileSource::Uri(uri) => {
            return Err(PieError::NotSupported {
                what: format!("metadata of `{uri}`"),
            });
        }
    };

    let target = std::fs::metadata(path.as_std_path())
        .with_context(|| format!("reading the metadata of `{path}`"))?;
    let link = std::fs::symlink_metadata(path.as_std_path())
        .with_context(|| format!("reading the metadata of `{path}`"))?;
    let mime_type = file_type(&head_of(&path), Some(path.as_path()));

    Ok(FileMetadata {
        path,
        mime_type,
        size: target.len(),
        is_file: target.is_file(),
        is_dir: target.is_dir(),
        is_symlink: link.file_type().is_symlink(),
        readonly: target.permissions().readonly(),
        created: target
            .created()
            .ok()
            .and_then(|time| jiff::Timestamp::try_from(time).ok()),
        modified: target
            .modified()
            .ok()
            .and_then(|time| jiff::Timestamp::try_from(time).ok()),
    })
}

/// One extension filter of the file dialog.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// How the file dialog behaves.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOptions {
    pub title: Option<String>,
    #[serde(default)]
    pub multiple: bool,
    /// Pick a directory instead of a file. Mobile has no such picker.
    #[serde(default)]
    pub directory: bool,
    #[serde(default)]
    pub filters: Vec<DialogFilter>,
}

/// Open the native file dialog.
///
/// The answer is the text of each pick: a path of this machine, or a `content://`
/// URI on Android, which the next call hands back to [`filesystem_read`].
#[tauri::command(rename = "select_files")]
pub async fn filesystem_select_files(
    app: AppHandle,
    options: Option<SelectOptions>,
) -> Result<Option<Vec<LocalFileSource>>, PieError> {
    let options = options.unwrap_or_default();
    let mut dialog = app.dialog().file();

    if let Some(title) = options.title.as_deref() {
        dialog = dialog.set_title(title);
    }
    for filter in &options.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }

    if options.directory {
        #[cfg(desktop)]
        {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if options.multiple {
                dialog.pick_folders(move |picks| {
                    let _ = sender.send(picks);
                });
            } else {
                dialog.pick_folder(move |pick| {
                    let _ = sender.send(pick.map(|one| vec![one]));
                });
            }

            let picks = receiver.await.context("the file dialog answered nothing")?;
            return picks
                .map(|picks| picks.into_iter().map(local_source).collect())
                .transpose();
        }

        #[cfg(mobile)]
        {
            drop(dialog);
            return Err(PieError::NotSupported {
                what: "a directory picker".to_owned(),
            });
        }
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.pick_files(move |picks| {
        let _ = sender.send(picks);
    });

    let picks = receiver.await.context("the file dialog answered nothing")?;
    picks
        .map(|picks| picks.into_iter().map(local_source).collect())
        .transpose()
}

/// The source one pick names.
fn local_source(pick: FilePath) -> Result<LocalFileSource, PieError> {
    match pick {
        FilePath::Url(url) => Ok(LocalFileSource::Uri(url.to_string())),
        FilePath::Path(path) => match Utf8PathBuf::from_path_buf(path) {
            Ok(path) => Ok(LocalFileSource::Path(path)),
            Err(path) => Err(PieError::BadArgument {
                reason: format!("`{}` is not valid UTF-8", path.display()),
            }),
        },
    }
}

/// The first [`SNIFF_BYTES`] of one file, or nothing when it cannot be read.
fn head_of(path: &Utf8Path) -> Vec<u8> {
    use std::io::Read as _;

    let Ok(file) = std::fs::File::open(path.as_std_path()) else {
        return Vec::new();
    };

    let mut head = Vec::with_capacity(SNIFF_BYTES);
    let _ = file.take(SNIFF_BYTES as u64).read_to_end(&mut head);
    head
}

/// The type of one file of this machine: its first bytes, or the extension of a path when
/// the bytes say nothing and the source names one.
fn file_type(head: &[u8], path: Option<&Utf8Path>) -> String {
    if let Some(kind) = infer::get(head) {
        return kind.mime_type().to_owned();
    }

    path.and_then(|path| mime_guess::from_path(path).first())
        .map(|mime| mime.essence_str().to_owned())
        .unwrap_or_else(|| "application/octet-stream".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picked(text: &str) -> PickedText {
        PickedText(text.to_owned())
    }

    #[test]
    fn a_picked_text_is_a_url_or_an_absolute_path() {
        let uri = "content://com.android.providers.media/document/1";
        assert_eq!(
            LocalFileSource::parse(picked(uri)).expect("a url"),
            LocalFileSource::Uri(uri.to_owned())
        );

        let absolute = env!("CARGO_MANIFEST_DIR");
        assert_eq!(
            LocalFileSource::parse(picked(absolute)).expect("a path"),
            LocalFileSource::Path(Utf8PathBuf::from(absolute))
        );
    }

    #[test]
    fn a_relative_or_empty_pick_is_a_bad_argument() {
        for text in ["", "work/one.txt", "./one.txt"] {
            let error = LocalFileSource::parse(picked(text)).expect_err("no source");
            assert!(
                matches!(error, PieError::BadArgument { .. }),
                "`{text}`: {error}"
            );
        }
    }

    #[test]
    fn a_source_names_itself_as_the_text_pie_holds() {
        let uri = LocalFileSource::Uri("content://x/1".to_owned());
        let path = LocalFileSource::Path(Utf8PathBuf::from("/work/one.txt"));

        assert_eq!(uri.as_str(), "content://x/1");
        assert_eq!(path.as_str(), "/work/one.txt");
        assert_eq!(
            serde_json::to_value(&uri).expect("a source serializes"),
            serde_json::json!("content://x/1")
        );
    }

    #[test]
    fn a_type_comes_from_the_bytes_before_the_extension() {
        // A PNG signature, named `note.txt`: the bytes decide.
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert_eq!(
            file_type(png, Some(Utf8Path::new("/work/note.txt"))),
            "image/png"
        );
        assert_eq!(
            file_type(b"", Some(Utf8Path::new("/work/note.txt"))),
            "text/plain"
        );
        assert_eq!(file_type(b"", None), "application/octet-stream");
    }
}
