//! The layers of `src-tauri/src`, checked by a machine.
//!
//! The compiler holds the boundary at the crate edge, but inside this crate one
//! module can reach any other: Rust has no visibility that says "the bytes must
//! not know which machine they run on". What a reader would otherwise keep in
//! their head, this test keeps instead. It reads the sources, as
//! `manifest.rs` reads the sources it checks.
//!
//! The rule is the dependency direction of the app:
//!
//! ```text
//! commands -> session -> host -> channel -> pi_rpc
//!     |
//!     +--> everything, and Tauri
//! ```
//!
//! - `channel` is bytes and a life. It does not know which machine it is on,
//!   which session owns it, or that Tauri exists.
//! - `host` reaches a machine and works on it. It does not know about sessions,
//!   and it does not know that Tauri exists.
//! - `session` runs pi sessions on that machine. It does not know that Tauri
//!   exists, which is what lets the whole reach be tested against a real machine
//!   with no window in the way.
//! - `commands` is the IPC surface. It is the only layer allowed to name Tauri.
//!
//! `error` is the boundary's failure type: every layer below it returns
//! `anyhow`, and the boundary turns that into the object the frontend reads.
//! `log` must be reachable from anywhere, because a line of it may be written
//! from anywhere.

use std::fs;
use std::path::{Path, PathBuf};

/// One layer, its directory, and what it may not name.
struct Layer {
    /// The directory, from the root of the crate.
    dir: &'static str,
    /// The modules from [`crate`]'s root that this layer may not reach.
    forbidden: &'static [&'static str],
}

const LAYERS: [Layer; 3] = [
    Layer {
        dir: "src/channel",
        // The bytes of a program know nothing about the machine they run on, the
        // session that owns them, or the app that shows them.
        forbidden: &["crate::host", "crate::session", "crate::commands", "tauri"],
    },
    Layer {
        dir: "src/host",
        // The reach to a machine knows nothing about the sessions that run on it.
        forbidden: &["crate::session", "crate::commands", "tauri"],
    },
    Layer {
        dir: "src/session",
        // A session is driven by the IPC layer; it does not know it.
        forbidden: &["crate::commands", "tauri"],
    },
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// Every `.rs` file under `dir`, in a stable order.
fn sources(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in fs::read_dir(&next).unwrap_or_else(|error| panic!("reading {}: {error}", next.display())) {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// The lines of `text` that name `forbidden`, with their line numbers.
///
/// A comment may name what the code may not: a doc comment that says "this lives
/// in `crate::host`" is how a reader learns the direction, and refusing it would
/// make the sources harder to read than the rule is worth. What is checked is
/// the code.
fn mentions(text: &str, forbidden: &str) -> Vec<usize> {
    text.lines()
        .enumerate()
        .filter(|(_, line)| {
            let line = line.trim_start();
            !line.starts_with("//") && line.contains(forbidden)
        })
        .map(|(index, _)| index + 1)
        .collect()
}

#[test]
fn a_layer_names_only_what_is_below_it() {
    for layer in LAYERS {
        for path in sources(&root().join(layer.dir)) {
            let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
            for forbidden in layer.forbidden {
                let lines = mentions(&text, forbidden);
                assert!(
                    lines.is_empty(),
                    "{}:{} names `{forbidden}`, which {} may not reach: {}",
                    path.display(),
                    lines.first().copied().unwrap_or_default(),
                    layer.dir,
                    path.display()
                );
            }
        }
    }
}

#[test]
fn the_layer_directories_are_where_this_test_says_they_are() {
    // A rename that this file did not follow would leave the rule unenforced in
    // silence, which is the one failure a rule of sources can have.
    for layer in LAYERS {
        let dir = root().join(layer.dir);
        assert!(dir.is_dir(), "{} is not a directory", dir.display());
        assert!(!sources(&dir).is_empty(), "{} holds no sources", dir.display());
    }
}
