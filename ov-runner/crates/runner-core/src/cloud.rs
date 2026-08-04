//! Outbound WebSocket connection to the cloud, with reconnect + backoff.
//! The runner never listens on a port — it always dials out.

use crate::protocol::CloudMessage;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

/// Handle for sending messages to the cloud.
#[derive(Clone)]
pub struct CloudSender {
    tx: mpsc::UnboundedSender<String>,
}

impl CloudSender {
    pub fn send(&self, msg: &CloudMessage) {
        if let Ok(s) = serde_json::to_string(msg) {
            let _ = self.tx.send(s);
        }
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
    let sender = CloudSender { tx: out_tx };
    let sender_loop = sender.clone();
    let on_message = Arc::new(on_message);

    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            info!("connecting to {cloud_url}");
            match connect_async(&cloud_url).await {
                Ok((ws, _)) => {
                    backoff = Duration::from_secs(1);
                    let (mut write, mut read) = ws.split();

                    // Auth hello.
                    if let Ok(h) = serde_json::to_string(&hello) {
                        let _ = write.send(Message::Text(h)).await;
                    }

                    loop {
                        tokio::select! {
                            // cloud -> runner
                            frame = read.next() => {
                                match frame {
                                    Some(Ok(Message::Text(text))) => {
                                        match serde_json::from_str::<CloudMessage>(&text) {
                                            Ok(msg) => on_message(msg).await,
                                            Err(e) => warn!("bad cloud frame: {e}"),
                                        }
                                    }
                                    Some(Ok(Message::Ping(p))) => {
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
                        }
                    }
                    warn!("disconnected, reconnecting...");
                }
                Err(e) => warn!("connect failed: {e}"),
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    });

    sender_loop
}
