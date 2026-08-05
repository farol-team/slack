//! Runner onboarding via the SaaS control plane: "Connect with Slack".
//!
//! The runner asks the SaaS for a one-time connect code, the user approves
//! the runner in a browser, and the runner polls until it receives a runner
//! token (`frl_...`). Replaces the manual token-paste onboarding.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::time::Duration;
use tokio::time::{sleep, Instant};
use tracing::{debug, info};

/// Default poll interval / overall timeout used by the callers.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(2);
pub const DEFAULT_POLL_TIMEOUT: Duration = Duration::from_secs(600);

/// Session returned by `connect/start`: a code for polling plus the URL
/// the user must open in a browser to approve the runner.
#[derive(Debug, Clone)]
pub struct ConnectSession {
    pub code: String,
    pub url: String,
}

/// Outcome of a single `connect/poll` attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Pending,
    Approved { token: String, workspace_id: String },
    Expired,
}

/// Join a SaaS base URL and an API path, tolerating stray slashes.
fn endpoint(saas_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        saas_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// POST /api/runner/connect/start — create a connect session.
pub async fn start(saas_url: &str, label: Option<&str>) -> Result<ConnectSession> {
    #[derive(serde::Serialize)]
    struct StartRequest<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<&'a str>,
    }
    #[derive(Deserialize)]
    struct StartResponse {
        code: String,
        url: String,
    }

    let url = endpoint(saas_url, "/api/runner/connect/start");
    info!(%url, "connect: starting session");
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&StartRequest { label })
        .send()
        .await
        .context("connect/start request failed")?;
    if !resp.status().is_success() {
        bail!("connect/start failed: HTTP {}", resp.status());
    }
    let body: StartResponse = resp
        .json()
        .await
        .context("connect/start: malformed response")?;
    debug!(code = %body.code, "connect: session created");
    Ok(ConnectSession {
        code: body.code,
        url: body.url,
    })
}

/// Wire shape of GET /api/runner/connect/poll responses.
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PollResponse {
    Pending,
    Approved {
        token: Option<String>,
        #[serde(rename = "workspaceId")]
        workspace_id: Option<String>,
    },
    Expired,
}

fn parse_poll_body(body: &str) -> Result<PollOutcome> {
    match serde_json::from_str::<PollResponse>(body).context("connect/poll: malformed response")? {
        PollResponse::Pending => Ok(PollOutcome::Pending),
        PollResponse::Expired => Ok(PollOutcome::Expired),
        PollResponse::Approved {
            token,
            workspace_id,
        } => match (token, workspace_id) {
            (Some(token), Some(workspace_id)) => Ok(PollOutcome::Approved { token, workspace_id }),
            // The SaaS returns "approved" without a token on repeat polls:
            // the one-time token was already consumed — treat as an error.
            _ => bail!("connect/poll: approved without a token (already consumed?)"),
        },
    }
}

/// GET /api/runner/connect/poll?code=... — a single attempt; the caller loops.
pub async fn poll(saas_url: &str, code: &str) -> Result<PollOutcome> {
    let url = endpoint(saas_url, "/api/runner/connect/poll");
    let resp = reqwest::Client::new()
        .get(&url)
        .query(&[("code", code)])
        .send()
        .await
        .context("connect/poll request failed")?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(PollOutcome::Expired);
    }
    if !resp.status().is_success() {
        bail!("connect/poll failed: HTTP {}", resp.status());
    }
    let body = resp.text().await.context("connect/poll: read body failed")?;
    parse_poll_body(&body)
}

/// Poll until the user approves, the code expires, or `timeout` elapses.
pub async fn wait_for_approval(
    saas_url: &str,
    code: String,
    interval: Duration,
    timeout: Duration,
) -> Result<PollOutcome> {
    let deadline = Instant::now() + timeout;
    loop {
        match poll(saas_url, &code).await? {
            PollOutcome::Pending => debug!("connect: still waiting for browser approval"),
            outcome => return Ok(outcome),
        }
        if Instant::now() + interval > deadline {
            bail!(
                "connect: approval timed out after {}s",
                timeout.as_secs()
            );
        }
        sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_joins_slashes() {
        assert_eq!(
            endpoint("https://saas.example/", "/api/x"),
            "https://saas.example/api/x"
        );
        assert_eq!(
            endpoint("https://saas.example", "api/x"),
            "https://saas.example/api/x"
        );
    }

    #[test]
    fn parse_pending() {
        assert_eq!(
            parse_poll_body(r#"{"status":"pending"}"#).unwrap(),
            PollOutcome::Pending
        );
    }

    #[test]
    fn parse_approved() {
        let out = parse_poll_body(
            r#"{"status":"approved","token":"frl_abc","workspaceId":"ws-1"}"#,
        )
        .unwrap();
        assert_eq!(
            out,
            PollOutcome::Approved {
                token: "frl_abc".into(),
                workspace_id: "ws-1".into()
            }
        );
    }

    #[test]
    fn parse_approved_without_token_is_an_error() {
        assert!(parse_poll_body(r#"{"status":"approved"}"#).is_err());
    }

    #[test]
    fn parse_expired() {
        assert_eq!(
            parse_poll_body(r#"{"status":"expired"}"#).unwrap(),
            PollOutcome::Expired
        );
    }

    #[test]
    fn parse_garbage_is_an_error() {
        assert!(parse_poll_body("not json").is_err());
    }
}
