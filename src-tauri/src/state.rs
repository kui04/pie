use std::collections::HashMap;
use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use camino::{Utf8Path, Utf8PathBuf};
use tauri::{AppHandle, Manager};

use crate::bus::Bus;
use crate::host::HostConnection;

/// The name of one connection. The frontend generates it.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct HostId(String);

impl HostId {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for HostId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// One provider of models.dev.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for ProviderId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// How long a fetched mark stays good.
pub const PROVIDER_LOGO_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a failed fetch is remembered.
pub const PROVIDER_LOGO_RETRY: Duration = Duration::from_secs(30 * 60);

/// One provider's mark, the file it was written to, and when it was fetched.
#[derive(Debug, Clone)]
struct ProviderLogo {
    path: Utf8PathBuf,
    fetched_at: Instant,
}

/// The caches of one run.
#[derive(Debug, Default)]
pub struct CacheStorage {
    /// The directory where provider marks are written.
    dir: Utf8PathBuf,
    /// Each provider's mark, and when it was fetched.
    provider_logos: HashMap<ProviderId, ProviderLogo>,
    /// Providers whose last fetch failed, and when.
    failed: HashMap<ProviderId, Instant>,
}

impl CacheStorage {
    /// The caches of a run whose own files live under `dir`.
    pub fn new(dir: Utf8PathBuf) -> Self {
        Self {
            dir,
            ..Self::default()
        }
    }

    /// The directory where provider marks are written.
    pub fn dir(&self) -> &Utf8Path {
        &self.dir
    }

    /// The file the mark of `provider` is written to.
    pub fn path(&self, provider: &ProviderId) -> Utf8PathBuf {
        self.dir.join(format!("{provider}.svg"))
    }

    /// The mark of `provider`, when it is younger than `PROVIDER_LOGO_TTL`.
    ///
    /// A mark that has gone stale is forgotten here, so the caller fetches it again
    /// instead of answering an old file.
    pub fn logo(&mut self, provider: &ProviderId) -> Option<Utf8PathBuf> {
        match self.provider_logos.get(provider) {
            Some(logo) if logo.fetched_at.elapsed() < PROVIDER_LOGO_TTL => Some(logo.path.clone()),
            Some(_) => {
                self.provider_logos.remove(provider);
                None
            }
            None => None,
        }
    }

    /// Records the mark written at [`CacheStorage::path`], so the next read answers it.
    pub fn remember(&mut self, provider: ProviderId) {
        let path = self.path(&provider);
        self.failed.remove(&provider);
        self.provider_logos.insert(
            provider,
            ProviderLogo {
                path,
                fetched_at: Instant::now(),
            },
        );
    }

    /// Whether a fetch of `provider` failed within `PROVIDER_LOGO_RETRY`.
    ///
    /// A failure that has aged out is forgotten here, so the caller may ask again.
    pub fn failed(&mut self, provider: &ProviderId) -> bool {
        match self.failed.get(provider) {
            Some(at) if at.elapsed() < PROVIDER_LOGO_RETRY => true,
            Some(_) => {
                self.failed.remove(provider);
                false
            }
            None => false,
        }
    }

    /// Records that the last fetch of `provider` failed.
    pub fn record_failure(&mut self, provider: ProviderId) {
        self.provider_logos.remove(&provider);
        self.failed.insert(provider, Instant::now());
    }
}

/// The directories of pie's own machine that a connection starts from.
#[derive(Debug, Clone, Default)]
pub struct LocalDirs {
    /// The login home, where a new conversation starts when nothing else is named.
    pub home: Option<Utf8PathBuf>,
    /// The directory where staged uploads wait for pi to read them.
    pub cache: Option<Utf8PathBuf>,
    /// The file where pie remembers the keys of the hosts it reached.
    pub known_hosts: Utf8PathBuf,
}

impl LocalDirs {
    /// The directories this app runs with, from the paths the platform resolved.
    fn from_app(app: &AppHandle) -> Self {
        let utf8 = |path: Result<std::path::PathBuf, tauri::Error>| {
            path.ok()
                .and_then(|path| Utf8PathBuf::from_path_buf(path).ok())
        };

        let paths = app.path();
        let home = utf8(paths.home_dir());
        let cache = utf8(paths.app_cache_dir());
        let data = utf8(paths.app_data_dir());

        // A desktop machine shares the file OpenSSH already uses; a mobile one has
        // no such file, so pie keeps its own next to the rest of its data.
        let known_hosts = if cfg!(any(target_os = "android", target_os = "ios")) {
            data.as_ref()
                .map(|data| data.join("known_hosts"))
                .unwrap_or_default()
        } else {
            home.as_ref()
                .map(|home| home.join(".ssh").join("known_hosts"))
                .or_else(|| data.as_ref().map(|data| data.join("known_hosts")))
                .unwrap_or_default()
        };

        Self {
            home,
            cache,
            known_hosts,
        }
    }
}

/// What every command shares.
pub struct AppState {
    /// The connected machines by name. Take the `Arc<HostConnection>` and drop the guard before any
    /// `.await`: a `std` guard across an await makes the command future `!Send`.
    pub hosts: Mutex<HashMap<HostId, Arc<HostConnection>>>,
    bus: Bus,
    /// The caches. Drop the guard before any `.await` that answers the frontend.
    pub cache: Mutex<CacheStorage>,
    dirs: OnceLock<LocalDirs>,
    app: AppHandle,
}

impl AppState {
    pub fn new(bus: Bus, app: AppHandle) -> Self {
        // The marks live in pie's own corner of the cache this app was given.
        let logos = app
            .path()
            .app_cache_dir()
            .ok()
            .and_then(|dir| Utf8PathBuf::from_path_buf(dir).ok())
            .map(|cache| cache.join("pie").join("logos"))
            .unwrap_or_default();

        Self {
            hosts: Mutex::new(HashMap::new()),
            bus,
            cache: Mutex::new(CacheStorage::new(logos)),
            dirs: OnceLock::new(),
            app,
        }
    }

    /// The directories of pie's own machine, read from the app's paths on first use.
    pub fn dirs(&self) -> &LocalDirs {
        self.dirs.get_or_init(|| LocalDirs::from_app(&self.app))
    }

    /// The one bus to the frontend. A clone shares it, so it costs an `Arc`.
    pub fn bus(&self) -> Bus {
        self.bus.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> ProviderId {
        ProviderId::new("openai")
    }

    fn cache() -> CacheStorage {
        CacheStorage::new(Utf8PathBuf::from("/cache/pie/logos"))
    }

    fn mark() -> Utf8PathBuf {
        Utf8PathBuf::from("/cache/pie/logos/openai.svg")
    }

    #[test]
    fn a_remembered_mark_is_answered() {
        let mut cache = cache();

        cache.remember(provider());

        assert_eq!(cache.logo(&provider()), Some(mark()));
    }

    #[test]
    fn a_failed_fetch_is_remembered() {
        let mut cache = cache();

        cache.record_failure(provider());

        assert!(cache.failed(&provider()));
    }

    #[test]
    fn a_failure_drops_the_mark_it_replaced() {
        let mut cache = cache();
        cache.remember(provider());

        cache.record_failure(provider());

        assert_eq!(cache.logo(&provider()), None);
        assert!(cache.failed(&provider()));
    }

    #[test]
    fn a_fresh_mark_forgets_the_failure_before_it() {
        let mut cache = cache();
        cache.record_failure(provider());

        cache.remember(provider());

        assert!(!cache.failed(&provider()));
        assert_eq!(cache.logo(&provider()), Some(mark()));
    }
}
