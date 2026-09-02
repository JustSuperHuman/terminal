use crate::model::{
    empty_acp_state, iso_now, parse_since, ClientMessage, ServerEvent, TerminalNotification,
    TerminalProfile, TerminalProject, TerminalSessionSummary,
};
use crate::profiles;
use crate::projects::{self, RememberedProject};
use crate::prompt;
use crate::vt_stream::SafeReplayBuffer;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use parking_lot::{Mutex, RwLock};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message as BridgeMessage;
use tower_http::compression::CompressionLayer;
use uuid::Uuid;

pub const STATUS_CONNECTING: u32 = 1;
pub const STATUS_CONNECTED: u32 = 2;
pub const STATUS_FAILING: u32 = 3;

pub const COMMAND_INPUT: u32 = 1;
pub const COMMAND_RESIZE: u32 = 2;
pub const COMMAND_KILL: u32 = 3;

const MAX_NOTIFICATIONS: usize = 200;
const MAX_PROJECTS: usize = 200;

struct EmbeddedClientAsset {
    path: &'static str,
    content_type: &'static str,
    bytes: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/embedded_client.rs"));

pub type NativeCommandCallback = unsafe extern "C" fn(
    context: *mut c_void,
    session_id: *const u16,
    session_id_len: usize,
    kind: u32,
    data: *const u16,
    data_len: usize,
    rows: u32,
    cols: u32,
);

#[derive(Clone, Copy)]
pub struct NativeCallback {
    pub context: usize,
    pub callback: NativeCommandCallback,
}

unsafe impl Send for NativeCallback {}
unsafe impl Sync for NativeCallback {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeConfig {
    pub automatic_port: bool,
    pub port: u16,
    pub bind_address: String,
    pub web_interface_enabled: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            automatic_port: true,
            port: 10001,
            bind_address: "0.0.0.0".into(),
            web_interface_enabled: true,
        }
    }
}

#[derive(Clone, Debug)]
enum SessionSink {
    Native,
    Bridge(mpsc::UnboundedSender<Value>),
}

struct Session {
    summary: TerminalSessionSummary,
    parser: vt100::Parser,
    output_filter: OutputFilter,
    replay: SafeReplayBuffer,
    seq: u64,
    sink: SessionSink,
}

impl Session {
    fn new(summary: TerminalSessionSummary, sink: SessionSink) -> Self {
        Self {
            parser: vt100::Parser::new(summary.rows, summary.cols, 5000),
            summary,
            output_filter: OutputFilter::default(),
            replay: SafeReplayBuffer::default(),
            seq: 0,
            sink,
        }
    }

    fn append(&mut self, data: String) -> u64 {
        self.seq += 1;
        self.parser.process(data.as_bytes());
        self.replay.push(self.seq, data, iso_now());
        self.summary.updated_at = iso_now();
        self.summary.buffered_bytes = self.replay.bytes();
        self.seq
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(8, 200);
        self.summary.cols = cols;
        self.summary.rows = rows;
        self.parser.screen_mut().set_size(rows, cols);
        self.summary.updated_at = iso_now();
    }

    fn screen_ansi(&self) -> String {
        String::from_utf8_lossy(&self.parser.screen().contents_formatted()).into_owned()
    }

    fn plain_text(&self) -> String {
        self.parser.screen().contents()
    }

    fn snapshot(&self) -> Value {
        let chunks: Vec<Value> = self
            .replay
            .chunks()
            .map(|chunk| {
                json!({
                    "seq": chunk.seq,
                    "data": chunk.data,
                    "at": chunk.at
                })
            })
            .collect();
        json!({
            "type": "snapshot",
            "sessionId": self.summary.id,
            "screen": self.screen_ansi(),
            "chunks": chunks,
            "session": self.summary
        })
    }

    fn export(&self) -> Value {
        let chunks: Vec<Value> = self
            .replay
            .chunks()
            .map(|chunk| {
                json!({
                    "seq": chunk.seq,
                    "data": chunk.data,
                    "at": chunk.at
                })
            })
            .collect();
        json!({
            "session": self.summary,
            "screen": self.screen_ansi(),
            "transcript": self.replay.transcript(),
            "chunks": chunks
        })
    }
}

