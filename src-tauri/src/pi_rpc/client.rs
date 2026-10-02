//! The connection to one `pi --mode rpc` process.
//!
//! One read loop per connection: it decodes records, correlates responses by the
//! id the client assigned, and fans everything else out to subscribers. It never
//! blocks on a subscriber - pi relies on stdout backpressure, so the loop keeps
//! reading - and it never panics on protocol drift: unknown records go out as
//! [`ServerMessage::Unknown`].

use std::collections::HashMap;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::pi_rpc::error::{Error, Result};
use crate::pi_rpc::framing::{LineDecoder, encode_line};
use crate::pi_rpc::protocol::{Command, ExtensionUiResponse, Response, ServerMessage};
use crate::pi_rpc::transport::{Control, Termination, Transport, TransportParts};

/// Bytes read from pi per syscall. Records are assembled across chunks, so this
/// only tunes throughput.
const READ_BUFFER: usize = 32 * 1024;

/// Tuning for a [`Client`].
///
/// Set one field without naming the rest:
///
/// ```
/// # use pie_lib::pi_rpc::ClientOptions;
/// let options = ClientOptions {
///     broadcast_capacity: 8,
///     ..ClientOptions::default()
/// };
/// ```
#[derive(Debug, Clone)]
pub struct ClientOptions {
    /// Records that may queue for the writer before a send has to wait.
    ///
    /// 64 by default: deeper than the handful of commands a caller sends before
    /// awaiting anything, so a send only waits when the writer is genuinely
    /// stuck.
    pub outbound_capacity: usize,
    /// Records a subscriber may fall behind by before it starts missing them.
    ///
    /// 1024 by default: several seconds of streaming deltas, while a consumer
    /// slower than that wants to re-read state (`get_state`, `get_messages`)
    /// instead of chasing the stream.
    pub broadcast_capacity: usize,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            outbound_capacity: 64,
            broadcast_capacity: 1024,
        }
    }
}

/// A live connection to pi.
///
/// Cheap to clone - every clone shares the connection, the subscribers and the
/// pending requests. Requests that pi answers are resolved by
/// [`Client::request`]; everything else arrives through [`Client::subscribe`].
#[derive(Debug, Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    outbound: mpsc::Sender<Outbound>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Response>>>>,
    messages: broadcast::Sender<ServerMessage>,
    exit: watch::Sender<Option<Termination>>,
    closing: AtomicBool,
    closed: AtomicBool,
    next_id: AtomicU64,
}

/// Work queued for the writer half of the read loop.
#[derive(Debug)]
enum Outbound {
    /// One serialized record, LF included.
    Line(String),
    /// Close pi's stdin and keep reading until it exits.
    CloseInput,
    /// Kill the process.
    Terminate,
}

impl Client {
    /// Starts the read loop on an already spawned transport.
    ///
    /// Must be called from a Tokio runtime: the loop runs in its own task.
    ///
    /// # Errors
    ///
    /// [`Error::NoRuntime`] outside a Tokio runtime, then whatever
    /// [`Transport::split`] reports - for a local process that is
    /// [`Error::Spawn`] when the binary cannot be started.
    pub fn start<T: Transport>(transport: T) -> Result<Self> {
        Self::start_with(transport, ClientOptions::default())
    }

    /// Starts the read loop with explicit tuning.
    ///
    /// # Errors
    ///
    /// The same as [`Client::start`]: [`Error::NoRuntime`] outside a Tokio
    /// runtime, otherwise the transport's own split failure.
    pub fn start_with<T: Transport>(transport: T, options: ClientOptions) -> Result<Self> {
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(Error::NoRuntime);
        }
        let parts = transport.split()?;
        let (outbound, outbound_rx) = mpsc::channel(options.outbound_capacity);
        let (messages, _) = broadcast::channel(options.broadcast_capacity);
        let (exit, _) = watch::channel::<Option<Termination>>(None);
        let inner = Arc::new(Inner {
            outbound,
            pending: Mutex::new(HashMap::new()),
            messages,
            exit,
            closing: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            next_id: AtomicU64::new(0),
        });

        let read_inner = Arc::clone(&inner);
        tokio::spawn(async move {
            let termination = read_loop(parts, outbound_rx, &read_inner).await;
            read_inner.finish(termination);
        });

