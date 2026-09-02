use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSummary {
    pub id: String,
    pub title: String,
    pub shell: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<u32>,
    pub buffered_bytes: usize,
}

impl TerminalSessionSummary {
    pub fn native(
        id: String,
        title: String,
        shell: String,
        cwd: String,
        pid: u32,
        cols: u16,
        rows: u16,
    ) -> Self {
        let now = iso_now();
        Self {
            id,
            title,
            shell,
            args: Vec::new(),
            cwd,
            project_id: None,
            agent: None,
            agent_source: None,
            agent_activity: None,
            acp_session_id: None,
            kind: None,
            source: "bridged".into(),
            pid: Some(pid),
            status: "running".into(),
            created_at: now.clone(),
            updated_at: now,
            cols: cols.clamp(20, 400),
            rows: rows.clamp(8, 200),
            exit_code: None,
            signal: None,
            buffered_bytes: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub label: String,
    pub shell: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_profile_guid: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProject {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automatic: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalNotification {
    pub id: String,
    pub at: String,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Subscribe {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(default)]
        slot: Option<String>,
    },
    Unsubscribe {
        #[serde(default)]
        slot: Option<String>,
    },
    Input {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    Resize {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Create {
        #[serde(default)]
        title: Option<String>,
        #[serde(default, rename = "profileId")]
        profile_id: Option<String>,
        #[serde(default)]
        shell: Option<String>,
        #[serde(default)]
        args: Option<Vec<String>>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default, rename = "projectId")]
        project_id: Option<String>,
    },
    Rename {
        #[serde(rename = "sessionId")]
        session_id: String,
        title: String,
    },
    Kill {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    RefreshHost,
}

#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub value: Value,
    pub session_id: Option<String>,
    pub output: bool,
}

impl ServerEvent {
    pub fn global(value: Value) -> Self {
        Self {
            value,
            session_id: None,
            output: false,
        }
    }

    pub fn session(value: Value, session_id: impl Into<String>) -> Self {
        Self {
            value,
            session_id: Some(session_id.into()),
            output: false,
        }
    }

    pub fn output(value: Value, session_id: impl Into<String>) -> Self {
        Self {
            value,
            session_id: Some(session_id.into()),
            output: true,
        }
    }
}

pub fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn empty_acp_state() -> Value {
    let capabilities = json!({
        "loadSession": false,
        "auth": { "logout": false },
        "prompt": { "image": false, "audio": false, "embeddedContext": false },
        "session": {
            "list": false, "delete": false, "fork": false, "resume": false,
            "close": false, "additionalDirectories": false
        },
        "mcp": { "acp": false, "http": false, "sse": false },
        "steering": false,
        "goal": { "supported": false, "actions": [] },
        "sessionFailures": false,
        "fileChangeReports": false,
        "nativeSubagents": false,
        "extensions": []
    });
    json!({
        "epoch": uuid::Uuid::new_v4().to_string(),
        "sequence": 0,
        "protocol": { "version": 1, "sdkVersion": "rust-native" },
        "agents": [
            {
                "id": "claude", "label": "Claude", "state": "stopped", "available": false,
                "adapterVersion": "external", "capabilities": capabilities.clone(),
                "authMethods": [], "availableSessions": []
            },
            {
                "id": "codex", "label": "Codex", "state": "stopped", "available": false,
                "adapterVersion": "external", "capabilities": capabilities,
                "authMethods": [], "availableSessions": []
            }
        ],
        "sessions": [],
        "requests": []
    })
}

pub fn parse_since(value: Option<&str>) -> Option<DateTime<Utc>> {
    let milliseconds = value?.parse::<i64>().ok()?;
    DateTime::from_timestamp_millis(milliseconds)
}