struct Inner {
    sessions: HashMap<String, Session>,
    profiles: Vec<TerminalProfile>,
    projects: Vec<TerminalProject>,
    remembered_projects: HashMap<String, RememberedProject>,
    project_order: Vec<String>,
    published_projects: Vec<TerminalProject>,
    notifications: VecDeque<TerminalNotification>,
    acp: Value,
    started_at: String,
    host: IpAddr,
    port: u16,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<ServerEvent>,
    bridge_events: broadcast::Sender<Value>,
    callback: NativeCallback,
    pub token: Arc<String>,
    pub data_root: Arc<PathBuf>,
    pub endpoint: Arc<RwLock<String>>,
    pub status: Arc<AtomicU32>,
    pub config: Arc<BridgeConfig>,
    attachment_cleanup_started: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(
        asset_root: PathBuf,
        data_root: PathBuf,
        callback: NativeCallback,
        config: BridgeConfig,
    ) -> Self {
        let (events, _) = broadcast::channel(4096);
        let (bridge_events, _) = broadcast::channel(4096);
        let token = load_or_create_token(&data_root);
        let store = load_projects(&data_root, &asset_root);
        let published_projects = projects::visible_projects(
            &store.projects,
            &store.remembered,
            &store.order,
            std::iter::empty(),
        );
        Self {
            inner: Arc::new(Mutex::new(Inner {
                sessions: HashMap::new(),
                profiles: profiles::read_profiles(),
                projects: store.projects,
                remembered_projects: store.remembered,
                project_order: store.order,
                published_projects,
                notifications: VecDeque::new(),
                acp: empty_acp_state(),
                started_at: iso_now(),
                host: "0.0.0.0".parse().unwrap(),
                port: 0,
            })),
            events,
            bridge_events,
            callback,
            token: Arc::new(token),
            data_root: Arc::new(data_root),
            endpoint: Arc::new(RwLock::new("127.0.0.1:10001".into())),
            status: Arc::new(AtomicU32::new(STATUS_CONNECTING)),
            config: Arc::new(config),
            attachment_cleanup_started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn register_native(&self, summary: TerminalSessionSummary) {
        let id = summary.id.clone();
        let mut inner = self.inner.lock();
        if let Some(existing) = inner.sessions.get_mut(&id) {
            existing.summary = summary.clone();
            existing.sink = SessionSink::Native;
        } else {
            inner.sessions.insert(
                id.clone(),
                Session::new(summary.clone(), SessionSink::Native),
            );
        }
        drop(inner);
        self.publish(ServerEvent::session(
            json!({ "type": "session", "session": summary }),
            id,
        ));
        self.publish_sessions();
        self.publish_bridge(json!({ "type": "register", "session": summary }));
        self.reconcile_projects();
    }

    fn register_bridge(
        &self,
        mut summary: TerminalSessionSummary,
        replay: Option<String>,
        sender: mpsc::UnboundedSender<Value>,
    ) {
        summary.source = "bridged".into();
        summary.status = "running".into();
        summary.cols = summary.cols.clamp(20, 400);
        summary.rows = summary.rows.clamp(8, 200);
        let id = summary.id.clone();
        {
            let mut inner = self.inner.lock();
            if let Some(session) = inner.sessions.get_mut(&id) {
                session.summary = summary.clone();
                session.sink = SessionSink::Bridge(sender.clone());
                summary = session.summary.clone();
            } else {
                let mut session =
                    Session::new(summary.clone(), SessionSink::Bridge(sender.clone()));
                if let Some(replay) = replay.filter(|value| !value.is_empty()) {
                    session.append(replay);
                }
                summary = session.summary.clone();
                inner.sessions.insert(id.clone(), session);
            }
        }
        let _ = sender.send(json!({ "type": "registered", "session": summary, "replay": false }));
        self.publish(ServerEvent::session(
            json!({ "type": "session", "session": summary }),
            id,
        ));
        self.publish_sessions();
        self.reconcile_projects();
    }

    pub fn append_output(&self, session_id: &str, data: String, replayed: bool) {
        let (seq, visible_data, summary_changed) = {
            let mut inner = self.inner.lock();
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            let previous_agent = session.summary.agent.clone();
            let visible = session.output_filter.feed(&data, &mut session.summary);
            let seq = session.append(visible.clone());
            (seq, visible, previous_agent != session.summary.agent)
        };
        if visible_data.is_empty() {
            return;
        }
        self.publish(ServerEvent::output(
            json!({
                "type": "output",
                "sessionId": session_id,
                "seq": seq,
                "data": visible_data,
                "replay": replayed
            }),
            session_id,
        ));
        self.publish_bridge(json!({
            "type": "output", "sessionId": session_id, "sourceSeq": seq,
            "data": visible_data
        }));
        if summary_changed {
            if let Some(summary) = self.summary(session_id) {
                self.publish(ServerEvent::session(
                    json!({ "type": "session", "session": summary }),
                    session_id,
                ));
            }
        }
    }

    pub fn rename(&self, session_id: &str, title: String) -> Option<TerminalSessionSummary> {
        let summary = {
            let mut inner = self.inner.lock();
            let session = inner.sessions.get_mut(session_id)?;
            if !title.trim().is_empty() {
                session.summary.title = title;
                session.summary.updated_at = iso_now();
            }
            session.summary.clone()
        };
        self.publish(ServerEvent::session(
            json!({ "type": "session", "session": summary }),
            session_id,
        ));
        self.publish_bridge(json!({
            "type": "title", "sessionId": session_id, "title": summary.title
        }));
        Some(summary)
    }

    pub fn set_project(&self, session_id: &str, project_id: Option<String>) {
        let summary = {
            let mut inner = self.inner.lock();
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            session.summary.project_id = project_id;
            session.summary.updated_at = iso_now();
            session.summary.clone()
        };
        self.publish(ServerEvent::session(
            json!({ "type": "session", "session": summary }),
            session_id,
        ));
        self.publish_bridge(json!({
            "type": "project", "sessionId": session_id, "projectId": summary.project_id
        }));
    }

    /// Records a session's live working directory (native shell integration
    /// reports OSC 7 / 9;9 changes) and re-derives the automatic projects.
    pub fn set_cwd(&self, session_id: &str, cwd: String) {
        let cwd = cwd.trim().to_owned();
        if cwd.is_empty() {
            return;
        }
        let summary = {
            let mut inner = self.inner.lock();
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            if projects::cwd_key(&session.summary.cwd) == projects::cwd_key(&cwd) {
                return;
            }
            session.summary.cwd = cwd;
            session.summary.updated_at = iso_now();
            session.summary.clone()
        };
        self.publish(ServerEvent::session(
            json!({ "type": "session", "session": summary }),
            session_id,
        ));
        self.publish_bridge(json!({
            "type": "cwd", "sessionId": session_id, "cwd": summary.cwd
        }));
        self.reconcile_projects();
    }

    pub fn resize_from_native(&self, session_id: &str, cols: u16, rows: u16) {
        let summary = {
            let mut inner = self.inner.lock();
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            session.resize(cols, rows);
            session.summary.clone()
        };
        self.publish(ServerEvent::session(
            json!({ "type": "session", "session": summary }),
            session_id,
        ));
        self.publish_bridge(json!({
            "type": "resize", "sessionId": session_id,
            "cols": summary.cols, "rows": summary.rows
        }));
    }

    pub fn exit(&self, session_id: &str, exit_code: Option<u32>, signal: Option<u32>) {
        let summary = {
            let mut inner = self.inner.lock();
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            session.summary.status = "exited".into();
            session.summary.exit_code = exit_code;
            session.summary.signal = signal;
            session.summary.updated_at = iso_now();
            session.summary.clone()
        };
        self.publish(ServerEvent::session(
            json!({
                "type": "exit", "sessionId": session_id, "exitCode": exit_code,
                "signal": signal, "session": summary
            }),
            session_id,
        ));
        self.publish_sessions();
        self.publish_bridge(json!({
            "type": "exit", "sessionId": session_id,
            "exitCode": exit_code, "signal": signal
        }));
        self.reconcile_projects();
    }

    pub fn unregister(&self, session_id: &str) {
        self.inner.lock().sessions.remove(session_id);
        self.publish_sessions();
        self.publish_bridge(json!({ "type": "unregister", "sessionId": session_id }));
        self.reconcile_projects();
    }

    fn disconnect_bridge(
        &self,
        session_ids: &[String],
        sender: &mpsc::UnboundedSender<Value>,
    ) -> Vec<String> {
        let mut disconnected = Vec::new();
        let mut inner = self.inner.lock();
        for id in session_ids {
            let Some(session) = inner.sessions.get_mut(id) else {
                continue;
            };
            let still_owned = matches!(
                &session.sink,
                SessionSink::Bridge(current) if current.same_channel(sender)
            );
            if still_owned {
                session.summary.status = "exited".into();
                session.summary.updated_at = iso_now();
                disconnected.push(id.clone());
            }
        }
        drop(inner);
        for id in &disconnected {
            if let Some(summary) = self.summary(id) {
                self.publish(ServerEvent::session(
                    json!({
                        "type": "exit", "sessionId": id,
                        "exitCode": null, "signal": null, "session": summary
                    }),
                    id,
                ));
            }
        }
        if !disconnected.is_empty() {
            self.publish_sessions();
            self.reconcile_projects();
        }
        disconnected
    }

    pub fn summaries(&self) -> Vec<TerminalSessionSummary> {
        let mut sessions: Vec<_> = self
            .inner
            .lock()
            .sessions
            .values()
            .map(|session| session.summary.clone())
            .collect();
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        sessions
    }

    pub fn summary(&self, session_id: &str) -> Option<TerminalSessionSummary> {
        self.inner
            .lock()
            .sessions
            .get(session_id)
            .map(|session| session.summary.clone())
    }

    fn publish_sessions(&self) {
        self.publish(ServerEvent::global(
            json!({ "type": "sessions", "sessions": self.summaries() }),
        ));
    }

    fn publish(&self, event: ServerEvent) {
        let _ = self.events.send(event);
    }

    fn publish_bridge(&self, event: Value) {
        let _ = self.bridge_events.send(event);
    }

    fn persist_projects(&self) {
        let (projects, names, order) = {
            let inner = self.inner.lock();
            let mut names: Vec<RememberedProject> =
                inner.remembered_projects.values().cloned().collect();
            names.sort_by(|left, right| right.last_used_at.cmp(&left.last_used_at));
            (inner.projects.clone(), names, inner.project_order.clone())
        };
        let path = self.data_root.join(".terminal-web-projects.json");
        if let Ok(serialized) = serde_json::to_vec_pretty(&json!({
            "projects": projects,
            "names": names,
            "order": order
        })) {
            let _ = std::fs::create_dir_all(self.data_root.as_ref());
            let _ = std::fs::write(path, serialized);
        }
    }

    fn visible_projects_locked(inner: &Inner) -> Vec<TerminalProject> {
        projects::visible_projects(
            &inner.projects,
            &inner.remembered_projects,
            &inner.project_order,
            inner.sessions.values().map(|session| &session.summary),
        )
    }

    /// Re-derives the visible project list from saved projects and live
    /// session directories, stamps every running session with the project it
    /// sits in, and broadcasts whatever changed.
    pub fn reconcile_projects(&self) -> Vec<TerminalProject> {
        let (projects, projects_changed, changed_sessions) = {
            let mut inner = self.inner.lock();
            let projects = Self::visible_projects_locked(&inner);
            let projects_changed = inner.published_projects != projects;
            let mut changed_sessions = Vec::new();
            for session in inner.sessions.values_mut() {
                let assigned = if session.summary.status == "running" {
                    projects::project_id_for_cwd(&projects, &session.summary.cwd)
                } else {
                    session.summary.project_id.clone()
                };
                if session.summary.project_id != assigned {
                    session.summary.project_id = assigned;
                    changed_sessions.push(session.summary.clone());
                }
            }
            inner.published_projects = projects.clone();
            (projects, projects_changed, changed_sessions)
        };
        for summary in changed_sessions {
            let id = summary.id.clone();
            self.publish(ServerEvent::session(
                json!({ "type": "session", "session": summary }),
                id,
            ));
        }
        if projects_changed {
            self.publish(ServerEvent::global(
                json!({ "type": "projects", "projects": projects }),
            ));
        }
        projects
    }

    pub fn projects(&self) -> Vec<TerminalProject> {
        self.reconcile_projects()
    }

    fn remember_project_locked(inner: &mut Inner, cwd: &str, name: &str) {
        let key = projects::cwd_key(cwd);
        if key.is_empty() {
            return;
        }
        inner.remembered_projects.insert(
            key,
            RememberedProject {
                name: name.trim().to_owned(),
                cwd: cwd.trim().to_owned(),
                last_used_at: iso_now(),
            },
        );
        while inner.remembered_projects.len() > MAX_PROJECTS {
            let oldest = inner
                .remembered_projects
                .iter()
                .min_by(|left, right| left.1.last_used_at.cmp(&right.1.last_used_at))
                .map(|(key, _)| key.clone());
            match oldest {
                Some(key) => inner.remembered_projects.remove(&key),
                None => break,
            };
        }
    }

    pub fn create_project(&self, name: Option<&str>, cwd: &str) -> TerminalProject {
        let cwd = cwd.trim();
        let key = projects::cwd_key(cwd);
        let project = {
            let mut inner = self.inner.lock();
            let existing = inner
                .projects
                .iter()
                .position(|project| projects::cwd_key(&project.cwd) == key);
            let name = name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    projects::automatic_name(cwd, inner.remembered_projects.get(&key))
                });
            let project = if let Some(index) = existing {
                inner.projects[index].name = name.clone();
                inner.projects[index].clone()
            } else {
                // Reuse the automatic id for this directory so tabs already
                // filtered to it keep their project when it becomes saved.
                let project = TerminalProject {
                    id: projects::automatic_id(&key),
                    name: name.clone(),
                    cwd: cwd.to_owned(),
                    created_at: iso_now(),
                    automatic: None,
                };
                inner.projects.push(project.clone());
                if inner.projects.len() > MAX_PROJECTS {
                    inner.projects.remove(0);
                }
                project
            };
            Self::remember_project_locked(&mut inner, cwd, &name);
            project
        };
        self.persist_projects();
        self.reconcile_projects();
        project
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Option<TerminalProject> {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        {
            let mut inner = self.inner.lock();
            let cwd =
                if let Some(saved) = inner.projects.iter_mut().find(|project| project.id == id) {
                    saved.name = name.to_owned();
                    saved.cwd.clone()
                } else {
                    inner
                        .published_projects
                        .iter()
                        .find(|project| project.id == id)
                        .map(|project| project.cwd.clone())?
                };
            Self::remember_project_locked(&mut inner, &cwd, name);
        }
        self.persist_projects();
        self.reconcile_projects()
            .into_iter()
            .find(|project| project.id == id)
    }

    pub fn delete_project(&self, id: &str) {
        {
            let mut inner = self.inner.lock();
            if let Some(index) = inner.projects.iter().position(|project| project.id == id) {
                let removed = inner.projects.remove(index);
                Self::remember_project_locked(&mut inner, &removed.cwd, &removed.name);
            }
            inner.project_order.retain(|candidate| candidate != id);
        }
        self.persist_projects();
        self.reconcile_projects();
    }

    pub fn reorder_projects(&self, ids: Vec<String>) {
        {
            let mut inner = self.inner.lock();
            let mut order: Vec<String> = ids.into_iter().filter(|id| !id.is_empty()).collect();
            for project in &inner.published_projects {
                if !order.contains(&project.id) {
                    order.push(project.id.clone());
                }
            }
            inner.project_order = order;
        }
        self.persist_projects();
        self.reconcile_projects();
    }

    pub fn recent_projects(&self) -> Vec<RememberedProject> {
        let mut recents: Vec<RememberedProject> = self
            .inner
            .lock()
            .remembered_projects
            .values()
            .cloned()
            .collect();
        recents.sort_by(|left, right| right.last_used_at.cmp(&left.last_used_at));
        recents
    }

    fn dispatch(
        &self,
        session_id: &str,
        kind: u32,
        data: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), String> {
        let sink = {
            let inner = self.inner.lock();
            inner
                .sessions
                .get(session_id)
                .map(|session| session.sink.clone())
        }
        .ok_or_else(|| "Unknown terminal session.".to_string())?;

        match sink {
            SessionSink::Native => {
                let id: Vec<u16> = session_id.encode_utf16().collect();
                let data: Vec<u16> = data.encode_utf16().collect();
                unsafe {
                    (self.callback.callback)(
                        self.callback.context as *mut c_void,
                        id.as_ptr(),
                        id.len(),
                        kind,
                        data.as_ptr(),
                        data.len(),
                        rows.into(),
                        cols.into(),
                    );
                }
            }
            SessionSink::Bridge(sender) => {
                let message = match kind {
                    COMMAND_INPUT => {
                        json!({ "type": "input", "sessionId": session_id, "data": data })
                    }
                    COMMAND_RESIZE => {
                        json!({ "type": "resize", "sessionId": session_id, "rows": rows, "cols": cols })
                    }
                    COMMAND_KILL => json!({ "type": "kill", "sessionId": session_id }),
                    _ => return Err("Unknown bridge command.".into()),
                };
                sender
                    .send(message)
                    .map_err(|_| "The bridge connection closed.".to_string())?;
            }
        }
        Ok(())
    }

    fn snapshot(&self, session_id: &str) -> Option<Value> {
        self.inner
            .lock()
            .sessions
            .get(session_id)
            .map(Session::snapshot)
    }

    fn export(&self, session_id: &str) -> Option<Value> {
        self.inner
            .lock()
            .sessions
            .get(session_id)
            .map(Session::export)
    }

    fn plain_text(&self, session_id: &str) -> Option<String> {
        self.inner
            .lock()
            .sessions
            .get(session_id)
            .map(Session::plain_text)
    }

    fn input_context(&self, session_id: &str) -> Option<Value> {
        let inner = self.inner.lock();
        let session = inner.sessions.get(session_id)?;
        Some(prompt::input_context(
            &session.summary,
            &session.plain_text(),
            session.parser.screen().bracketed_paste(),
            session.parser.screen().application_cursor(),
        ))
    }

    fn bootstrap(&self) -> Value {
        let inner = self.inner.lock();
        let port = inner.port;
        let host = inner.host;
        let urls = server_access_urls(host, port, &self.token, &network_interface_addresses());
        json!({
            "sessions": inner.sessions.values().map(|session| session.summary.clone()).collect::<Vec<_>>(),
            "profiles": inner.profiles,
            "hostProcesses": [],
            "peerHosts": [],
            "projects": Self::visible_projects_locked(&inner),
            "server": {
                "pid": std::process::id(),
                "host": host.to_string(),
                "port": port,
                "startedAt": inner.started_at,
                "urls": urls
            },
            "bridgeCommands": { "serverUrl": format!("http://127.0.0.1:{port}"), "shell": "", "codex": "", "claude": "" },
            "orchestrator": { "state": "stopped", "availableAgents": [] },
            "acp": inner.acp
        })
    }

    fn hello(&self) -> Value {
        let bootstrap = self.bootstrap();
        json!({
            "type": "hello",
            "sessions": bootstrap["sessions"],
            "profiles": bootstrap["profiles"],
            "hostProcesses": bootstrap["hostProcesses"],
            "peerHosts": bootstrap["peerHosts"],
            "projects": bootstrap["projects"],
            "server": bootstrap["server"],
            "bridgeCommands": bootstrap["bridgeCommands"],
            "orchestrator": bootstrap["orchestrator"],
            "acp": bootstrap["acp"]
        })
    }

    fn notifications(
        &self,
        since: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Vec<TerminalNotification> {
        self.inner
            .lock()
            .notifications
            .iter()
            .filter(|notification| {
                since.is_none_or(|since| {
                    chrono::DateTime::parse_from_rfc3339(&notification.at)
                        .map(|at| at.with_timezone(&chrono::Utc) > since)
                        .unwrap_or(true)
                })
            })
            .cloned()
            .collect()
    }

    fn notify(&self, mut notification: TerminalNotification) {
        if notification.id.is_empty() {
            notification.id = Uuid::new_v4().to_string();
        }
        if notification.at.is_empty() {
            notification.at = iso_now();
        }
        {
            let mut inner = self.inner.lock();
            inner.notifications.push_back(notification.clone());
            while inner.notifications.len() > MAX_NOTIFICATIONS {
                inner.notifications.pop_front();
            }
        }
        let mut value = serde_json::to_value(notification).unwrap_or_else(|_| json!({}));
        if let Some(object) = value.as_object_mut() {
            object.insert("type".into(), Value::String("notify".into()));
        }
        self.publish(ServerEvent::global(value));
    }

    fn bridge_snapshot(&self) -> (Vec<Value>, HashMap<String, u64>) {
        let inner = self.inner.lock();
        let mut sequences = HashMap::new();
        let registrations = inner
            .sessions
            .values()
            .filter_map(|session| {
                if !matches!(session.sink, SessionSink::Native) {
                    return None;
                }
                sequences.insert(session.summary.id.clone(), session.seq);
                Some(json!({
                    "type": "register",
                    "session": session.summary,
                    "replay": session.replay.transcript()
                }))
            })
            .collect();
        (registrations, sequences)
    }
}

fn network_interface_addresses() -> Vec<(String, IpAddr)> {
    let mut interfaces: Vec<_> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| {
            let address = interface.ip();
            if address.is_ipv4() && !address.is_loopback() && !address.is_unspecified() {
                Some((interface.name, address))
            } else {
                None
            }
        })
        .collect();
    interfaces.sort_by(|left, right| {
        left.0
            .to_lowercase()
            .cmp(&right.0.to_lowercase())
            .then_with(|| left.1.to_string().cmp(&right.1.to_string()))
    });
    interfaces
}

fn server_access_urls(
    host: IpAddr,
    port: u16,
    token: &str,
    interfaces: &[(String, IpAddr)],
) -> Vec<Value> {
    let mut urls = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |label: &str, address: IpAddr, scope: &str| {
        let address_text = address.to_string();
        let uri_host = match address {
            IpAddr::V4(_) => address_text.clone(),
            IpAddr::V6(_) => format!("[{address_text}]"),
        };
        let token_required = scope == "network";
        let url = if token_required {
            format!("http://{uri_host}:{port}/?token={token}")
        } else {
            format!("http://{uri_host}:{port}/")
        };
        if seen.insert(url.clone()) {
            urls.push(json!({
                "label": label,
                "address": address_text,
                "url": url,
                "scope": scope,
                "tokenRequired": token_required
            }));
        }
    };

    add("Local", "127.0.0.1".parse().unwrap(), "local");
    if host.is_unspecified() {
        for (label, address) in interfaces {
            add(label, *address, "network");
        }
    } else if !host.is_loopback() {
        add("Bound host", host, "network");
    }
    urls
}

const PRIVATE_AGENT_OSC: &str = "1337;TerminalWeb.Agent=";
const MAX_FILTERED_OSC_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum OutputFilterState {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
    DiscardOsc,
    DiscardOscEscape,
}

/// Removes the bridge's private metadata envelope without touching ordinary
/// terminal controls. The scanner owns incomplete OSC frames across native
/// output calls, so neither a split marker nor a malformed oversized marker
/// can leak a printable tail to web/mobile clients.
#[derive(Debug, Default)]
struct OutputFilter {
    state: OutputFilterState,
    frame: String,
}

impl OutputFilter {
    fn feed(&mut self, data: &str, summary: &mut TerminalSessionSummary) -> String {
        use OutputFilterState::*;
        let mut visible = String::with_capacity(data.len());
        for character in data.chars() {
            match self.state {
                Ground => {
                    if character == '\u{1b}' {
                        self.frame.clear();
                        self.frame.push(character);
                        self.state = Escape;
                    } else {
                        visible.push(character);
                    }
                }
                Escape => {
                    if character == ']' {
                        self.frame.push(character);
                        self.state = Osc;
                    } else if character == '\u{1b}' {
                        visible.push_str(&self.frame);
                        self.frame.clear();
                        self.frame.push(character);
                    } else {
                        self.frame.push(character);
                        visible.push_str(&self.frame);
                        self.frame.clear();
                        self.state = Ground;
                    }
                }
                Osc => {
                    self.frame.push(character);
                    if character == '\u{7}' {
                        self.finish_osc(summary, &mut visible, 1);
                    } else if character == '\u{1b}' {
                        self.state = OscEscape;
                    } else if self.frame.len() > MAX_FILTERED_OSC_BYTES {
                        self.frame.clear();
                        self.state = DiscardOsc;
                    }
                }
                OscEscape => {
                    self.frame.push(character);
                    if character == '\\' {
                        self.finish_osc(summary, &mut visible, 2);
                    } else if character != '\u{1b}' {
                        self.state = Osc;
                    }
                }
                DiscardOsc => {
                    if character == '\u{7}' {
                        self.state = Ground;
                    } else if character == '\u{1b}' {
                        self.state = DiscardOscEscape;
                    }
                }
                DiscardOscEscape => {
                    self.state = if character == '\\' {
                        Ground
                    } else {
                        DiscardOsc
                    };
                }
            }
        }
        visible
    }

