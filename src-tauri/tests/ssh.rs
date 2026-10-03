//! [`SshSession`](pie_lib::pi_rpc::transport::SshSession) against a real sshd.
//!
//! Ignored by default: the tests need the container from
//! `tests/scripts/ssh-fixture.sh`, which serves password and key
//! authentication, the SFTP subsystem, and the host's own `pi` on the remote
//! `PATH`. Start it and export what it prints:
//!
//! ```text
//! eval "$(tests/scripts/ssh-fixture.sh start)"
//! cargo test --test ssh -- --ignored
//! ```
//!
//! The last two tests are the point of the SSH path: a real `pi --mode rpc`
//! reached over SSH answers a real protocol exchange.
//!
//! The one test that needs nothing but this file is what keeps the host honest:
//! it runs when the host does not, and fails when the image would speak a
//! different protocol than the one mirrored here.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use pie_lib::pi_rpc::protocol::{Command, CommandKind, Event, ServerMessage, SessionState};
use pie_lib::pi_rpc::transport::{Control, HostKey, PublicKey, SshAuth, SshSession, SshTarget, Termination, Transport};
use pie_lib::pi_rpc::{Client, Error};
use russh_sftp::client::SftpSession;
use tokio::io::AsyncReadExt;
use tokio::sync::broadcast;

/// What `ssh-fixture.sh start` prints, as the tests need it.
struct Fixture {
    host: String,
    port: u16,
    user: String,
    password: String,
    key: PathBuf,
}

impl Fixture {
    /// Reads the fixture's coordinates, or explains what is missing.
    fn from_env() -> Self {
        let address = std::env::var("PIE_SSH_TEST_ADDR")
            .unwrap_or_else(|_| panic!("set PIE_SSH_TEST_ADDR: eval \"$(tests/scripts/ssh-fixture.sh start)\""));
        let (host, port) = address.rsplit_once(':').expect("PIE_SSH_TEST_ADDR is host:port");
        Self {
            host: host.to_string(),
            port: port.parse().expect("PIE_SSH_TEST_ADDR ends in a port"),
            user: std::env::var("PIE_SSH_TEST_USER").expect("PIE_SSH_TEST_USER"),
            password: std::env::var("PIE_SSH_TEST_PASSWORD").expect("PIE_SSH_TEST_PASSWORD"),
            key: PathBuf::from(std::env::var("PIE_SSH_TEST_KEY").expect("PIE_SSH_TEST_KEY")),
        }
    }

    fn target(&self) -> SshTarget {
        SshTarget::new(self.host.clone(), self.user.clone()).port(self.port)
    }

    fn key_auth(&self) -> SshAuth {
        SshAuth::Key {
            path: self.key.clone(),
            passphrase: None,
        }
    }

    fn password_auth(&self) -> SshAuth {
        SshAuth::Password(self.password.clone())
    }

    /// The command that starts pi where these tests reach it.
    const PI: &'static str = "pi --mode rpc";
}

/// A verifier with a fixed answer.
struct Verdict(Option<&'static str>);

impl HostKey for Verdict {
    fn verify(
        &self,
        host: &str,
        port: u16,
        _key: &PublicKey,
    ) -> Pin<Box<dyn Future<Output = pie_lib::pi_rpc::Result<()>> + Send + '_>> {
        // Owned before the future moves in: the boxed future borrows nothing
        // that outlives this call.
        let endpoint = format!("{host}:{port}");
        let refusal = self.0;
        Box::pin(async move {
            match refusal {
                None => Ok(()),
                Some(reason) => Err(Error::HostKeyRejected {
                    endpoint,
                    reason: reason.to_string(),
                }),
            }
        })
    }
}

/// Next record from the subscriber, or a failure after five seconds.
async fn receive(messages: &mut broadcast::Receiver<ServerMessage>) -> ServerMessage {
    tokio::time::timeout(Duration::from_secs(5), messages.recv())
        .await
        .expect("a record arrived")
        .expect("the client is alive")
}

