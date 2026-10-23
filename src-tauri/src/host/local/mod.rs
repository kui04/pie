//! Pi on this machine.
//!
//! The reach to this machine needs nothing: there is no socket to open, no
//! credential to present, and no host key to trust. What is left is where pi
//! starts, and where its files and sessions are read on this machine's
//! filesystem.

mod files;
mod sessions;

use camino::Utf8PathBuf;

use crate::channel::{Channel, Program};

use super::files::Listing;
use super::version::{check_version, probe_version};
use super::{
    BoxFuture, Endpoint, Host, ProgressFn, SessionFileLines, StageSource, accept_version_mismatch, checked_host_path,
};

/// The arguments of the `pi` of this machine: the RPC mode, and the conversation
/// to load at the start when one is named.
///
/// Pi reads the conversation path itself, on the machine where it runs, so the
/// path travels as the host wrote it.
fn pi_args(conversation: Option<&str>) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    if let Some(path) = conversation {
        args.push("--session".to_string());
        args.push(path.to_string());
    }
    args
}

/// This machine, as a machine that runs pi.
pub struct LocalHost {
    /// The home directory of this machine: the start of a session when the
    /// frontend names no directory. `None` leaves pi in the directory of the
    /// app, which is the result on a platform without a home directory.
    home: Option<Utf8PathBuf>,
}

impl std::fmt::Debug for LocalHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("LocalHost").field("home", &self.home).finish()
    }
}

impl LocalHost {
    /// The machine the app itself runs on, with the home the app resolved.
    pub fn new(home: Option<Utf8PathBuf>) -> Self {
        Self { home }
    }
}

impl Host for LocalHost {
    fn connect(&self) -> BoxFuture<'_, anyhow::Result<()>> {
        Box::pin(async move { accept_version_mismatch(self.check_pi().await) })
    }

    fn is_open(&self) -> bool {
        true
    }

    fn endpoint(&self) -> Endpoint {
        Endpoint::local()
    }

    fn open_pi<'a>(
        &'a self,
        cwd: Option<&'a str>,
        conversation: Option<&'a str>,
    ) -> BoxFuture<'a, anyhow::Result<(Channel, Option<String>)>> {
        Box::pin(async move {
            let conversation = conversation.map(checked_host_path).transpose()?;
            let cwd = cwd.map(checked_host_path).transpose()?;
            let dir = cwd.map(Utf8PathBuf::from).or_else(|| self.home.clone());
            let label = dir.as_ref().map(|path| path.as_str().to_string());
            let program = match dir {
                Some(dir) => Program::new("pi").args(pi_args(conversation)).cwd(dir),
                None => Program::new("pi").args(pi_args(conversation)),
            };
            Ok((program.spawn()?, label))
        })
    }

    fn check_pi(&self) -> BoxFuture<'_, anyhow::Result<()>> {
        Box::pin(async move {
            let found = probe_version("pi").await?;
            Ok(check_version(found)?)
        })
    }

    fn dirs<'a>(&'a self, path: Option<&'a str>) -> BoxFuture<'a, anyhow::Result<Listing>> {
        Box::pin(files::dirs(self.home.as_deref(), path))
    }

    fn dir_exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<bool>> {
        Box::pin(files::dir_exists(path))
    }

    fn create_dir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(files::create_dir(path))
    }

    fn remove_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(files::remove_file(path))
    }

    fn read_session_files(
        &self,
        first_text: fn(&[u8]) -> Option<String>,
        name_in: fn(&[u8]) -> Option<Option<String>>,
    ) -> BoxFuture<'_, anyhow::Result<Vec<SessionFileLines>>> {
        Box::pin(sessions::read_sessions(first_text, name_in))
    }

    fn stage_file<'a>(
        &'a self,
        name: &'a str,
        ext: &'a str,
        source: StageSource<'a>,
        mut on_progress: ProgressFn<'a>,
    ) -> BoxFuture<'a, anyhow::Result<String>> {
        Box::pin(async move {
            match source {
                StageSource::LocalFile(path) => {
                    let metadata = tokio::fs::metadata(path).await?;
                    let size = metadata.len();
                    on_progress(size, size);
                    Ok(path.as_str().to_string())
                }
                StageSource::Bytes(bytes) => {
                    let staged = files::stage(name, ext, bytes).await?;
                    let size = bytes.len() as u64;
                    on_progress(size, size);
                    Ok(staged)
                }
            }
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_conversation_is_passed_as_a_session_argument() {
        assert_eq!(pi_args(None), ["--mode", "rpc"]);
        assert_eq!(
            pi_args(Some("/tmp/sessions/one.jsonl")),
            ["--mode", "rpc", "--session", "/tmp/sessions/one.jsonl"]
        );
    }
}