    fn finish_osc(
        &mut self,
        summary: &mut TerminalSessionSummary,
        visible: &mut String,
        terminator_bytes: usize,
    ) {
        let body_end = self.frame.len().saturating_sub(terminator_bytes);
        let body = self.frame.get(2..body_end).unwrap_or_default();
        if let Some(encoded) = body.strip_prefix(PRIVATE_AGENT_OSC) {
            apply_agent_metadata(summary, encoded);
        } else {
            visible.push_str(&self.frame);
        }
        self.frame.clear();
        self.state = OutputFilterState::Ground;
    }
}

fn apply_agent_metadata(summary: &mut TerminalSessionSummary, encoded: &str) {
    if encoded.is_empty()
        || encoded.len() > 512
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return;
    }
    let Ok(decoded) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded) else {
        return;
    };
    if decoded.len() > 256 {
        return;
    }
    let Ok(Value::Object(value)) = serde_json::from_slice::<Value>(&decoded) else {
        return;
    };
    if value.len() != 3
        || value.get("v").and_then(Value::as_u64) != Some(1)
        || !value.contains_key("agent")
        || !value.contains_key("state")
    {
        return;
    }
    let agent = value.get("agent").and_then(Value::as_str);
    let state = value.get("state").and_then(Value::as_str);
    if !matches!(agent, Some("claude" | "codex")) || !matches!(state, Some("active" | "inactive")) {
        return;
    }
    if state == Some("active") {
        summary.agent = agent.map(str::to_owned);
        summary.agent_source = Some("osc".into());
    } else if summary.agent.as_deref() == agent {
        summary.agent = None;
        summary.agent_source = None;
        summary.agent_activity = None;
    }
}