/// Sockets the fixture's sshd currently has, on a TCP connection to it.
///
/// Read from /proc rather than by asking the transport, because the point is
/// what the host is left holding after `open` gives up.
#[cfg(target_os = "linux")]
fn open_connections_to_the_fixture() -> usize {
    let address = std::env::var("PIE_SSH_TEST_ADDR").expect("PIE_SSH_TEST_ADDR");
    let port: u16 = address.rsplit(':').next().expect("host:port").parse().expect("a port");
    let remote_port = format!("{port:04X}");

    std::fs::read_to_string("/proc/net/tcp")
        .expect("reading /proc/net/tcp")
        .lines()
        .skip(1)
        .filter(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // 01 is ESTABLISHED; the remote address ends with the host's port.
            fields.len() > 3 && fields[3] == "01" && fields[2].ends_with(&remote_port)
        })
        .count()
}

/// A refused connection must not leave the host holding anything.
///
/// `open` gives up by dropping its handle, and that is what ends the SSH
/// session: russh's loop stops once every sender is gone. It is a property of a
/// dependency rather than of this crate, which is why it is worth a test - and
/// it is also why the error paths need no explicit disconnect.
///
/// The count is host-wide, so this test needs the host to itself: run the suite
/// with `--test-threads=1`.
#[tokio::test]
#[cfg_attr(not(target_os = "linux"), ignore = "counts sockets through /proc")]
#[ignore = "requires the ssh fixture"]
async fn a_failed_connection_does_not_leave_the_session_running() {
    let fixture = Fixture::from_env();
    let before = open_connections_to_the_fixture();
    assert!(
        before == 0,
        "the host already holds {before} connection(s): run this suite with --test-threads=1, \
         or an earlier test left one behind"
    );

    for _ in 0..3 {
        let error = SshSession::open(
            fixture.target(),
            SshAuth::Password("definitely not the password".to_string()),
            Arc::new(Verdict(None)),
        )
        .await
        .expect_err("a wrong password cannot authenticate");
        assert!(matches!(error, Error::Auth { .. }), "got {error:?}");
    }

    // The disconnects are on their way out; give the host a moment to close.
    let mut after = open_connections_to_the_fixture();
    for _ in 0..50 {
        after = open_connections_to_the_fixture();
        if after <= before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    assert_eq!(
        after, before,
        "three refused connections left {after} socket(s) open on the host"
    );
}

/// The host must run the release this crate mirrors.
///
/// The image takes pi's version as a build argument, and nothing else connects
/// it to the pin: a stale `ARG` would have the SSH tests quietly exercise a
/// protocol nobody mirrors. This runs without the fixture, so the default
/// `cargo test` is where it is caught.
#[test]
fn the_test_host_runs_the_pinned_pi_version() {
    let dockerfile = [env!("CARGO_MANIFEST_DIR"), "tests", "pi-host", "Dockerfile"]
        .iter()
        .collect::<PathBuf>();
    let source = std::fs::read_to_string(&dockerfile).expect("reading the pi host Dockerfile");

    let declared = source
        .lines()
        .find_map(|line| line.strip_prefix("ARG PI_VERSION="))
        .expect("the Dockerfile declares a default PI_VERSION");

    assert_eq!(
        declared.trim(),
        pie_lib::pi_rpc::PI_VERSION,
        "{} pins pi {declared}; bump it with the protocol",
        dockerfile.display()
    );
}

/// A peer that outruns the reader must still be stoppable.
///
/// This is where the transport and the client meet: the SSH transport copies
/// the channel into a pipe, and that copy blocks once the pipe is full - while
/// the client is waiting for the copy to report how the command ended. A command
/// with no end of output is the reliable way to reach that state.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn terminate_stops_a_command_that_never_stops() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");
    let transport = session.exec("yes").await.expect("the command starts");
    let client = Client::start(transport).expect("the client starts");

    // Long enough for the output to back up behind the reader, which is the
    // state that used to make terminate wait forever.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let termination = tokio::time::timeout(Duration::from_secs(10), client.terminate())
        .await
        .expect("terminate must not wait for a command that never stops");

    // How the peer ended is not the point here: the transport's copy of stdout
    // is abandoned when the client stops reading, so a status that arrives after
    // that never reaches anyone. What has to hold is that terminate returns and
    // the connection is closed.
    let _ = termination;
    assert!(client.is_closed());
}

