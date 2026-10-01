//! Logging: one global subscriber for the whole app.
//!
//! Desktop writes to stderr, Android writes to logcat, because a device shows
//! neither the Rust side's stdout nor its stderr. Both read `RUST_LOG`, so a
//! level can be turned up without rebuilding:
//!
//! - unset: `info`
//! - `RUST_LOG=debug`: everything at `debug`
//! - `RUST_LOG=info,pi_rpc=debug`: `info`, but `pi_rpc` at `debug` - a target
//!   directive replaces the default level rather than adding to it

use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[cfg(not(target_os = "android"))]
use std::io::IsTerminal;

/// The filter used when `RUST_LOG` says nothing.
///
/// `info` keeps the session lifecycle visible without the protocol chatter that
/// `pi_rpc` emits at `debug`.
fn default_filter() -> EnvFilter {
    filter_from("")
}

/// Builds a filter from a `RUST_LOG` spec.
///
/// Invalid directives are dropped rather than fatal, and a spec in which every
/// directive was dropped falls back to the default level, so a typo eases
/// logging down instead of silencing it.
fn filter_from(spec: &str) -> EnvFilter {
    EnvFilter::builder()
        .with_default_directive(tracing::level_filters::LevelFilter::INFO.into())
        .parse_lossy(spec)
}

/// Installs the global subscriber.
///
/// A second call, or one after another crate claimed the global subscriber,
/// leaves the existing one in place instead of panicking - logging is never
/// worth taking the app down.
pub fn init() {
    let filter = match std::env::var(EnvFilter::DEFAULT_ENV) {
        Ok(spec) => filter_from(&spec),
        Err(_) => default_filter(),
    };

    let subscriber = tracing_subscriber::registry().with(filter);

    #[cfg(target_os = "android")]
    let subscriber = subscriber.with(
        // The logcat layer prints neither level nor time, because logcat
        // carries both itself; ANSI escapes would only show up as garbage.
        paranoid_android::layer(env!("CARGO_PKG_NAME")).with_ansi(false),
    );

    #[cfg(not(target_os = "android"))]
    let subscriber = subscriber.with(
        tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(std::io::stderr().is_terminal()),
    );

    // `try_init` also bridges the `log` crate, so records from wry and tao
    // arrive here instead of being dropped.
    let _ = subscriber.try_init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Level;

    /// A filter is only observable through a dispatcher, so each case installs
    /// the same stack the app installs, scoped to the test.
    fn filtered(spec: &str, check: impl FnOnce()) {
        let subscriber = tracing_subscriber::registry().with(filter_from(spec));
        tracing::subscriber::with_default(subscriber, check);
    }

    #[test]
    fn the_default_filter_keeps_info_and_drops_debug() {
        filtered("", || {
            assert!(tracing::enabled!(Level::INFO));
            assert!(!tracing::enabled!(Level::DEBUG));
        });
    }

    #[test]
    fn rust_log_replaces_the_default_level_rather_than_adding_to_it() {
        filtered("pi_rpc=debug", || {
            assert!(tracing::enabled!(target: "pi_rpc::client", Level::DEBUG));
            assert!(!tracing::enabled!(target: "commands::session", Level::INFO));
        });

        filtered("info,pi_rpc=debug", || {
            assert!(tracing::enabled!(target: "pi_rpc::client", Level::DEBUG));
            assert!(tracing::enabled!(target: "commands::session", Level::INFO));
            assert!(!tracing::enabled!(target: "commands::session", Level::DEBUG));
        });
    }

    #[test]
    fn a_spec_that_cannot_be_parsed_eases_down_instead_of_silencing_logging() {
        // `loud` is not a level, so this directive is dropped and the default
        // level - not an empty filter - is what remains.
        filtered("pi_rpc=loud", || {
            assert!(tracing::enabled!(target: "pi_rpc::client", Level::INFO));
        });
    }

    #[test]
    fn init_is_idempotent() {
        init();
        init();
        tracing::info!("the second init left this subscriber in place");
    }
}
