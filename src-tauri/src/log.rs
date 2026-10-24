//! Logging: one global subscriber for the whole app.
//!
//! Desktop writes to stderr, Android writes to logcat, because a device shows
//! neither the Rust side's stdout nor its stderr.
//!
//! # Targets
//!
//! A line is filed under the module that wrote it, except for the three names
//! this app keeps for itself:
//!
//! - `pie_lib::...` - this crate: the machine, its sessions, the commands
//!   files. Every command of the IPC surface is a span here, so a line is
//!   written for each call: which command ran, what it carried, how it ended,
//!   and how long it took.
//! - `pie_ui` - the webview ([`crate::commands::log`]): one name for everything
//!   the frontend writes, so all of it can be turned up at once.
//! - `pi_rpc` - the protocol layer: framing, requests, dialogs, and the events
//!   it fans out.
//! - `channel` - the byte path of a started program: what the `pi` process
//!   itself writes to stderr (`channel::stderr`), and the SSH steps of the
//!   reach (`host::...`).
//!
//! # What `RUST_LOG` says
//!
//! Without a spec, `info` everywhere and `debug` for `pie_lib`: the app's own
//! steps are what a report about this app needs, while a dependency's debug
//! chatter is not. A spec replaces the whole default rather than adding to it:
//!
//! - unset: `info`, and `debug` for `pie_lib` - the app's own commands and steps
//! - `info`: nothing at `debug`, whatever wrote it
//! - `info,pi_rpc=debug,channel=debug`: the protocol, and what `pi` says on
//!   its stderr
//! - `info,pie_ui=debug`: the frontend's own lines
//! - `debug`: everything, third-party crates included
//!
//! So `RUST_LOG=info,pi_rpc=debug` keeps the app at `info` while raising one
//! target, which is the reason a directive replaces the default level.

#[cfg(not(target_os = "android"))]
use std::io::IsTerminal;

use tracing_subscriber::{EnvFilter, fmt::format::FmtSpan, layer::SubscriberExt, util::SubscriberInitExt};

/// The spec the app runs under when `RUST_LOG` says nothing.
///
/// The crate is `pie_lib` on this side of the boundary (its `[lib] name`, which
/// is what a target of this crate starts with), so `pie_lib=debug` is the app's
/// own code and nothing else. It is a constant rather than two calls so that
/// what the app prints by default is one thing a reader can find and change.
pub const DEFAULT_DIRECTIVES: &str = "info,pie_lib=debug";

/// The filter used when `RUST_LOG` says nothing.
fn default_filter() -> EnvFilter {
    filter_from(DEFAULT_DIRECTIVES)
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
        paranoid_android::layer(env!("CARGO_PKG_NAME"))
            .with_ansi(false)
            .with_span_events(FmtSpan::CLOSE),
    );

    #[cfg(not(target_os = "android"))]
    let subscriber = subscriber.with(
        tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(std::io::stderr().is_terminal())
            // A span is one command being served. Its close line is the only
            // line that says how the command ended and how long it took, since
            // a span on its own writes nothing when it opens or closes. The
            // level of that line is the span's, so `debug` spans stay quiet
            // under an `info` filter.
            .with_span_events(FmtSpan::CLOSE),
    );

    // `try_init` also bridges the `log` crate, so records from wry and tao
    // arrive here instead of being dropped.
    let _ = subscriber.try_init();
}

/// What a test reads back when it asserts that a line was written.
///
/// The app's subscriber writes to a terminal, which a test cannot read, so a
/// test that asserts on a line builds the same stack around a sink of its own.
/// Compiled only for tests: nothing of this reaches the binary.
#[cfg(test)]
pub(crate) mod test_sink {
    use std::{
        io::Write,
        sync::{Arc, Mutex},
    };

    use tracing_subscriber::{fmt::format::FmtSpan, layer::SubscriberExt};