/// `terminate` must kill the command, not merely stop listening to it.
///
/// Closing the channel does not kill a process that ignores its streams
/// (OpenSSH's session_close_by_channel returns while the child lives): a `sh`
/// that only sleeps would run to completion and leave its marker behind. The
/// `signal` channel request is the kill, and this is what proves it.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn terminate_kills_a_command_that_ignores_its_streams() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");
    let transport = session
        .exec("sh -c 'sleep 2; touch /tmp/pie-terminate-survived'")
        .await
        .expect("the command starts");
    let client = Client::start(transport).expect("the client starts");

    tokio::time::sleep(Duration::from_millis(300)).await;
    let termination = tokio::time::timeout(Duration::from_secs(10), client.terminate())
        .await
        .expect("terminate returns promptly");

    // What the two transports answer for the same kill: the local one reports
    // `Signalled { signal: 9 }` from `child.kill()`, so the SSH one must not
    // answer "unknown" for the request pie just sent.
    assert_eq!(termination, Termination::Signalled { signal: 9 }, "got {termination:?}");

    // Long enough for the `sleep 2` to have run to completion, had it lived.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let probe = session
        .output("sh -c 'test ! -e /tmp/pie-terminate-survived'")
        .await
        .expect("the probe runs");
    assert_eq!(
        probe.termination,
        Termination::Exited { code: 0, success: true },
        "the command was killed before it could leave a marker"
    );
}

/// A peer that floods stderr must not stall stdout, and its exit must still
/// arrive.
///
/// Diagnostics are the one stream that may be dropped: they are for whoever is
/// watching, not part of the conversation. Blocking on them instead would take
/// the protocol stream and the exit status down with them.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn a_flood_of_stderr_does_not_stall_stdout_or_the_exit_status() {
    let fixture = Fixture::from_env();
    // Well past the pipe's capacity, then the output that has to get through.
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");
    let transport = session
        .exec("sh -c 'head -c 200000 /dev/zero 1>&2; echo done; exit 3'")
        .await
        .expect("the command starts");
    let parts = transport.split().expect("the channel splits");
    let mut control = parts.control;
    drop(parts.writer);
    let mut stdout = parts.reader;
    // `diagnostics` is deliberately never read: that is the state the copy
    // used to wedge on.

    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(10), stdout.read_to_string(&mut out))
        .await
        .expect("stdout keeps flowing while stderr is dropped")
        .expect("stdout is readable");
    assert!(
        out.contains("done"),
        "the peer's stdout arrived without its exit: {out:?}"
    );

    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), control.wait())
            .await
            .expect("the exit status arrives even though stderr was dropped")
            .expect("the channel reports its exit"),
        Termination::Exited {
            code: 3,
            success: false
        }
    );
}

/// The transport on its own, without the protocol client on top of it.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn carries_stdout_stderr_and_the_exit_status() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");
    let transport = session
        .exec("sh -c 'echo out; echo err >&2; exit 7'")
        .await
        .expect("the command starts");
    let parts = transport.split().expect("the channel splits");
    let mut control = parts.control;
    drop(parts.writer);
    let mut stdout = parts.reader;
    let mut stderr = parts.diagnostics.expect("an ssh channel reports stderr");

    // Reading stdout to its end means the transport has copied every message it
    // received, stderr among them.
    let mut out = String::new();
    stdout.read_to_string(&mut out).await.expect("stdout is readable");
    let mut err = String::new();
    stderr.read_to_string(&mut err).await.expect("stderr is readable");

    assert_eq!(out, "out\n");
    assert_eq!(err, "err\n");
    assert_eq!(
        control.wait().await.expect("the channel reports its exit"),
        Termination::Exited {
            code: 7,
            success: false
        }
    );
}

