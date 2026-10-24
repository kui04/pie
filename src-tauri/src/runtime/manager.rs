//! The registry of connected hosts.

use std::{collections::HashMap, sync::Arc};

use super::HostRuntime;
use crate::session::{Id, Session};

/// The connected hosts of one run of pie, and the one the frontend shows.
#[derive(Debug, Default)]
pub struct HostManager {
    runtimes: HashMap<Id, Arc<HostRuntime>>,
    active: Option<Id>,
}

impl HostManager {
    /// Builds an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `runtime` under `id`, and answers the runtime it replaced.
    pub fn insert(&mut self, id: Id, runtime: Arc<HostRuntime>) -> Option<Arc<HostRuntime>> {
        let replaced = self.runtimes.insert(id.clone(), runtime);
        if replaced.is_some() && self.active.as_ref() == Some(&id) {
            self.active = None;
        }
        replaced
    }

    /// Removes the runtime of `id`. The runtime is closed outside this lock.
    pub fn remove(&mut self, id: &Id) -> Option<Arc<HostRuntime>> {
        let removed = self.runtimes.remove(id);
        if self.active.as_ref() == Some(id) {
            self.active = None;
        }
        removed
    }

    /// Removes every runtime, active or still connecting. The runtimes are closed
    /// outside this lock.
    pub fn remove_all(&mut self) -> Vec<Arc<HostRuntime>> {
        self.active = None;
        self.runtimes.drain().map(|(_, runtime)| runtime).collect()
    }

    /// Removes `runtime` only if the registry still holds that same instance.
    ///
    /// A connection that finished after a concurrent disconnect must not remove
    /// the runtime that replaced it.
    pub fn remove_if_current(&mut self, runtime: &Arc<HostRuntime>) -> bool {
        if !self.is_current(runtime) {
            return false;
        }
        self.remove(runtime.id());
        true
    }

    /// Whether no host is registered.
    pub fn is_empty(&self) -> bool {
        self.runtimes.is_empty()
    }

    /// The runtime of `id`, if it is connected.
    pub fn get(&self, id: &Id) -> Option<Arc<HostRuntime>> {
        self.runtimes.get(id).cloned()
    }

    /// The runtime that the frontend shows, if there is one.
    pub fn active(&self) -> Option<Arc<HostRuntime>> {
        self.active.as_ref().and_then(|id| self.runtimes.get(id)).cloned()
    }

    /// Makes `runtime` active only if the registry still holds that same instance.
    ///
    /// A connection that finished after a concurrent disconnect must not revive
    /// the connection.
    pub fn set_active_if_current(&mut self, runtime: &Arc<HostRuntime>) -> bool {
        if !self.is_current(runtime) {
            return false;
        }
        self.active = Some(runtime.id().clone());
        true
    }

    /// Whether the registry still holds this exact runtime.
    pub fn is_current(&self, runtime: &Arc<HostRuntime>) -> bool {
        self.runtimes
            .get(runtime.id())
            .is_some_and(|current| Arc::ptr_eq(current, runtime))
    }

    /// The session with this id, on any connected host.
    pub fn find_session(&self, session_id: &str) -> Option<Session> {
        self.runtimes
            .values()
            .find_map(|runtime| runtime.sessions().session(session_id))
    }

    /// The runtime that holds the session with this id.
    pub fn runtime_for_session(&self, session_id: &str) -> Option<Arc<HostRuntime>> {
        self.runtimes
            .values()
            .find(|runtime| runtime.sessions().session(session_id).is_some())
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::Host;

    fn runtime(name: &str) -> Arc<HostRuntime> {
        Arc::new(HostRuntime::new(
            Id::new(name).expect("a usable name"),
            Arc::new(Host::local(None)),
        ))
    }

    #[test]
    fn a_runtime_is_registered_and_replaced() {
        let mut hosts = HostManager::new();
        let first = runtime("main");
        let second = runtime("main");

        assert!(hosts.insert(Id::new("main").unwrap(), Arc::clone(&first)).is_none());
        let replaced = hosts.insert(Id::new("main").unwrap(), Arc::clone(&second));
        assert!(replaced.is_some_and(|runtime| Arc::ptr_eq(&runtime, &first)));
        assert!(hosts.is_current(&second));
        assert!(!hosts.is_current(&first));
    }

    #[test]
    fn replacing_the_active_runtime_clears_active() {
        let mut hosts = HostManager::new();
        let first = runtime("main");
        let second = runtime("main");
        let id = Id::new("main").unwrap();
        hosts.insert(id.clone(), Arc::clone(&first));
        assert!(hosts.set_active_if_current(&first));

        hosts.insert(id, Arc::clone(&second));

        assert!(
            hosts.active().is_none(),
            "a runtime that is still connecting is not the active one"
        );
    }

    #[test]
    fn remove_all_clears_every_runtime_and_active() {
        let mut hosts = HostManager::new();
        let first = runtime("main");
        let second = runtime("other");
        hosts.insert(Id::new("main").unwrap(), Arc::clone(&first));
        hosts.insert(Id::new("other").unwrap(), Arc::clone(&second));
        assert!(hosts.set_active_if_current(&first));

        let removed = hosts.remove_all();

        assert_eq!(removed.len(), 2);
        assert!(hosts.active().is_none());
        assert!(hosts.get(&Id::new("main").unwrap()).is_none());
        assert!(hosts.get(&Id::new("other").unwrap()).is_none());
    }

    #[test]
    fn removing_the_active_runtime_clears_active() {
        let mut hosts = HostManager::new();
        let runtime = runtime("main");
        let id = Id::new("main").unwrap();
        hosts.insert(id.clone(), Arc::clone(&runtime));
        assert!(hosts.set_active_if_current(&runtime));
        assert!(hosts.active().is_some());

        assert!(hosts.remove(&id).is_some());
        assert!(hosts.active().is_none());
    }

    #[test]
    fn a_stale_runtime_cannot_remove_or_activate_itself() {
        let mut hosts = HostManager::new();
        let first = runtime("main");
        let second = runtime("main");
        hosts.insert(Id::new("main").unwrap(), Arc::clone(&first));
        hosts.insert(Id::new("main").unwrap(), Arc::clone(&second));

        assert!(!hosts.remove_if_current(&first));
        assert!(!hosts.set_active_if_current(&first));
        assert!(hosts.is_current(&second));
        assert!(hosts.set_active_if_current(&second));
        assert!(hosts.remove_if_current(&second));
        assert!(hosts.active().is_none());
    }
}
