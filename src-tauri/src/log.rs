//! Logging for the whole app.
//!
//! Desktop writes to stderr. Android writes to logcat, because a device shows
//! neither stdout nor stderr.
//!
//! `RUST_LOG` replaces the default filter. Without it the app keeps `info` and
//! raises its own crate to `debug`, which is where a report about pie starts.

#[cfg(not(target_os = "android"))]
use std::io::IsTerminal;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// The filter used when `RUST_LOG` says nothing.
const DEFAULT_FILTER: &str = "info,pie_lib=debug";

/// Install the subscriber. A second call, or a taken global slot, changes nothing.
pub fn init() {
    let filter = filter();
    let registry = tracing_subscriber::registry().with(filter);

    #[cfg(target_os = "android")]
    let subscriber = registry.with(
        paranoid_android::layer(env!("CARGO_PKG_NAME"))
            .with_ansi(false)
            .with_span_events(FmtSpan::CLOSE),
    );

    #[cfg(not(target_os = "android"))]
    let subscriber = registry.with(
        tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(std::io::stderr().is_terminal())
            .with_span_events(FmtSpan::CLOSE),
    );

    let _ = subscriber.try_init();
}

/// The filter to install.
fn filter() -> EnvFilter {
    match std::env::var(EnvFilter::DEFAULT_ENV) {
        Ok(spec) => parse(&spec),
        Err(_) => parse(DEFAULT_FILTER),
    }
}

/// Parse a `RUST_LOG` spec. A bad directive is dropped, not fatal.
fn parse(spec: &str) -> EnvFilter {
    EnvFilter::builder()
        .with_default_directive(tracing::level_filters::LevelFilter::INFO.into())
        .parse_lossy(spec)
}