    /// A place for lines to land, readable after the fact.
    #[derive(Clone, Default)]
    pub(crate) struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Sink {
        /// What has been written so far, as text.
        pub(crate) fn text(&self) -> String {
            let bytes = self.0.lock().expect("the sink's lock is not held across a panic");
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("the sink's lock is not held across a panic")
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Runs `body` under a subscriber built from `spec`, and answers what it
    /// wrote and what `body` returned. The layer is the desktop one - no colour, one line per span as it
    /// closes - so a test asserts what a reader of the terminal would see,
    /// never a line the app itself would not print.
    pub(crate) fn capture<R>(spec: &str, body: impl FnOnce() -> R) -> (String, R) {
        let sink = Sink::default();
        let writer = {
            let sink = sink.clone();
            move || sink.clone()
        };

        let subscriber = tracing_subscriber::registry().with(super::filter_from(spec)).with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_span_events(FmtSpan::CLOSE),
        );

        let returned = tracing::subscriber::with_default(subscriber, body);

        (sink.text(), returned)
    }
}

#[cfg(test)]
mod tests {
    use tracing::Level;

    use super::*;

    /// A filter is only observable through a dispatcher, so each case installs
    /// the same stack the app installs, scoped to the test.
    fn filtered(spec: &str, check: impl FnOnce()) {
        let subscriber = tracing_subscriber::registry().with(filter_from(spec));
        tracing::subscriber::with_default(subscriber, check);
    }

    /// The same, for the stack the app installs when `RUST_LOG` is unset.
    fn filtered_by_default(check: impl FnOnce()) {
        let subscriber = tracing_subscriber::registry().with(default_filter());
        tracing::subscriber::with_default(subscriber, check);
    }

    #[test]
    fn the_default_filter_keeps_info_and_the_apps_own_debug() {
        filtered_by_default(|| {
            assert!(tracing::enabled!(Level::INFO));
            // The app's own steps are what a report about the app needs.
            assert!(tracing::enabled!(target: "pie_lib::commands::session", Level::DEBUG));
            // A dependency's are not, and neither is the protocol's chatter.
            assert!(!tracing::enabled!(target: "wry::webview", Level::DEBUG));
            assert!(!tracing::enabled!(target: "pi_rpc::client", Level::DEBUG));
            assert!(!tracing::enabled!(target: "channel::stderr", Level::DEBUG));
        });
    }

    #[test]
    fn rust_log_replaces_the_default_level_rather_than_adding_to_it() {
        filtered("pi_rpc=debug", || {
            assert!(tracing::enabled!(target: "pi_rpc::client", Level::DEBUG));
            assert!(!tracing::enabled!(target: "commands::session", Level::INFO));
        });

        filtered("info,pi_rpc=debug,channel=debug", || {
            assert!(tracing::enabled!(target: "pi_rpc::client", Level::DEBUG));
            assert!(tracing::enabled!(target: "channel::stderr", Level::DEBUG));
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
    fn a_span_writes_a_line_when_it_closes() {
        // What a command of the IPC surface looks like: the span carries the
        // fields of the call, and closing it is the line that reports the
        // outcome and the time it took.
        let (written, _) = test_sink::capture(DEFAULT_DIRECTIVES, || {
            let span = tracing::debug_span!("get_entries", session = "main:1");
            span.in_scope(|| {});
        });

        assert!(written.contains("DEBUG"), "{written}");
        assert!(written.contains("get_entries"), "{written}");
        assert!(written.contains("session=\"main:1\""), "{written}");
        assert!(written.contains("time.busy"), "{written}");
    }

    #[test]
    fn a_span_of_a_level_that_is_off_writes_nothing() {
        let (written, _) = test_sink::capture("info", || {
            let span = tracing::debug_span!("get_entries", session = "main:1");
            span.in_scope(|| {});
        });

        assert!(written.is_empty(), "{written}");
    }

    #[test]
    fn a_command_writes_one_line_per_call() {
        // What the IPC surface looks like in a terminal: the command's own name
        // as the span, and one line when it answers. `platform` is the command
        // that needs nothing to run, so it is the one a test can call.
        let (written, answered) = test_sink::capture(DEFAULT_DIRECTIVES, crate::commands::app::platform);

        assert!(answered.is_ok(), "the platform of this machine is known");
        assert!(written.contains("platform"), "{written}");
        assert!(written.contains("close"), "{written}");
        assert!(written.contains("time.busy"), "{written}");
    }

    #[test]
    fn init_is_idempotent() {
        init();
        init();
        tracing::info!("the second init left this subscriber in place");
    }
}