fn load_or_create_token(data_root: &FsPath) -> String {
    let _ = std::fs::create_dir_all(data_root);
    let path = data_root.join(".terminal-web-token");
    if let Ok(value) = std::fs::read_to_string(&path) {
        let value = value.trim();
        if !value.is_empty() {
            return value.to_owned();
        }
    }
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let _ = std::fs::write(path, format!("{token}\n"));
    token
}

#[derive(Default)]
struct ProjectStore {
    projects: Vec<TerminalProject>,
    remembered: HashMap<String, RememberedProject>,
    order: Vec<String>,
}

fn load_projects(data_root: &FsPath, asset_root: &FsPath) -> ProjectStore {
    for path in [
        data_root.join(".terminal-web-projects.json"),
        asset_root.join(".terminal-web-projects.json"),
    ] {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let projects = value
            .get("projects")
            .and_then(Value::as_array)
            .or_else(|| value.as_array());
        let Some(projects) = projects else {
            continue;
        };
        let mut store = ProjectStore {
            projects: projects
                .iter()
                .filter_map(|project| {
                    serde_json::from_value::<TerminalProject>(project.clone()).ok()
                })
                .filter(|project| !project.cwd.trim().is_empty())
                .take(MAX_PROJECTS)
                .collect(),
            ..ProjectStore::default()
        };
        // `names` is ours; `recents` is the Node server's equivalent list.
        for field in ["names", "recents"] {
            for entry in value
                .get(field)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Ok(remembered) = serde_json::from_value::<RememberedProject>(entry.clone()) {
                    if !remembered.cwd.trim().is_empty() && !remembered.name.trim().is_empty() {
                        store
                            .remembered
                            .entry(projects::cwd_key(&remembered.cwd))
                            .or_insert(remembered);
                    }
                }
            }
        }
        store.order = value
            .get("order")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        return store;
    }
    ProjectStore::default()
}

async fn auth_middleware(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let loopback = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_none_or(|connect| connect.0.ip().is_loopback());
    if loopback || std::env::var("TERMINAL_WEB_AUTH").as_deref() == Ok("off") {
        return next.run(request).await;
    }
    let header = request
        .headers()
        .get("x-terminal-web-token")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        });
    let query = request.uri().query().and_then(|query| {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix("token="))
    });
    if header.or(query) == Some(state.token.as_str()) {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "message": "Terminal web access token is required." })),
        )
            .into_response()
    }
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "message": message.into() }))).into_response()
}

async fn bootstrap(State(state): State<AppState>) -> Json<Value> {
    Json(state.bootstrap())
}
async fn sessions(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.summaries()))
}
async fn acp(State(state): State<AppState>) -> Json<Value> {
    Json(state.inner.lock().acp.clone())
}
async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(
        json!({ "ok": true, "runtime": "rust", "sessions": state.summaries().len(), "endpoint": state.endpoint.read().clone() }),
    )
}

async fn session_text(
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Response {
    let Some(text) = state.plain_text(&id) else {
        return api_error(StatusCode::NOT_FOUND, "Unknown terminal session.");
    };
    let tail = query
        .get("tail")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 2000);
    let lines: Vec<_> = text.lines().collect();
    let start = lines.len().saturating_sub(tail);
    (
        StatusCode::OK,
        [("content-type", "text/plain; charset=utf-8")],
        lines[start..].join("\n"),
    )
        .into_response()
}

async fn input_context(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    state
        .input_context(&id)
        .map(Json)
        .map(IntoResponse::into_response)
        .unwrap_or_else(|| api_error(StatusCode::NOT_FOUND, "Unknown terminal session."))
}

