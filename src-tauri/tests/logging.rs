//! Eyeball check for the logging setup, whose output cannot be asserted from
//! inside the process that owns it.
//!
//! `cargo test --test logging -- --ignored --nocapture` should print the info
//! and warn records on stderr, and the debug one only when `RUST_LOG` asks for
//! it - the same filter the app runs with.

use pie_lib::logging;

#[test]
#[ignore = "prints to stderr for a human to look at"]
fn init_prints_where_the_app_prints() {
    logging::init();

    tracing::info!(default_filter = "info", "logcheck: info record");
    tracing::debug!("logcheck: debug record, hidden unless RUST_LOG=debug");
    tracing::warn!(target: "pi_rpc::stderr", line = %"pi said something", "pi wrote to stderr");
}