/// One session serves every channel pie needs on a host: a captured one-shot
/// command, pi's kind of channel, and the app's sftp scans all share one
/// connection.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn one_session_serves_one_shot_commands_exec_channels_and_the_sftp_subsystem() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");

    // Captured whole: what the check printed and how it ended.
    let output = session
        .output("sh -c 'echo out; echo err >&2; exit 3'")
        .await
        .expect("the one-shot command runs");
    assert_eq!(output.stdout, b"out\n");
    assert_eq!(output.stderr, b"err\n");
    assert_eq!(
        output.termination,
        Termination::Exited {
            code: 3,
            success: false
        }
    );

    // The subsystem the app's file scans ride on.
    let sftp = session.subsystem("sftp").await.expect("the fixture serves sftp");
    let sftp = SftpSession::new(sftp).await.expect("the sftp handshake completes");
    let listing = sftp.read_dir(".").await.expect("the home directory lists");
    let names: Vec<String> = listing.map(|entry| entry.file_name()).collect();
    assert!(!names.is_empty(), "the login home is not empty");

    // And pi's own channel, on the same connection as both of the above.
    let transport = session.exec(Fixture::PI).await.expect("pi starts");
    let client = Client::start(transport).expect("the client starts");
    let response = client.request(Command::new(CommandKind::GetState)).await.unwrap();
    let state: SessionState = response.decode().unwrap();
    assert!(!state.session_id.is_empty(), "a real session has an id");
    assert!(matches!(
        client.shutdown().await,
        Termination::Exited { success: true, .. }
    ));
}

/// A one-shot capture of more than the cap is a truncation, not a failure.
///
/// Reading stops at the cap while the command keeps writing, so the transport's
/// copy of that stream is stuck on a pipe that will never move again. What
/// `head` does - drop the reader - is what ends the capture here: the prefix
/// comes back with the command's real status, promptly, instead of the whole
/// bound timing out and the bytes already read going with it.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn a_one_shot_capture_past_the_cap_returns_the_prefix_promptly() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");

    let started = std::time::Instant::now();
    let output = session
        .output("sh -c 'head -c 5000000 /dev/zero'")
        .await
        .expect("a capped capture is not an error");

    assert_eq!(output.stdout.len(), 4 * 1024 * 1024, "the prefix is the cap, whole");
    assert!(
        output.stdout.iter().all(|byte| *byte == 0),
        "it is the command's own output"
    );
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "promptly, not after the whole bound: {:?}",
        started.elapsed()
    );
    assert!(
        !matches!(output.termination, Termination::Exited { success: true, .. }),
        "the command was ended at the cap, not left to finish: {:?}",
        output.termination
    );
}

/// The cap applies to the diagnostics stream too.
///
/// It is read one byte past the cap like stdout, so no path through this
/// function can grow with what a command writes: the read stops there whatever
/// the host is still sending. How much of a flood actually arrives is the
/// diagnostics stream's own long-standing bargain - the transport's copy drops
/// what does not fit - so the bound, not the amount, is what this pins.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn a_one_shot_capture_of_a_flooding_stderr_is_bounded_too() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");

    let started = std::time::Instant::now();
    let output = session
        .output("sh -c 'head -c 5000000 /dev/zero 1>&2'")
        .await
        .expect("a capped capture is not an error");

    assert!(output.stdout.is_empty(), "the command wrote only diagnostics");
    assert!(!output.stderr.is_empty(), "some of the diagnostics came through");
    assert!(
        output.stderr.len() <= 4 * 1024 * 1024,
        "bounded by the cap, got {}",
        output.stderr.len()
    );
    assert!(
        output.stderr.iter().all(|byte| *byte == 0),
        "it is the command's own output"
    );
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "promptly, not after the whole bound: {:?}",
        started.elapsed()
    );
    // This command finishes on its own and nothing has to end it: what the
    // test pins is that its flood stayed inside the cap and the call came
    // back - not that the command was killed.
}