        Ok(Self { inner })
    }

    /// Queues a command without waiting for its response.
    ///
    /// Awaits capacity, which is how stdin backpressure reaches the caller.
    ///
    /// # Errors
    ///
    /// [`Error::Encode`] if the record cannot be serialized - always a bug in
    /// this crate - and [`Error::Closed`] once shutdown started or pi is gone.
    pub async fn send(&self, command: &Command) -> Result<()> {
        self.enqueue(Outbound::Line(encode_line(command)?)).await
    }

    /// Answers an [`ExtensionUiResponse`] dialog.
    ///
    /// # Errors
    ///
    /// The same as [`Client::send`].
    pub async fn send_extension_ui_response(&self, response: &ExtensionUiResponse) -> Result<()> {
        self.enqueue(Outbound::Line(encode_line(response)?)).await
    }

    /// Sends a command and waits for the response that carries its id.
    ///
    /// Waiting forever is the protocol's own behavior; apply a limit with
    /// [`Client::request_with_timeout`] where a command may legitimately take
    /// minutes (`compact`, `bash`, `prompt`).
    ///
    /// # Errors
    ///
    /// The send errors of [`Client::send`], plus [`Error::Rpc`] when pi answers
    /// `success: false` - the command failed, the connection did not - and
    /// [`Error::Closed`] when pi exits before answering.
    pub async fn request(&self, command: Command) -> Result<Response> {
        self.request_inner(command, None).await
    }

    /// Sends a command and gives up after `timeout`.
    ///
    /// # Errors
    ///
    /// The same as [`Client::request`], plus [`Error::Timeout`] carrying the id
    /// and command name of the request that was abandoned. A late answer is
    /// still broadcast to subscribers.
    pub async fn request_with_timeout(&self, command: Command, timeout: Duration) -> Result<Response> {
        self.request_inner(command, Some(timeout)).await
    }

    /// Subscribes to everything pi sends that is not a response to a request
    /// made through this client: events, extension dialogs, extension errors,
    /// and responses whose id has no waiter.
    ///
    /// A subscriber that falls behind by more than
    /// [`ClientOptions::broadcast_capacity`] skips records - the read loop never
    /// slows down for a slow consumer. Re-read state with `get_state`,
    /// `get_entries` or `get_messages` after a lag.
    pub fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.inner.messages.subscribe()
    }

    /// Whether pi has exited and the read loop has stopped.
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Waits until pi exits, however it exits.
    pub async fn wait(&self) -> Termination {
        let mut exit = self.inner.exit.subscribe();
        loop {
            if let Some(termination) = *exit.borrow_and_update() {
                return termination;
            }
            if exit.changed().await.is_err() {
                return Termination::Unknown;
            }
        }
    }

    /// Closes pi's stdin and waits for it to exit.
    ///
    /// This is the protocol's orderly shutdown: pi disposes the session and
    /// exits. After it, the client refuses further sends.
    pub async fn shutdown(&self) -> Termination {
        self.inner.closing.store(true, Ordering::SeqCst);
        let _ = self.inner.outbound.send(Outbound::CloseInput).await;
        self.wait().await
    }

    /// Kills pi and waits for it to be reaped.
    pub async fn terminate(&self) -> Termination {
        self.inner.closing.store(true, Ordering::SeqCst);
        let _ = self.inner.outbound.send(Outbound::Terminate).await;
        self.wait().await
    }

    /// Queues work for the read loop, refusing once shutdown started.
    async fn enqueue(&self, outbound: Outbound) -> Result<()> {
        if self.inner.closing.load(Ordering::SeqCst) || self.inner.closed.load(Ordering::SeqCst) {
            return Err(Error::Closed);
        }
        self.inner.outbound.send(outbound).await.map_err(|_| Error::Closed)
    }

    /// Registers a waiter, sends the command, and awaits the matching response.
    async fn request_inner(&self, command: Command, timeout: Option<Duration>) -> Result<Response> {
        let id = self.next_id();
        let command = command.with_id(id.clone());
        let name = command.name().to_string();

        let (waiter, response) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.clone(), waiter);

        if let Err(error) = self.send(&command).await {
            self.forget(&id);
            return Err(error);
        }

        let received = match timeout {
            Some(timeout) => match tokio::time::timeout(timeout, response).await {
                Ok(received) => received,
                Err(_elapsed) => {
                    self.forget(&id);
                    return Err(Error::Timeout {
                        id,
                        command: name,
                        timeout,
                    });
                }
            },
            None => response.await,
        };

        match received {
            // The waiter holds pi's answer, including `success: false`.
            Ok(outcome) => outcome,
            // The read loop dropped the waiter: pi is gone.
            Err(_dropped) => Err(Error::Closed),
        }
    }

    /// Drops a waiter that will never be answered.
    fn forget(&self, id: &str) {
        self.inner
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }

    /// Next correlation id. The prefix keeps ids distinct from pi's own.
    fn next_id(&self) -> String {
        let sequence = self.inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("pie-{sequence}")
    }
}

