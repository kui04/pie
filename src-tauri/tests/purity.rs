//! `pi_rpc` is a module of the app crate, not a crate of its own, so nothing but
//! a test keeps it from reaching into the app. These are the boundary rules from
//! `.agents/rules/architecture.md`, checked mechanically:
//!
//! * the protocol layer never depends on Tauri;
//! * it never reaches into app internals (`crate::` other than `crate::pi_rpc`,
//!   and never a `super::` chain that climbs past the module).

use std::fs;
use std::path::{Path, PathBuf};

/// Every Rust source of the protocol module, sorted.
fn module_sources() -> Vec<PathBuf> {
    fn walk(directory: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(directory).expect("reading the module directory") {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/pi_rpc");
    let mut found = Vec::new();
    walk(&root, &mut found);
    found.sort();
    assert!(found.len() > 10, "expected the protocol module's sources");
    found
}

#[test]
fn the_protocol_module_never_leans_on_the_app() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/pi_rpc");
    for path in module_sources() {
        let source = fs::read_to_string(&path).expect("reading a module source");
        // A `super::` chain may climb within the module but not out of it: the
        // file's own depth below src/pi_rpc bounds how many steps stay inside.
        let below = path.strip_prefix(&root).expect("a path inside the module");
        let is_mod = path.file_name().is_some_and(|name| name == "mod.rs");
        let allowed_climbs = below.components().count() - 1 + usize::from(!is_mod);

        for (index, line) in source.lines().enumerate() {
            let code = line.trim_start();
            // Docs and comments may name Tauri; code may not.
            if code.starts_with("//") {
                continue;
            }
            let location = format!("{}:{}", path.display(), index + 1);

            assert!(
                !code.contains("tauri"),
                "{location}: the protocol layer must not depend on Tauri: {code}"
            );
            assert!(
                !code.contains("crate::") || code.contains("crate::pi_rpc"),
                "{location}: the protocol layer must not reach into app internals: {code}"
            );
            assert!(
                code.matches("super::").count() <= allowed_climbs,
                "{location}: this `super::` chain leaves the module: {code}"
            );
        }
    }
}
