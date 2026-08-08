//! Outbound WebSocket connection to the cloud, with reconnect + backoff.
//! The runner never listens on a port — it always dials out.

use crate::protocol::CloudMessage;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header::USER_AGENT, HeaderValue, Request};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

/// Version and OS travel on the handshake as well as in `hello`.
///
/// The frame is the protocol and stays authoritative; the headers are for
/// everything that never sees a frame — a connection rejected before it
/// authenticates still says what dialed in, and the proxy in front of the
/// cloud writes them to its access log, where frames do not appear.
fn handshake_request(url: &str, version: &str, os: &str) -> Option<Request<()>> {
    let mut req = url.into_client_request().ok()?;
    let headers = req.headers_mut();
    if !version.is_empty() {
        headers.insert(
            "x-opentag-runner-version",
            HeaderValue::from_str(version).ok()?,
        );
    }
    if !os.is_empty() {
        headers.insert("x-opentag-runner-os", HeaderValue::from_str(os).ok()?);
    }
    let agent = format!(
        "opentag-runner/{} ({})",
        if version.is_empty() {
            "unknown"
        } else {
            version
        },
        if os.is_empty() { "unknown" } else { os }
    );
    headers.insert(USER_AGENT, HeaderValue::from_str(&agent).ok()?);
    Some(req)
}

/// Handle for sending messages to the cloud.
#[derive(Clone)]
pub struct CloudSender {
    tx: mpsc::UnboundedSender<String>,
    stop: Arc<Stop>,
}

/// A flag plus a bell: the flag is what the loop head reads, the bell is what
/// wakes it when it is parked on a socket or a backoff sleep.
#[derive(Default)]
struct Stop {
    flag: std::sync::atomic::AtomicBool,
    bell: tokio::sync::Notify,
}

impl Stop {
    fn raised(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl CloudSender {
    pub fn send(&self, msg: &CloudMessage) {
        if let Ok(s) = serde_json::to_string(msg) {
            let _ = self.tx.send(s);
        }
    }

    /// End this connection for good. The caller starts a fresh loop when what
    /// `hello` announces has changed — the installed agents, say.
    pub fn stop(&self) {
        self.stop
            .flag
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.stop.bell.notify_waiters();
    }
}

/// Run the connection loop forever (reconnects with exponential backoff).
/// `on_message` is invoked for every inbound cloud frame.
pub async fn run_connection_loop<F, Fut>(
    cloud_url: String,
    hello: CloudMessage,
    on_message: F,
) -> CloudSender
where
    F: Fn(CloudMessage) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let stop = Arc::new(Stop::default());
    let sender = CloudSender {
        tx: out_tx,
        stop: stop.clone(),
    };
    let sender_loop = sender.clone();
    let on_message = Arc::new(on_message);
    // One source of truth for who we are: whatever `hello` announces is what
    // the handshake claims.
    let (version, os) = match &hello {
        CloudMessage::Hello(h) => (h.runner_version.clone(), h.os.clone()),
        _ => (String::new(), String::new()),
    };

    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            if stop.raised() {
                info!("cloud loop stopped");
                return;
            }
            info!("connecting to {cloud_url} as opentag-runner/{version} ({os})");
            let attempt = match handshake_request(&cloud_url, &version, &os) {
                Some(req) => connect_async(req).await,
                // A URL the header builder choked on is still a URL worth
                // dialing: the frame carries the same facts.
                None => connect_async(&cloud_url).await,
            };
            match attempt {
                Ok((ws, _)) => {
                    backoff = Duration::from_secs(1);
                    let (mut write, mut read) = ws.split();

                    // Auth hello.
                    if let Ok(h) = serde_json::to_string(&hello) {
                        let _ = write.send(Message::Text(h)).await;
                    }

                    // Keepalive: без него тихий обрыв TCP (NAT/docker-proxy)
                    // не виден на read.next() — runner висит offline навсегда.
                    let mut ping_tick = tokio::time::interval(Duration::from_secs(25));
                    let mut last_seen = std::time::Instant::now();

                    loop {
                        tokio::select! {
                            // cloud -> runner
                            frame = read.next() => {
                                match frame {
                                    Some(Ok(Message::Text(text))) => {
                                        last_seen = std::time::Instant::now();
                                        match serde_json::from_str::<CloudMessage>(&text) {
                                            Ok(msg) => on_message(msg).await,
                                            Err(e) => warn!("bad cloud frame: {e}"),
                                        }
                                    }
                                    Some(Ok(Message::Ping(p))) => {
                                        last_seen = std::time::Instant::now();
                                        let _ = write.send(Message::Pong(p)).await;
                                    }
                                    Some(Err(e)) => { warn!("ws error: {e}"); break; }
                                    None => break,
                                    _ => {}
                                }
                            }
                            // runner -> cloud
                            out = out_rx.recv() => {
                                match out {
                                    Some(text) => {
                                        if write.send(Message::Text(text)).await.is_err() { break; }
                                    }
                                    None => return, // sender dropped, shut down
                                }
                            }
                            // the caller wants this connection gone
                            _ = stop.bell.notified() => {
                                info!("cloud loop stopped");
                                return;
                            }
                            // heartbeat: ping каждые 25с, реконнект если тишина > 75с
                            _ = ping_tick.tick() => {
                                if last_seen.elapsed() > Duration::from_secs(75) {
                                    warn!("keepalive timeout, reconnecting...");
                                    break;
                                }
                                if let Ok(ping) = serde_json::to_string(&CloudMessage::Ping) {
                                    if write.send(Message::Text(ping)).await.is_err() { break; }
                                }
                            }
                        }
                    }
                    warn!("disconnected, reconnecting...");
                }
                Err(e) => warn!("connect failed: {e}"),
            }
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = stop.bell.notified() => {
                    info!("cloud loop stopped");
                    return;
                }
            }
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    });

    sender_loop
}