async fn prompt_response(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Response {
    let Some(context) = state.input_context(&id) else {
        return api_error(StatusCode::NOT_FOUND, "Unknown terminal session.");
    };
    match prompt::prompt_response_bytes(&context, &body) {
        Ok(data) => match state.dispatch(&id, COMMAND_INPUT, &data, 0, 0) {
            Ok(()) => Json(
                json!({ "accepted": true, "promptId": body["promptId"], "action": body["action"] }),
            )
            .into_response(),
            Err(message) => api_error(StatusCode::INTERNAL_SERVER_ERROR, message),
        },
        Err(message) if message.contains("changed") => (
            StatusCode::CONFLICT,
            Json(json!({ "message": message, "stale": true })),
        )
            .into_response(),
        Err(message) => api_error(StatusCode::BAD_REQUEST, message),
    }
}

#[derive(Deserialize)]
struct ComposeBody {
    #[serde(default)]
    text: String,
    #[serde(default = "default_true")]
    submit: bool,
}
fn default_true() -> bool {
    true
}

async fn compose(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<ComposeBody>,
) -> Response {
    let Some(context) = state.input_context(&id) else {
        return api_error(StatusCode::NOT_FOUND, "Unknown terminal session.");
    };
    let bracketed = context
        .get("bracketedPaste")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut data = if !body.text.is_empty() && bracketed {
        format!("\u{1b}[200~{}\u{1b}[201~", body.text)
    } else {
        body.text.clone()
    };
    if body.submit {
        data.push('\r');
    }
    match state.dispatch(&id, COMMAND_INPUT, &data, 0, 0) {
        Ok(()) => Json(json!({ "method": if bracketed { "bracketed-paste" } else { "raw" }, "bytes": data.len(), "submitted": body.submit })).into_response(),
        Err(message) => api_error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

async fn write_session(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Response {
    let data = body.get("data").and_then(Value::as_str).unwrap_or_default();
    match state.dispatch(&id, COMMAND_INPUT, data, 0, 0) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(message) => api_error(StatusCode::NOT_FOUND, message),
    }
}

async fn resize_session(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Response {
    let cols = body.get("cols").and_then(Value::as_u64).unwrap_or(0) as u16;
    let rows = body.get("rows").and_then(Value::as_u64).unwrap_or(0) as u16;
    match state.dispatch(&id, COMMAND_RESIZE, "", rows, cols) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(message) => api_error(StatusCode::NOT_FOUND, message),
    }
}

async fn rename_session(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Response {
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    state
        .rename(&id, title)
        .map(Json)
        .map(IntoResponse::into_response)
        .unwrap_or_else(|| api_error(StatusCode::NOT_FOUND, "Unknown terminal session."))
}

async fn delete_session(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    match state.dispatch(&id, COMMAND_KILL, "", 0, 0) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(message) => api_error(StatusCode::NOT_FOUND, message),
    }
}

async fn export_session(
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Response {
    let Some(export) = state.export(&id) else {
        return api_error(StatusCode::NOT_FOUND, "Unknown terminal session.");
    };
    match query.get("format").map(String::as_str).unwrap_or("ansi") {
        "json" => Json(export).into_response(),
        "screen" => (
            [("content-type", "text/plain; charset=utf-8")],
            export["screen"].as_str().unwrap_or_default().to_owned(),
        )
            .into_response(),
        _ => (
            [("content-type", "application/octet-stream")],
            export["transcript"].as_str().unwrap_or_default().to_owned(),
        )
            .into_response(),
    }
}

async fn notifications(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Json<Value> {
    Json(json!(state.notifications(parse_since(
        query.get("since").map(String::as_str)
    ))))
}

async fn notify(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let session_id = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let session_title = session_id
        .as_deref()
        .and_then(|id| state.summary(id))
        .map(|session| session.title);
    state.notify(TerminalNotification {
        id: String::new(),
        at: String::new(),
        origin: "api".into(),
        session_id,
        session_title,
        title: body.get("title").and_then(Value::as_str).map(str::to_owned),
        body: body.get("body").and_then(Value::as_str).map(str::to_owned),
        sound: body.get("sound").and_then(Value::as_str).map(str::to_owned),
    });
    StatusCode::NO_CONTENT.into_response()
}

async fn projects(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.projects()))
}
async fn create_project(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if cwd.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "A project directory is required.");
    }
    let project = state.create_project(body.get("name").and_then(Value::as_str), cwd);
    (StatusCode::CREATED, Json(project)).into_response()
}
async fn rename_project(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Response {
    let name = body.get("name").and_then(Value::as_str).unwrap_or_default();
    if name.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "A project name is required.");
    }
    match state.rename_project(&id, name) {
        Some(project) => Json(project).into_response(),
        None => api_error(StatusCode::NOT_FOUND, "Unknown project."),
    }
}
async fn reorder_projects(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let ids: Vec<String> = body
        .get("ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    state.reorder_projects(ids);
    Json(json!(state.projects())).into_response()
}
async fn recent_projects(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.recent_projects()))
}
async fn delete_project(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    state.delete_project(&id);
    StatusCode::NO_CONTENT.into_response()
}

async fn create_session(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    match launch_terminal(&state, body).await {
        Ok(summary) => Json(summary).into_response(),
        Err(message) => api_error(StatusCode::BAD_REQUEST, message),
    }
}

async fn launch_terminal(state: &AppState, body: Value) -> Result<TerminalSessionSummary, String> {
    let before: std::collections::HashSet<_> = state
        .summaries()
        .into_iter()
        .map(|session| session.id)
        .collect();
    let profile_id = body.get("profileId").and_then(Value::as_str);
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let requested_title = body
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let requested_project = body
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let profile = profile_id.and_then(|id| {
        state
            .inner
            .lock()
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
    });
    let mut command = tokio::process::Command::new(resolve_terminal_launcher());
    command.args(["-w", "0", "new-tab"]);
    if let Some(guid) = profile
        .as_ref()
        .and_then(|profile| profile.terminal_profile_guid.as_deref())
    {
        command.args(["-p", guid]);
    }
    if let Some(cwd) = cwd {
        command.args(["-d", cwd]);
    }
    if profile
        .as_ref()
        .and_then(|profile| profile.terminal_profile_guid.as_ref())
        .is_none()
    {
        let shell = body
            .get("shell")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| profile.as_ref().map(|profile| profile.shell.clone()));
        let args = body
            .get("args")
            .and_then(Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .or_else(|| profile.as_ref().map(|profile| profile.args.clone()))
            .unwrap_or_default();
        if let Some(shell) = shell {
            command.arg("--").arg(shell).args(args);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|error| format!("Windows Terminal could not be launched: {error}"))?;
    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(mut session) = state
            .summaries()
            .into_iter()
            .find(|session| !before.contains(&session.id))
        {
            if let Some(title) = requested_title.clone() {
                session = state.rename(&session.id, title).unwrap_or(session);
            }
            if requested_project.is_some() {
                state.set_project(&session.id, requested_project.clone());
                session = state.summary(&session.id).unwrap_or(session);
            }
            return Ok(session);
        }
    }
    Err(
        "Windows Terminal launched, but its native bridge did not register within 8 seconds."
            .into(),
    )
}

fn resolve_terminal_launcher() -> PathBuf {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        for path in [
            local_app_data.join("Microsoft/WindowsApps/wtd.exe"),
            local_app_data.join("Programs/WindowsTerminalDevShim/wt.exe"),
        ] {
            if path.is_file() {
                return path;
            }
        }
    }
    PathBuf::from("wt.exe")
}

fn attachment_directory() -> PathBuf {
    std::env::temp_dir().join("terminal-web-attachments")
}

async fn clean_old_attachments() {
    let Ok(mut entries) = tokio::fs::read_dir(attachment_directory()).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        let old = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60));
        if metadata.is_file() && old {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

async fn attachment(
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if state.summary(&id).is_none() {
        return api_error(StatusCode::NOT_FOUND, "Unknown terminal session.");
    }
    if body.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "Attachment body is empty.");
    }
    if body.len() > 32 * 1024 * 1024 {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "Attachment exceeds 32 MB.");
    }
    let mime = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    if !mime.starts_with("image/") {
        return api_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Only image attachments are supported.",
        );
    }
    let extension = match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/heic" => "heic",
        _ => "png",
    };
    let directory = attachment_directory();
    if let Err(error) = tokio::fs::create_dir_all(&directory).await {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    let path = directory.join(format!(
        "img-{}-{}.{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S"),
        &Uuid::new_v4().to_string()[..8],
        extension
    ));
    if let Err(error) = tokio::fs::write(&path, body).await {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    let mut pasted = false;
    if query.get("paste").map(String::as_str) == Some("1") {
        let path_text = path.to_string_lossy();
        let text = if path_text.contains(' ') {
            format!("\"{path_text}\" ")
        } else {
            format!("{path_text} ")
        };
        pasted = state.dispatch(&id, COMMAND_INPUT, &text, 0, 0).is_ok();
    }
    (
        StatusCode::CREATED,
        Json(json!({ "path": path.to_string_lossy(), "pasted": pasted })),
    )
        .into_response()
}

async fn commands(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    let Some(context) = state.input_context(&id) else {
        return api_error(StatusCode::NOT_FOUND, "Unknown terminal session.");
    };
    Json(json!({ "agent": context["agent"], "agentLabel": context["agentLabel"], "cwd": context["cwd"], "commands": [] })).into_response()
}
async fn files(Path(id): Path<String>, State(state): State<AppState>) -> Response {
    let Some(summary) = state.summary(&id) else {
        return api_error(StatusCode::NOT_FOUND, "Unknown terminal session.");
    };
    Json(json!({ "cwd": summary.cwd, "files": [] })).into_response()
}
async fn orchestrator() -> Json<Value> {
    Json(json!({ "state": "stopped", "availableAgents": [] }))
}
async fn unavailable() -> Response {
    api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "This optional adapter is not part of the native terminal bridge runtime.",
    )
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| client_socket(socket, state))
}

