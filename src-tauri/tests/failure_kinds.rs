//! The named failures that the frontend has words for, together with the names
//! that Rust gives them.
//!
//! `PieError` sends each failure as the name of the variant that failed, tagged
//! `kind`. Each screen holds the text for a person in its own `FAILURE_REASON`
//! table, because a screen can only meet some of the failures. Together the
//! tables hold one set of names. A renamed variant in Rust would leave its row
//! with no target. Two modules with the same name for a failure would make one of
//! them read the words of the other. A test that operates on the code does not
//! show either problem. Therefore this test compares the names, from the sources,
//! as `purity.rs` and `manifest.rs` check their rules.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// The screens that hold text for a failure, in the order they are read.
///
/// The workspace keeps its table in a module of its own, because two components
/// of that screen read it: the transcript and the session drawer beside it.
const FRONTEND: [&str; 2] = [
    "../src/routes/connect/ConnectScreen.tsx",
    "../src/routes/chat/failure-reason.ts",
];

/// Every error enum whose variant names reach the frontend as a `kind`.
const ENUMS: [&str; 3] = [
    "src/pi_rpc/error.rs",
    "src/connection/error.rs",
    "src/commands/error.rs",
];

fn read(path: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("reading {}: {error}", path.display()))
}

/// The name of a variant as serde writes it under `rename_all = "snake_case"`:
/// a lower-case word, with an underscore before each later capital.
///
/// No name here puts two capitals together or uses a digit. Therefore this is
/// simpler than the rule of serde.
fn kind_of(variant: &str) -> String {
    let mut kind = String::with_capacity(variant.len() + 4);
    for (index, character) in variant.char_indices() {
        if character.is_uppercase() && index > 0 {
            kind.push('_');
        }
        kind.extend(character.to_lowercase());
    }
    kind
}

/// The `kind` of every variant of the one `pub enum Error` in `path`.
fn variants(path: &str) -> BTreeSet<String> {
    let text = read(path);
    let mut kinds = BTreeSet::new();
    let mut inside = false;
    for line in text.lines() {
        let indent = line.len() - line.trim_start().len();
        let line = line.trim_start();
        if !inside {
            inside = line == "pub enum Error {";
            continue;
        }
        // A blank line has no indentation. It separates variants. It is not the
        // end of the enum.
        if line.is_empty() {
            continue;
        }
        // The enum ends at the brace back at column zero.
        if indent == 0 {
            break;
        }
        // A variant is one level in. Its attributes and its doc comment are one
        // level in too. Its fields are two levels in.
        if indent != 4 || line.starts_with("//") || line.starts_with("#[") {
            continue;
        }
        let name: String = line
            .chars()
            .take_while(|character| character.is_alphanumeric() || *character == '_')
            .collect();
        if !name.is_empty() {
            kinds.insert(kind_of(&name));
        }
    }
    assert!(!kinds.is_empty(), "no variants read from {path}");
    kinds
}

/// The keys of the `FAILURE_REASON` tables of the screens.
fn frontend_kinds() -> BTreeSet<String> {
    let mut kinds = BTreeSet::new();
    for path in FRONTEND {
        kinds.extend(table_kinds(path));
    }
    kinds
}

/// The keys of the `FAILURE_REASON` table in one frontend source.
fn table_kinds(path: &str) -> BTreeSet<String> {
    let text = read(path);
    let mut kinds = BTreeSet::new();
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim_start();
        if !inside {
            inside = line.starts_with("const FAILURE_REASON") || line.starts_with("export const FAILURE_REASON");
            continue;
        }
        if line.trim_end() == "};" {
            break;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some((key, _)) = line.split_once(':') {
            kinds.insert(key.trim().to_string());
        }
    }
    assert!(!kinds.is_empty(), "no sentences read from {path}");
    kinds
}

#[test]
fn the_frontend_has_words_for_exactly_the_names_rust_gives() {
    let named: BTreeSet<String> = ENUMS.iter().flat_map(|path| variants(path)).collect();
    assert_eq!(
        named,
        frontend_kinds(),
        "a variant was renamed, or a sentence was left for a failure that is gone"
    );
}

#[test]
fn no_two_modules_name_a_failure_alike() {
    // The frontend lookup is one flat table with `kind` as the key. A name that
    // two modules use would send a person the text of the other module.
    let enums: Vec<(&str, BTreeSet<String>)> = ENUMS.iter().map(|path| (*path, variants(path))).collect();
    for (index, (left, left_kinds)) in enums.iter().enumerate() {
        for (right, right_kinds) in &enums[index + 1..] {
            let shared: Vec<&String> = left_kinds.intersection(right_kinds).collect();
            assert!(shared.is_empty(), "{left} and {right} both name {shared:?}");
        }
    }
}
