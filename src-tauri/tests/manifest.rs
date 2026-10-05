//! The manifest's own rules, checked mechanically.
//!
//! `Cargo.toml` lists every crate pie depends on, and a list nobody can scan is
//! a list nobody trusts. The dependency tables are sorted by crate name, so a
//! dependency is found by looking for it rather than by reading the whole table,
//! and two people adding the same crate land in the same place.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Crate names under every dependency table in `Cargo.toml`, keyed by the table's
/// own header.
///
/// The key is the whole header so that `[target.'cfg(...)'.dependencies]` is a
/// table of its own rather than a continuation of `[dependencies]`; that header
/// still counts as a dependency table, because it lists crates the same way.
/// One dependency per line is assumed: a value broken across lines would put
/// its continuation lines in as crates of their own.
fn dependency_tables() -> BTreeMap<String, Vec<String>> {
    let manifest = fs::read_to_string(manifest()).expect("reading Cargo.toml");

    let mut tables = BTreeMap::new();
    let mut inside: Option<String> = None;
    for line in manifest.lines() {
        let line = line.trim();
        // A header ends the previous table: bare `[name]`, or the dotted target
        // form, whose last segment is what the table is called.
        if line.starts_with('[') && line.ends_with(']') {
            let name = line.trim_start_matches('[').trim_end_matches(']');
            inside = (name.ends_with("dependencies")).then(|| name.to_string());
            continue;
        }
        // A comment is not a crate, and neither is anything outside the table
        // being read.
        let Some(table) = inside.as_ref() else {
            continue;
        };
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((crate_name, _)) = line.split_once('=') else {
            continue;
        };
        tables
            .entry(table.clone())
            .or_insert_with(Vec::new)
            .push(crate_name.trim().to_string());
    }
    tables
}

fn manifest() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")
}

#[test]
fn the_dependency_tables_are_sorted() {
    // `[build-dependencies]` and `[dev-dependencies]` are only in the manifest
    // if something needs them, so they are looked up rather than assumed.
    for required in ["build-dependencies", "dev-dependencies", "dependencies"] {
        assert!(dependency_tables().contains_key(required), "`[{required}]` is missing");
    }

    for (table, listed) in dependency_tables() {
        assert!(!listed.is_empty(), "`[{table}]` lists something");
        let mut sorted = listed.clone();
        sorted.sort();
        assert_eq!(listed, sorted, "`[{table}]` is not in alphabetical order");
    }
}
