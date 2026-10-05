//! The frontend reads the protocol records through the types that this crate
//! generates into `src/lib/protocol` (see `src-tauri/.cargo/config.toml`): one
//! `index.ts` that holds every type, which is what `@/lib/protocol` resolves to.
//!
//! These tests guard what generation depends on, because each item fails
//! silently: a `u64` that arrives as `bigint`; the three states of a
//! thinking-level mapping that collapse into two; a flag that is always `true`
//! in pi's own types and becomes a `boolean` here; and a type that misses the
//! shared `export_to` and lands in a file of its own, outside the one the
//! frontend imports. The freshness of the generated file itself is a repository
//! question, not a test question: `just types-check` regenerates it and reports
//! what the worktree changed.

use std::path::{Path, PathBuf};

/// The generated directory, which holds the `index.ts` the frontend imports as
/// `@/lib/protocol`.
fn generated() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/protocol")
}

/// Reads the generated types: every type of the protocol module lives in this
/// one file.
fn types() -> String {
    let path = generated().join("index.ts");
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("reading {}: {error}", path.display()))
}

/// The directory that ts-rs writes into is the directory this repository holds,
/// or the generated types are written somewhere the frontend does not read.
///
/// The value comes from `[env] TS_RS_EXPORT_DIR` in `src-tauri/.cargo/config.toml`
/// and is absolute by the time a test sees it.
#[test]
fn the_export_writes_into_the_directory_the_frontend_reads() {
    let configured = std::env::var("TS_RS_EXPORT_DIR")
        .expect("`[env] TS_RS_EXPORT_DIR` is missing from src-tauri/.cargo/config.toml");

    let configured = Path::new(&configured)
        .canonicalize()
        .expect("resolving TS_RS_EXPORT_DIR");
    let held = generated().canonicalize().expect("resolving the generated directory");

    assert_eq!(
        configured, held,
        "ts-rs writes somewhere else than the frontend reads; the generated types would go stale"
    );
}

/// Every type of the protocol module names the same output file. A type that
/// does not is written to a file of its own: the frontend cannot import it from
/// `@/lib/protocol`, and a reader of the directory sees a file that belongs to
/// no layout.
#[test]
fn every_type_lands_in_the_one_file_the_frontend_imports() {
    let mut found = Vec::new();
    let mut directories = vec![generated()];

    while let Some(directory) = directories.pop() {
        let entries =
            std::fs::read_dir(&directory).unwrap_or_else(|error| panic!("reading {}: {error}", directory.display()));
        for entry in entries {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                directories.push(path);
                continue;
            }
            let relative = path
                .strip_prefix(generated())
                .expect("a path below the generated directory");
            found.push(relative.display().to_string().replace('\\', "/"));
        }
    }
    found.sort();

    assert_eq!(
        found.iter().map(String::as_str).collect::<Vec<_>>(),
        ["index.ts", "serde_json/JsonValue.ts"],
        "a type without `#[ts(export, export_to = \"index.ts\")]` writes a file of its own"
    );
}

#[test]
fn every_number_of_the_wire_is_a_number_in_the_frontend() {
    let types = types();

    assert!(types.contains("messageCount: number"), "the session state is generated");
    assert!(
        !types.contains("bigint"),
        "the wire carries JSON numbers, and `JSON.parse` never gives a bigint"
    );
}

/// `ThinkingLevelMap` deserializes its seven keys with a function ts-rs cannot
/// read. The attribute is about deserialization only, and the wire keeps three
/// states apart: an absent key, `null`, and a string. The three assertions are
/// exact on purpose - `off?: string | null` is a prefix of the doubled
/// `off?: string | null | null` that ts-rs generates without `#[ts(type = ...)]`.
#[test]
fn a_key_that_is_absent_apart_from_null_stays_both() {
    let types = types();

    for key in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
        assert!(
            types.contains(&format!("{key}?: string | null,")),
            "`{key}` must be an optional key that may be `null`"
        );
    }
    assert!(
        !types.contains("| null | null"),
        "the `null` of a mapping entry must not be generated twice"
    );
}

/// Pi writes `cancelled: true` in its own types (`rpc-types.ts`): the answer to
/// a dismissed dialog carries nothing else. Rust builds this record, so the
/// frontend only reads it - but a `boolean` claims two values where the wire has
/// one.
#[test]
fn a_flag_that_is_always_true_stays_true() {
    let types = types();

    assert!(
        types.contains("cancelled: true,"),
        "the dismissal of a dialog is always true"
    );
}