async fn client_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    if sender
        .send(Message::Text(state.hello().to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    let mut events = state.events.subscribe();
    let mut subscriptions: HashMap<String, String> = HashMap::new();
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(Ok(Message::Text(text))) = incoming else { break };
                let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else { continue };
                match message {
                    ClientMessage::Subscribe { session_id, slot } => {
                        subscriptions.insert(slot.unwrap_or_else(|| "main".into()), session_id.clone());
                        if let Some(snapshot) = state.snapshot(&session_id) {
                            if sender.send(Message::Text(snapshot.to_string().into())).await.is_err() { break; }
                        }
                    }
                    ClientMessage::Unsubscribe { slot } => { subscriptions.remove(&slot.unwrap_or_else(|| "main".into())); }
                    ClientMessage::Input { session_id, data } => { let _ = state.dispatch(&session_id, COMMAND_INPUT, &data, 0, 0); }
                    ClientMessage::Resize { session_id, cols, rows } => { let _ = state.dispatch(&session_id, COMMAND_RESIZE, "", rows, cols); }
                    ClientMessage::Rename { session_id, title } => { state.rename(&session_id, title); }
                    ClientMessage::Kill { session_id } => { let _ = state.dispatch(&session_id, COMMAND_KILL, "", 0, 0); }
                    ClientMessage::RefreshHost => {
                        state.inner.lock().profiles = profiles::read_profiles();
                        state.publish(ServerEvent::global(json!({ "type": "profiles", "profiles": state.inner.lock().profiles })));
                    }
                    ClientMessage::Create { title, profile_id, shell, args, cwd, project_id } => {
                        let state = state.clone();
                        tokio::spawn(async move { let _ = launch_terminal(&state, json!({ "title": title, "profileId": profile_id, "shell": shell, "args": args, "cwd": cwd, "projectId": project_id })).await; });
                    }
                }
            }
            event = events.recv() => {
                let Ok(event) = event else { continue };
                let watched = event.session_id.as_ref().is_none_or(|id| subscriptions.values().any(|value| value == id));
                let value = if event.output && !watched {
                    json!({ "type": "activity", "sessionId": event.session_id, "seq": event.value["seq"] })
                } else if !watched && event.session_id.is_some() && event.value["type"] == "snapshot" {
                    continue
                } else { event.value };
                if sender.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
        }
    }
}

async fn bridge_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| bridge_socket(socket, state))
}

async fn bridge_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (command_tx, mut command_rx) = mpsc::unbounded_channel::<Value>();
    let mut owned = Vec::new();
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(Ok(Message::Text(text))) = incoming else { break };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
                match kind {
                    "register" => {
                        if let Ok(summary) = serde_json::from_value::<TerminalSessionSummary>(value["session"].clone()) {
                            let id = summary.id.clone();
                            state.register_bridge(summary, value.get("replay").and_then(Value::as_str).map(str::to_owned), command_tx.clone());
                            owned.push(id);
                        }
                    }
                    "output" => if let (Some(id), Some(data)) = (value.get("sessionId").and_then(Value::as_str), value.get("data").and_then(Value::as_str)) { state.append_output(id, data.to_owned(), false); },
                    "resize" => if let Some(id) = value.get("sessionId").and_then(Value::as_str) { state.resize_from_native(id, value.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16, value.get("rows").and_then(Value::as_u64).unwrap_or(32) as u16); },
                    "title" => if let (Some(id), Some(title)) = (value.get("sessionId").and_then(Value::as_str), value.get("title").and_then(Value::as_str)) { state.rename(id, title.into()); },
                    "project" => if let Some(id) = value.get("sessionId").and_then(Value::as_str) { state.set_project(id, value.get("projectId").and_then(Value::as_str).map(str::to_owned)); },
                    "cwd" => if let (Some(id), Some(cwd)) = (value.get("sessionId").and_then(Value::as_str), value.get("cwd").and_then(Value::as_str)) { state.set_cwd(id, cwd.to_owned()); },
                    "exit" => if let Some(id) = value.get("sessionId").and_then(Value::as_str) { state.exit(id, value.get("exitCode").and_then(Value::as_u64).map(|value| value as u32), value.get("signal").and_then(Value::as_u64).map(|value| value as u32)); },
                    "unregister" => if let Some(id) = value.get("sessionId").and_then(Value::as_str) { state.unregister(id); },
                    _ => {}
                }
            }
            command = command_rx.recv() => {
                let Some(command) = command else { break };
                if sender.send(Message::Text(command.to_string().into())).await.is_err() { break; }
            }
        }
    }
    let disconnected = state.disconnect_bridge(&owned, &command_tx);
    if !disconnected.is_empty() {
        let cleanup_state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let mut changed = false;
            {
                let mut inner = cleanup_state.inner.lock();
                for id in disconnected {
                    if inner
                        .sessions
                        .get(&id)
                        .is_some_and(|session| session.summary.status == "exited")
                    {
                        inner.sessions.remove(&id);
                        changed = true;
                    }
                }
            }
            if changed {
                cleanup_state.publish_sessions();
            }
        });
    }
}

fn embedded_asset(path: &str) -> Option<&'static EmbeddedClientAsset> {
    EMBEDDED_CLIENT_ASSETS
        .iter()
        .find(|asset| asset.path == path)
}

async fn embedded_client(State(state): State<AppState>, uri: Uri) -> Response {
    if !state.config.web_interface_enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    let requested = uri.path().trim_start_matches('/');
    let exact = embedded_asset(requested);
    let asset = exact.or_else(|| embedded_asset("index.html"));
    let Some(asset) = asset else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cache_control = if exact.is_some() && asset.path != "index.html" {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, asset.content_type)
        .header(header::CACHE_CONTROL, cache_control)
        .header("x-content-type-options", "nosniff")
        .body(Body::from(Bytes::from_static(asset.bytes)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/ws", any(ws_upgrade))
        .route("/bridge", any(bridge_upgrade))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/health", get(health))
        .route("/api/acp", get(acp))
        .route("/api/acp/{*rest}", any(unavailable))
        .route("/api/sessions", get(sessions).post(create_session))
        .route(
            "/api/sessions/{id}",
            patch(rename_session).delete(delete_session),
        )
        .route("/api/sessions/{id}/text", get(session_text))
        .route("/api/sessions/{id}/input-context", get(input_context))
        .route("/api/sessions/{id}/prompt-response", post(prompt_response))
        .route("/api/sessions/{id}/compose", post(compose))
        .route("/api/sessions/{id}/write", post(write_session))
        .route("/api/sessions/{id}/resize", post(resize_session))
        .route("/api/sessions/{id}/export", get(export_session))
        .route("/api/sessions/{id}/attachments", post(attachment))
        .route("/api/sessions/{id}/commands", get(commands))
        .route("/api/sessions/{id}/files", get(files))
        .route("/api/sessions/{id}/agent", get(unavailable))
        .route("/api/sessions/{id}/agent/attach", any(unavailable))
        .route("/api/notifications", get(notifications))
        .route("/api/notify", post(notify))
        .route("/api/projects", get(projects).post(create_project))
        .route("/api/projects/recent", get(recent_projects))
        .route("/api/projects/order", patch(reorder_projects))
        .route(
            "/api/projects/{id}",
            patch(rename_project).delete(delete_project),
        )
        .route("/api/peers/{*rest}", any(unavailable))
        .route("/api/orchestrator", get(orchestrator))
        .route("/api/orchestrator/start", post(unavailable))
        .route("/api/orchestrator/stop", post(unavailable))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024));

    let client = Router::new()
        .fallback(embedded_client)
        .layer(CompressionLayer::new().gzip(true));
    Router::new()
        .merge(protected)
        .merge(client)
        .with_state(state)
}

#[cfg(windows)]
static OWNER_MUTEX: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

#[cfg(windows)]
fn try_claim_owner(data_root: &FsPath) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = format!("{}\0", owner_mutex_name(data_root))
        .encode_utf16()
        .collect();
    // SAFETY: the name is a stable NUL-terminated UTF-16 buffer and the
    // default security descriptor is requested with a null pointer.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        // SAFETY: GetLastError has no preconditions.
        return Err(format!(
            "Could not create the terminal bridge owner mutex (error {}).",
            unsafe { GetLastError() }
        ));
    }
    // SAFETY: GetLastError must be read immediately after CreateMutexW.
    let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if already_exists {
        // SAFETY: handle was returned by CreateMutexW and is not null.
        unsafe { CloseHandle(handle) };
        Ok(false)
    } else {
        let _ = OWNER_MUTEX.set(handle as HANDLE as usize);
        Ok(true)
    }
}

#[cfg(not(windows))]
fn try_claim_owner(_data_root: &FsPath) -> Result<bool, String> {
    Ok(true)
}

/// One owner per data root. The default root (`%LOCALAPPDATA%\TerminalWeb`)
/// keeps the historical name so older builds and this one agree on who hosts;
/// a custom `TERMINAL_WEB_DATA_ROOT` gets its own mutex, which is how a
/// side-by-side build runs a fully independent host next to the everyday one.
fn owner_mutex_name(data_root: &FsPath) -> String {
    const LEGACY: &str = "Local\\WindowsTerminalRustBridgeHost-v1";
    let normalized = data_root
        .to_string_lossy()
        .to_lowercase()
        .replace('/', "\\");
    let normalized = normalized.trim_end_matches('\\');
    if normalized.ends_with("\\terminalweb") {
        return LEGACY.to_string();
    }
    let digest = sha2::Sha256::digest(normalized.as_bytes());
    format!("{LEGACY}-{}", &format!("{digest:x}")[..16])
}

