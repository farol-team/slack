//! runner core: thin client connecting a local coding agent (via ACP)
//! to the cloud Memory Service (tasks from Slack + shared memory endpoint).

pub mod acp;
pub mod agents;
pub mod cloud;
pub mod config;
pub mod connect;
pub mod session;
pub mod protocol;

pub use config::RunnerConfig;
pub use session::SessionManager;