#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn reports_refused_credentials() {
    let fixture = Fixture::from_env();
    let error = SshSession::open(
        fixture.target(),
        SshAuth::Password("definitely not the password".to_string()),
        Arc::new(Verdict(None)),
    )
    .await
    .expect_err("a wrong password cannot authenticate");

    match error {
        Error::Auth { endpoint } => assert!(endpoint.contains(&fixture.user), "got `{endpoint}`"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn a_refused_host_key_aborts_the_handshake() {
    let fixture = Fixture::from_env();
    let error = SshSession::open(
        fixture.target(),
        fixture.password_auth(),
        Arc::new(Verdict(Some("the test refuses every key"))),
    )
    .await
    .expect_err("the handshake must not continue");

    match error {
        Error::HostKeyRejected { reason, .. } => assert_eq!(reason, "the test refuses every key"),
        other => panic!("unexpected error: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn reports_a_missing_private_key() {
    let fixture = Fixture::from_env();
    // Any path that is not a key file will do; a directory the test itself owns
    // keeps it out of the way of a real one.
    let path = std::env::temp_dir().join("pie-ssh-tests").join("no-such-key");
    let error = SshSession::open(
        fixture.target(),
        SshAuth::Key {
            path: path.clone(),
            passphrase: None,
        },
        Arc::new(Verdict(None)),
    )
    .await
    .expect_err("a key that is not there cannot authenticate");

    match error {
        Error::SshKey { path: reported, .. } => assert_eq!(reported, path),
        other => panic!("unexpected error: {other:?}"),
    }
}

/// OpenSSH runs the command through the user's shell, so a command that does not
/// exist is the shell exiting 127 rather than the server refusing the request -
/// and the transport still has to report the status it sees.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn reports_the_shell_status_of_a_missing_command() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.password_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the shell itself starts");
    let transport = session
        .exec("pie-there-is-no-such-command")
        .await
        .expect("the command starts");
    let client = Client::start(transport).expect("the client starts");

    assert_eq!(
        client.wait().await,
        Termination::Exited {
            code: 127,
            success: false
        }
    );
}

/// A real sshd, a real `pi --mode rpc`, and a real protocol exchange - over SSH.
#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn drives_real_pi_over_ssh_with_a_key() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.key_auth(), Arc::new(Verdict(None)))
        .await
        .expect("the session opens");
    let transport = session.exec(Fixture::PI).await.expect("the ssh channel starts pi");
    let client = Client::start(transport).expect("the client starts");
    let mut messages = client.subscribe();

    let response = client.request(Command::new(CommandKind::GetState)).await.unwrap();
    let state: SessionState = response.decode().unwrap();
    assert!(!state.session_id.is_empty(), "a real session has an id");

    let response = client
        .request(Command::new(CommandKind::SetSessionName {
            name: "pie over ssh".to_string(),
        }))
        .await
        .unwrap();
    assert!(response.is_success());
    assert!(
        matches!(
            receive(&mut messages).await,
            ServerMessage::Event(Event::SessionInfoChanged { .. })
        ),
        "the event stream survives the channel"
    );

    assert_eq!(
        client.shutdown().await,
        Termination::Exited { code: 0, success: true },
        "closing stdin is an orderly shutdown, over ssh too"
    );
}

#[tokio::test]
#[ignore = "requires the ssh fixture"]
async fn drives_real_pi_over_ssh_with_a_password() {
    let fixture = Fixture::from_env();
    let session = SshSession::open(fixture.target(), fixture.password_auth(), Arc::new(Verdict(None)))
        .await
        .expect("password authentication reaches the host");
    let transport = session.exec(Fixture::PI).await.expect("the ssh channel starts pi");
    let client = Client::start(transport).expect("the client starts");

    let response = client.request(Command::new(CommandKind::GetState)).await.unwrap();
    let state: SessionState = response.decode().unwrap();
    assert!(!state.session_id.is_empty(), "a real session has an id");

    assert!(matches!(
        client.shutdown().await,
        Termination::Exited { success: true, .. }
    ));
}