impl Inner {
    /// Routes one record: to its waiter, or to the subscribers.
    fn dispatch(&self, line: &str) {
        let message = ServerMessage::parse(line);
        if let Some(message) = self.resolve_pending(message) {
            let _ = self.messages.send(message);
        }
    }

    /// Hands a response to its waiter, or returns it for broadcasting.
    fn resolve_pending(&self, message: ServerMessage) -> Option<ServerMessage> {
        let response = match message {
            ServerMessage::Response(response) => response,
            other => return Some(other),
        };
        let Some(id) = response.id.clone() else {
            return Some(ServerMessage::Response(response));
        };
        let waiter = self.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
        let Some(waiter) = waiter else {
            return Some(ServerMessage::Response(response));
        };
        let _ = waiter.send(response.into_result());
        None
    }

    /// Marks the connection dead, releases waiters, and reports the exit.
    fn finish(&self, termination: Termination) {
        self.closed.store(true, Ordering::SeqCst);
        let waiters = {
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            std::mem::take(&mut *pending)
        };
        for (_, waiter) in waiters {
            let _ = waiter.send(Err(Error::Closed));
        }
        self.exit.send_replace(Some(termination));
    }
}

/// Runs until pi exits: reads stdout, writes stdin, correlates nothing else.
async fn read_loop<R, W, C>(
    parts: TransportParts<R, W, C>,
    mut outbound: mpsc::Receiver<Outbound>,
    inner: &Inner,
) -> Termination
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
    C: Control,
{
    let TransportParts {
        reader,
        writer,
        control,
        diagnostics,
    } = parts;
    let mut reader = reader;
    let mut control = control;

    if let Some(stderr) = diagnostics {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(text)) = lines.next_line().await {
                tracing::debug!(target: "pi_rpc::stderr", line = %text, "pi wrote to stderr");
            }
        });
    }

    let mut decoder = LineDecoder::new();
    let mut buffer = vec![0u8; READ_BUFFER];
    // `None` once pi's stdin is closed.
    let mut writer = Some(writer);
    let mut eof = false;

    loop {
        tokio::select! {
            read = reader.read(&mut buffer), if !eof => match read {
                Ok(0) => {
                    eof = true;
                    if let Some(line) = decoder.finish() {
                        inner.dispatch(&line);
                    }
                }
                Ok(count) => {
                    decoder.push(&buffer[..count]);
                    while let Some(line) = decoder.next_line() {
                        inner.dispatch(&line);
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => {
                    tracing::warn!(target: "pi_rpc", %error, "reading from pi failed; tearing it down");
                    let _ = control.terminate().await;
                    break control.wait().await.unwrap_or(Termination::Unknown);
                }
            },
            message = outbound.recv(), if writer.is_some() => match message {
                Some(Outbound::Line(line)) => {
                    let sink = writer.as_mut().expect("guarded by the branch condition");
                    if let Err(error) = write_record(sink, &line).await {
                        tracing::warn!(target: "pi_rpc", %error, "writing to pi failed; closing its stdin");
                        close_stdin(&mut writer).await;
                    }
                }
                Some(Outbound::CloseInput) => close_stdin(&mut writer).await,
                Some(Outbound::Terminate) => {
                    let _ = control.terminate().await;
                    // Nobody reads what is left, and a transport that copies the
                    // peer's output into a pipe only learns the peer is gone
                    // when writing to it. Releasing the reader is what lets that
                    // copy finish, so that `wait` has something to report.
                    drop(reader);
                    break control.wait().await.unwrap_or(Termination::Unknown);
                }
                None => close_stdin(&mut writer).await,
            },
        }

        if eof {
            break control.wait().await.unwrap_or(Termination::Unknown);
        }
    }
}

/// Writes one record and flushes it. Never polled from inside `select!`, so it
/// cannot be cancelled halfway through a record.
async fn write_record<W: AsyncWrite + Unpin>(writer: &mut W, line: &str) -> std::io::Result<()> {
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await
}

/// Closes pi's stdin by shutting the writer down and dropping it.
///
/// Both steps are needed. `AsyncWrite::shutdown` is a no-op for
/// `tokio::process::ChildStdin` (`ChildStdio::poll_shutdown` returns
/// `Ready(Ok(()))` without touching the pipe) and dropping the write half is
/// what gives it EOF; an SSH channel is the other way around - dropping its
/// writer sends nothing, while `shutdown` sends the channel EOF that reaches
/// the remote pi as stdin EOF.
async fn close_stdin<W: AsyncWrite + Unpin>(writer: &mut Option<W>) {
    if let Some(mut writer) = writer.take() {
        if let Err(error) = writer.shutdown().await {
            tracing::debug!(%error, "shutting pi's stdin down before closing it failed");
        }
        drop(writer);
    }
}
