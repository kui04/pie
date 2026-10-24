//! The rules of the manifest, checked by a machine.
//!
//! `Cargo.toml` lists every crate that pie uses. A list that nobody can scan is
//! a list that nobody trusts. The dependency tables are sorted by crate name.
//! Therefore a person finds a dependency by a search, not by the read of the
//! full table. Also, two people who add the same crate put it in the same place.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

/// The crate names under every dependency table in `Cargo.toml`, with the header
/// of the table as the key.
///
/// The key is the full header. Therefore `[target.'cfg(...)'.dependencies]` is a
/// table of its own and not a continuation of `[dependencies]`. That header is
/// still a dependency table, because it lists crates in the same way. The parser
/// expects one dependency for each line. A value on more than one line would put
/// its continuation lines in as crates of their own.
fn dependency_tables() -> BTreeMap<String, Vec<String>> {
    let manifest = fs::read_to_string(manifest()).expect("reading Cargo.toml");

    let mut tables = BTreeMap::new();
    let mut inside: Option<String> = None;
    for line in manifest.lines() {
        let line = line.trim();
        // A header ends the table before it: a bare `[name]`, or the form with a
        // target, whose last segment is the name of the table.
        if line.starts_with('[') && line.ends_with(']') {
            let name = line.trim_start_matches('[').trim_end_matches(']');
            inside = (name.ends_with("dependencies")).then(|| name.to_string());
            continue;
        }
        // A comment is not a crate. Neither is a line outside the table that pie
        // reads.
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
    // `[build-dependencies]` and `[dev-dependencies]` are in the manifest only
    // if something needs them. Therefore the test looks them up and does not
    // assume them.
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