pub async fn run(state: AppState) -> Result<(), String> {
    loop {
        state.status.store(STATUS_CONNECTING, Ordering::Relaxed);
        if try_claim_owner(&state.data_root)? {
            loop {
                if let Err(error) = run_owner(state.clone()).await {
                    state.status.store(STATUS_FAILING, Ordering::Relaxed);
                    eprintln!("terminal bridge owner restarting: {error}");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        if let Err(error) = run_peer(&state).await {
            state.status.store(STATUS_CONNECTING, Ordering::Relaxed);
            eprintln!("terminal bridge peer reconnecting: {error}");
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

async fn run_owner(state: AppState) -> Result<(), String> {
    state.status.store(STATUS_CONNECTING, Ordering::Relaxed);
    let start = std::env::var("TERMINAL_WEB_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(state.config.port);
    let host = std::env::var("TERMINAL_WEB_HOST")
        .ok()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .or_else(|| state.config.bind_address.parse::<IpAddr>().ok())
        .ok_or_else(|| {
            format!(
                "Invalid terminal bridge bind address: {}",
                state.config.bind_address
            )
        })?;
    let automatic_port = std::env::var("TERMINAL_WEB_AUTO_PORT")
        .ok()
        .map(|value| !matches!(value.to_ascii_lowercase().as_str(), "off" | "0" | "false"))
        .unwrap_or(state.config.automatic_port);
    let mut listener = None;
    for port in candidate_ports(start, automatic_port) {
        match TcpListener::bind(SocketAddr::new(host, port)).await {
            Ok(bound) => {
                listener = Some((bound, port));
                break;
            }
            Err(_) => continue,
        }
    }
    let Some((listener, port)) = listener else {
        state.status.store(STATUS_FAILING, Ordering::Relaxed);
        return Err(if automatic_port {
            "No terminal bridge port was available.".into()
        } else {
            format!("Terminal bridge port {start} is unavailable.")
        });
    };
    {
        let mut inner = state.inner.lock();
        inner.host = host;
        inner.port = port;
        *state.endpoint.write() = format!("127.0.0.1:{port}");
    }
    let info = json!({ "pid": std::process::id(), "host": host.to_string(), "port": port, "startedAt": iso_now(), "runtime": "rust" });
    let _ = std::fs::create_dir_all(state.data_root.as_ref());
    let _ = std::fs::write(
        state.data_root.join(".terminal-web-server.json"),
        serde_json::to_vec_pretty(&info).unwrap_or_default(),
    );
    if !state
        .attachment_cleanup_started
        .swap(true, Ordering::Relaxed)
    {
        tokio::spawn(async {
            loop {
                clean_old_attachments().await;
                tokio::time::sleep(Duration::from_secs(60 * 60)).await;
            }
        });
    }
    state.status.store(STATUS_CONNECTED, Ordering::Relaxed);
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|error| error.to_string())
}

fn candidate_ports(start: u16, automatic: bool) -> std::ops::RangeInclusive<u16> {
    start..=if automatic {
        start.saturating_add(20)
    } else {
        start
    }
}

async fn run_peer(state: &AppState) -> Result<(), String> {
    let info_path = state.data_root.join(".terminal-web-server.json");
    let info: Value = serde_json::from_slice(
        &tokio::fs::read(&info_path)
            .await
            .map_err(|error| format!("waiting for owner info: {error}"))?,
    )
    .map_err(|error| format!("owner info is incomplete: {error}"))?;
    if info.get("runtime").and_then(Value::as_str) != Some("rust") {
        return Err("the recorded owner is not the Rust bridge".into());
    }
    let port = info
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| "the recorded owner port is invalid".to_string())?;
    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/bridge"))
        .await
        .map_err(|error| format!("owner connection failed: {error}"))?;
    let (mut sender, mut receiver) = socket.split();
    let mut outgoing = state.bridge_events.subscribe();
    let (registrations, initial_sequences) = state.bridge_snapshot();
    for registration in registrations {
        sender
            .send(BridgeMessage::Text(registration.to_string().into()))
            .await
            .map_err(|error| error.to_string())?;
    }

    {
        state.inner.lock().port = port;
        *state.endpoint.write() = format!("127.0.0.1:{port}");
    }
    state.status.store(STATUS_CONNECTED, Ordering::Relaxed);

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(incoming) = incoming else {
                    return Err("owner connection closed".into());
                };
                let incoming = incoming.map_err(|error| error.to_string())?;
                match incoming {
                    BridgeMessage::Text(text) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                        let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
                        let Some(session_id) = value.get("sessionId").and_then(Value::as_str) else { continue };
                        match kind {
                            "input" => state.dispatch(session_id, COMMAND_INPUT, value.get("data").and_then(Value::as_str).unwrap_or_default(), 0, 0)?,
                            "resize" => state.dispatch(
                                session_id,
                                COMMAND_RESIZE,
                                "",
                                value.get("rows").and_then(Value::as_u64).unwrap_or(32) as u16,
                                value.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16,
                            )?,
                            "kill" => state.dispatch(session_id, COMMAND_KILL, "", 0, 0)?,
                            _ => {}
                        }
                    }
                    BridgeMessage::Ping(payload) => sender.send(BridgeMessage::Pong(payload)).await.map_err(|error| error.to_string())?,
                    BridgeMessage::Close(_) => return Err("owner connection closed".into()),
                    _ => {}
                }
            }
            outgoing_event = outgoing.recv() => {
                let event = outgoing_event.map_err(|error| format!("local bridge queue lost events: {error}"))?;
                if event.get("type").and_then(Value::as_str) == Some("output") {
                    let id = event.get("sessionId").and_then(Value::as_str).unwrap_or_default();
                    let source_seq = event.get("sourceSeq").and_then(Value::as_u64).unwrap_or(u64::MAX);
                    if initial_sequences.get(id).is_some_and(|initial| source_seq <= *initial) {
                        continue;
                    }
                }
                sender.send(BridgeMessage::Text(event.to_string().into())).await.map_err(|error| error.to_string())?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::Arc;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct CallbackCommand {
        session_id: String,
        kind: u32,
        data: String,
        rows: u32,
        cols: u32,
    }

    unsafe extern "C" fn callback(
        _: *mut c_void,
        _: *const u16,
        _: usize,
        _: u32,
        _: *const u16,
        _: usize,
        _: u32,
        _: u32,
    ) {
    }

    unsafe extern "C" fn recording_callback(
        context: *mut c_void,
        session_id: *const u16,
        session_id_len: usize,
        kind: u32,
        data: *const u16,
        data_len: usize,
        rows: u32,
        cols: u32,
    ) {
        let commands = &*(context as *const Mutex<Vec<CallbackCommand>>);
        let session_id =
            String::from_utf16_lossy(std::slice::from_raw_parts(session_id, session_id_len));
        let data = if data.is_null() || data_len == 0 {
            String::new()
        } else {
            String::from_utf16_lossy(std::slice::from_raw_parts(data, data_len))
        };
        commands.lock().push(CallbackCommand {
            session_id,
            kind,
            data,
            rows,
            cols,
        });
    }

    fn state() -> AppState {
        let root = tempfile::tempdir().unwrap().keep();
        AppState::new(
            root.clone(),
            root,
            NativeCallback {
                context: 0,
                callback,
            },
            BridgeConfig::default(),
        )
    }

    #[test]
    fn production_web_client_is_embedded_and_bounded() {
        let index = embedded_asset("index.html").expect("embedded index.html");
        let index = std::str::from_utf8(index.bytes).expect("UTF-8 index.html");
        assert!(index.contains("<title>Terminal Web Host</title>"));
        assert!(EMBEDDED_CLIENT_ASSETS
            .iter()
            .any(|asset| asset.content_type.starts_with("text/javascript")));
        assert!(EMBEDDED_CLIENT_ASSETS
            .iter()
            .any(|asset| asset.content_type.starts_with("text/css")));
        let total_bytes: usize = EMBEDDED_CLIENT_ASSETS
            .iter()
            .map(|asset| asset.bytes.len())
            .sum();
        assert!(
            total_bytes < 1_000_000,
            "embedded client grew to {total_bytes} bytes"
        );
    }

    #[test]
    fn bridge_configuration_defaults_preserve_existing_listener_behavior() {
        let config = BridgeConfig::default();
        assert!(config.automatic_port);
        assert_eq!(config.port, 10001);
        assert_eq!(config.bind_address, "0.0.0.0");
        assert!(config.web_interface_enabled);
        assert_eq!(candidate_ports(config.port, true), 10001..=10021);
        assert_eq!(candidate_ports(45000, false), 45000..=45000);
    }

    #[tokio::test]
    async fn disabling_web_interface_keeps_bridge_routes_separate() {
        let config = BridgeConfig {
            web_interface_enabled: false,
            ..BridgeConfig::default()
        };
        let mut state = state();
        state.config = Arc::new(config);
        let response = embedded_client(State(state), Uri::from_static("/")).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn wildcard_host_advertises_every_ipv4_interface_with_authenticated_urls() {
        let interfaces = vec![
            ("Ethernet".into(), "192.168.86.20".parse().unwrap()),
            ("Tailscale".into(), "100.107.170.47".parse().unwrap()),
            ("Duplicate".into(), "192.168.86.20".parse().unwrap()),
        ];
        let urls = server_access_urls("0.0.0.0".parse().unwrap(), 10001, "safe_token", &interfaces);

        assert_eq!(urls.len(), 3);
        assert_eq!(urls[0]["scope"], "local");
        assert_eq!(urls[0]["tokenRequired"], false);
        assert_eq!(urls[0]["url"], "http://127.0.0.1:10001/");
        assert_eq!(urls[1]["label"], "Ethernet");
        assert_eq!(
            urls[1]["url"],
            "http://192.168.86.20:10001/?token=safe_token"
        );
        assert_eq!(urls[2]["label"], "Tailscale");
        assert_eq!(urls[2]["tokenRequired"], true);
    }

    #[test]
    fn explicit_host_advertises_only_the_bound_network_address() {
        let interfaces = vec![("Ethernet".into(), "192.168.86.20".parse().unwrap())];
        let urls = server_access_urls(
            "10.20.30.40".parse().unwrap(),
            10009,
            "safe_token",
            &interfaces,
        );

        assert_eq!(urls.len(), 2);
        assert_eq!(urls[1]["label"], "Bound host");
        assert_eq!(urls[1]["address"], "10.20.30.40");
        assert_eq!(urls[1]["url"], "http://10.20.30.40:10009/?token=safe_token");
    }

    #[test]
    fn native_output_round_trips_through_snapshot_and_export() {
        let state = state();
        let summary = TerminalSessionSummary::native(
            "session".into(),
            "PowerShell".into(),
            "pwsh".into(),
            "C:\\work".into(),
            1,
            80,
            24,
        );
        state.register_native(summary);
        state.append_output("session", "\u{1b}[31mred\u{1b}[0m\r\n".into(), false);
        let snapshot = state.snapshot("session").unwrap();
        assert_eq!(snapshot["type"], "snapshot");
        assert!(snapshot["screen"].as_str().unwrap().contains("red"));
        assert!(state.export("session").unwrap()["transcript"]
            .as_str()
            .unwrap()
            .contains("\u{1b}[31m"));
    }

    #[test]
    fn private_agent_osc_becomes_metadata_and_not_visible_output() {
        let state = state();
        state.register_native(TerminalSessionSummary::native(
            "session".into(),
            "Shell".into(),
            "pwsh".into(),
            "C:\\work".into(),
            1,
            80,
            24,
        ));
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"v":1,"agent":"claude","state":"active"}"#);
        state.append_output(
            "session",
            format!("\u{1b}]1337;TerminalWeb.Agent={payload}\u{1b}\\hello"),
            false,
        );
        assert_eq!(
            state.summary("session").unwrap().agent.as_deref(),
            Some("claude")
        );
        assert_eq!(state.plain_text("session").unwrap().trim(), "hello");
    }

    #[test]
    fn private_agent_osc_is_removed_at_every_chunk_boundary() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"v":1,"agent":"codex","state":"active"}"#);
        let marker = format!("before\u{1b}]1337;TerminalWeb.Agent={payload}\u{1b}\\after");
        let boundaries: Vec<usize> = marker
            .char_indices()
            .map(|(index, _)| index)
            .chain(std::iter::once(marker.len()))
            .collect();

        for split in boundaries {
            let mut summary = TerminalSessionSummary::native(
                "session".into(),
                "Shell".into(),
                "pwsh".into(),
                "C:\\work".into(),
                1,
                80,
                24,
            );
            let mut filter = OutputFilter::default();
            let mut visible = filter.feed(&marker[..split], &mut summary);
            visible.push_str(&filter.feed(&marker[split..], &mut summary));
            assert_eq!(visible, "beforeafter", "split at byte {split}");
            assert_eq!(summary.agent.as_deref(), Some("codex"));
        }
    }

    #[test]
    fn ordinary_osc_is_preserved_and_oversized_osc_is_dropped() {
        let mut summary = TerminalSessionSummary::native(
            "session".into(),
            "Shell".into(),
            "pwsh".into(),
            "C:\\work".into(),
            1,
            80,
            24,
        );
        let mut filter = OutputFilter::default();
        let title = "\u{1b}]0;useful title\u{7}";
        assert_eq!(filter.feed(title, &mut summary), title);

        let malformed = format!(
            "\u{1b}]1337;TerminalWeb.Agent={}\u{1b}\\safe",
            "x".repeat(MAX_FILTERED_OSC_BYTES + 1)
        );
        assert_eq!(filter.feed(&malformed, &mut summary), "safe");
    }

    #[test]
    fn stale_peer_disconnect_cannot_exit_a_reconnected_session() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(
            root.path().to_path_buf(),
            root.path().to_path_buf(),
            NativeCallback {
                context: 0,
                callback,
            },
            BridgeConfig::default(),
        );
        let summary = TerminalSessionSummary::native(
            "session".into(),
            "Shell".into(),
            "pwsh".into(),
            "C:\\work".into(),
            1,
            80,
            24,
        );
        let (old_sender, _) = mpsc::unbounded_channel();
        let (new_sender, _) = mpsc::unbounded_channel();
        state.register_bridge(summary.clone(), None, old_sender.clone());
        state.register_bridge(summary, None, new_sender.clone());

        assert!(state
            .disconnect_bridge(&["session".into()], &old_sender)
            .is_empty());
        assert_eq!(state.summary("session").unwrap().status, "running");
        assert_eq!(
            state.disconnect_bridge(&["session".into()], &new_sender),
            ["session"]
        );
        assert_eq!(state.summary("session").unwrap().status, "exited");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_http_and_websocket_protocol_needs_no_relay_process() {
        let root = tempfile::tempdir().unwrap();

        let commands = Arc::new(Mutex::new(Vec::<CallbackCommand>::new()));
        let state = AppState::new(
            root.path().to_path_buf(),
            root.path().to_path_buf(),
            NativeCallback {
                context: Arc::as_ptr(&commands) as usize,
                callback: recording_callback,
            },
            BridgeConfig::default(),
        );
        state.register_native(TerminalSessionSummary::native(
            "native-session".into(),
            "PowerShell".into(),
            "pwsh".into(),
            "C:\\work".into(),
            42,
            100,
            30,
        ));
        state.append_output("native-session", "ready\r\n".into(), false);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        state.inner.lock().port = address.port();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router(server_state).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        let base = format!("http://{address}");
        let client = reqwest::Client::new();
        let bootstrap: Value = client
            .get(format!("{base}/api/bootstrap"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(bootstrap["sessions"][0]["id"], "native-session");
        assert_eq!(bootstrap["server"]["port"], address.port());
        let page = client
            .get(&base)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(page.contains("<title>Terminal Web Host</title>"));
        let script_path = page
            .split("src=\"")
            .nth(1)
            .and_then(|value| value.split('"').next())
            .expect("embedded client script path");
        let script = client
            .get(format!("{base}{script_path}"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert!(script
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/javascript"));
        assert!(script.bytes().await.unwrap().len() > 100_000);

        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let hello: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["type"], "hello");
        socket
            .send(TungsteniteMessage::Text(
                json!({ "type": "subscribe", "sessionId": "native-session" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let snapshot: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(snapshot["type"], "snapshot");
        assert!(snapshot["screen"].as_str().unwrap().contains("ready"));
        socket
            .send(TungsteniteMessage::Text(
                json!({ "type": "input", "sessionId": "native-session", "data": "whoami\r" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !commands.lock().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            commands.lock().first().cloned(),
            Some(CallbackCommand {
                session_id: "native-session".into(),
                kind: COMMAND_INPUT,
                data: "whoami\r".into(),
                rows: 0,
                cols: 0,
            })
        );

        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn secondary_terminal_process_joins_the_rust_owner() {
        let root = tempfile::tempdir().unwrap();

        let owner_commands = Arc::new(Mutex::new(Vec::<CallbackCommand>::new()));
        let owner = AppState::new(
            root.path().to_path_buf(),
            root.path().to_path_buf(),
            NativeCallback {
                context: Arc::as_ptr(&owner_commands) as usize,
                callback: recording_callback,
            },
            BridgeConfig::default(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        owner.inner.lock().port = address.port();
        std::fs::write(
            root.path().join(".terminal-web-server.json"),
            json!({ "runtime": "rust", "port": address.port() }).to_string(),
        )
        .unwrap();
        let owner_server = owner.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router(owner_server).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        let peer_commands = Arc::new(Mutex::new(Vec::<CallbackCommand>::new()));
        let peer = AppState::new(
            root.path().to_path_buf(),
            root.path().to_path_buf(),
            NativeCallback {
                context: Arc::as_ptr(&peer_commands) as usize,
                callback: recording_callback,
            },
            BridgeConfig::default(),
        );
        peer.register_native(TerminalSessionSummary::native(
            "peer-session".into(),
            "Peer".into(),
            "pwsh".into(),
            "C:\\peer".into(),
            7,
            100,
            30,
        ));
        peer.append_output("peer-session", "from peer\r\n".into(), false);
        let peer_runner = peer.clone();
        let peer_task = tokio::spawn(async move { run_peer(&peer_runner).await });

        for _ in 0..50 {
            if owner.summary("peer-session").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            owner.plain_text("peer-session").unwrap().trim(),
            "from peer"
        );
        owner
            .dispatch("peer-session", COMMAND_INPUT, "echo joined\r", 0, 0)
            .unwrap();
        for _ in 0..50 {
            if !peer_commands.lock().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            peer_commands.lock().as_slice(),
            &[CallbackCommand {
                session_id: "peer-session".into(),
                kind: COMMAND_INPUT,
                data: "echo joined\r".into(),
                rows: 0,
                cols: 0,
            }]
        );

        peer_task.abort();
        server.abort();
    }
}
