//! The Orchestrator: a chat agent built into the terminal host that watches
//! every tab and drives them through tools. It talks to any OpenAI-compatible
//! chat endpoint (OpenRouter by default, key from `OPENROUTER_API_KEY` unless
//! one is entered by hand) and keeps one shared transcript that the web,
//! native and mobile panels all render.

pub mod catalog;
mod context;
mod llm;
mod tools;

use crate::host::AppState;
use crate::model::{iso_now, ServerEvent};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio::task::AbortHandle;

pub const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-5";
pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const OPENROUTER_KEY_ENV: &str = "OPENROUTER_API_KEY";
pub const CUSTOM_KEY_ENV: &str = "OPENAI_API_KEY";

const CONFIG_FILE: &str = ".terminal-web-orchestrator.json";
const HISTORY_FILE: &str = ".terminal-web-orchestrator-history.json";
/// Transcript items kept in memory and on disk.
const MAX_ITEMS: usize = 400;
/// Tool rounds allowed in one turn before the model is asked to wrap up.
const MAX_STEPS: usize = 24;
/// Longest a single streamed tool result may be.
const MAX_TOOL_RESULT: usize = 24_000;
/// Model catalog freshness.
const CATALOG_TTL: Duration = Duration::from_secs(15 * 60);
/// Minimum gap between streamed transcript broadcasts for one item.
const STREAM_PUBLISH_INTERVAL: Duration = Duration::from_millis(80);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OrchestratorConfig {
    /// `openrouter` or `custom`.
    pub provider: String,
    pub base_url: String,
    pub model: String,
    /// Manual override; `None` means "use the environment variable".
    pub api_key: Option<String>,
    pub key_env: String,
    /// `off`, `low`, `medium` or `high` (OpenRouter reasoning effort).
    pub reasoning: String,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            provider: "openrouter".into(),
            base_url: OPENROUTER_BASE_URL.into(),
            model: DEFAULT_MODEL.into(),
            api_key: None,
            key_env: OPENROUTER_KEY_ENV.into(),
            reasoning: "low".into(),
        }
    }
}

impl OrchestratorConfig {
    pub fn is_openrouter(&self) -> bool {
        self.provider == "openrouter"
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON text exactly as the model produced it.
    pub arguments: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRecord {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
    pub summary: String,
    pub result: String,
    pub ok: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub id: String,
    /// Bumped on every change to this item.
    pub rev: u64,
    /// Global sequence at the item's last change; clients poll with `since`.
    pub seq: u64,
    pub turn_id: String,
    /// `user`, `assistant`, `tool` or `error`.
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolRecord>,
    /// `streaming`, `done`, `cancelled` or `error`.
    pub status: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost: f64,
    pub turns: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct History {
    items: Vec<TranscriptItem>,
    usage: Usage,
}

struct ActiveTurn {
    id: String,
    started_at: String,
    step: String,
    abort: AbortHandle,
}

struct CachedCatalog {
    key: String,
    fetched: Instant,
    catalog: catalog::Catalog,
}

struct State {
    config: OrchestratorConfig,
    items: Vec<TranscriptItem>,
    usage: Usage,
    seq: u64,
    turn: Option<ActiveTurn>,
    error: Option<String>,
    catalog: Option<CachedCatalog>,
}

pub struct Orchestrator {
    state: Mutex<State>,
    data_root: PathBuf,
    http: reqwest::Client,
    events: broadcast::Sender<ServerEvent>,
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    let Ok(bytes) = serde_json::to_vec_pretty(value) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("json.tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        let _ = std::fs::rename(&temporary, path);
    }
}

#[cfg(windows)]
fn registry_environment_value(name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };
    let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let roots: [(_, &str); 2] = [
        (HKEY_CURRENT_USER, "Environment"),
        (
            HKEY_LOCAL_MACHINE,
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        ),
    ];
    for (root, subkey) in roots {
        let wide_subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buffer = vec![0u16; 4096];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: every pointer refers to a live, NUL-terminated buffer and
        // `size` is the byte capacity of `buffer`.
        let status = unsafe {
            RegGetValueW(
                root,
                wide_subkey.as_ptr(),
                wide_name.as_ptr(),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut _,
                &mut size,
            )
        };
        if status == 0 {
            let length = (size as usize / 2).saturating_sub(1).min(buffer.len());
            let value = String::from_utf16_lossy(&buffer[..length]);
            let value = value.trim_end_matches('\0').trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn registry_environment_value(_name: &str) -> Option<String> {
    None
}

/// The process environment first, then the user/system variables in the
/// registry so a key set after the terminal started is still found.
pub(crate) fn environment_value(name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return None;
    }
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| registry_environment_value(name))
}

fn key_preview(key: &str) -> String {
    let characters: Vec<char> = key.chars().collect();
    if characters.len() <= 12 {
        return "•".repeat(characters.len());
    }
    let head: String = characters[..8].iter().collect();
    let tail: String = characters[characters.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn resolve_key(config: &OrchestratorConfig) -> (Option<String>, &'static str) {
    if let Some(key) = config.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        return (Some(key.to_string()), "manual");
    }
    match environment_value(&config.key_env) {
        Some(key) => (Some(key), "env"),
        None => (None, "none"),
    }
}

fn public_config(config: &OrchestratorConfig) -> Value {
    let (key, source) = resolve_key(config);
    json!({
        "provider": config.provider,
        "baseUrl": config.base_url,
        "model": config.model,
        "keyEnv": config.key_env,
        "keySource": source,
        "keyPreview": key.as_deref().map(key_preview),
        "reasoning": config.reasoning,
        "defaults": {
            "model": DEFAULT_MODEL,
            "openrouterBaseUrl": OPENROUTER_BASE_URL,
            "openrouterKeyEnv": OPENROUTER_KEY_ENV,
            "customKeyEnv": CUSTOM_KEY_ENV
        }
    })
}

impl Orchestrator {
    pub fn new(data_root: &Path, events: broadcast::Sender<ServerEvent>) -> Self {
        let config: OrchestratorConfig = read_json(&data_root.join(CONFIG_FILE));
        let history: History = read_json(&data_root.join(HISTORY_FILE));
        let mut items = history.items;
        // A turn that was streaming when the host went away never finished.
        for item in &mut items {
            if item.status == "streaming" {
                item.status = "cancelled".into();
            }
        }
        let seq = items.iter().map(|item| item.seq).max().unwrap_or(0);
        Self {
            state: Mutex::new(State {
                config,
                items,
                usage: history.usage,
                seq,
                turn: None,
                error: None,
                catalog: None,
            }),
            data_root: data_root.to_path_buf(),
            http: reqwest::Client::builder()
                .user_agent("WindowsTerminal-Orchestrator/1.0")
                .build()
                .unwrap_or_default(),
            events,
        }
    }

    fn publish(&self, value: Value) {
        let _ = self.events.send(ServerEvent::global(value));
    }

    fn persist_config(&self, config: &OrchestratorConfig) {
        write_json(&self.data_root.join(CONFIG_FILE), config);
    }

    fn persist_history_locked(&self, state: &State) {
        write_json(
            &self.data_root.join(HISTORY_FILE),
            &History {
                items: state.items.clone(),
                usage: state.usage.clone(),
            },
        );
    }

    pub(crate) fn config(&self) -> OrchestratorConfig {
        self.state.lock().config.clone()
    }

    pub fn public_config(&self) -> Value {
        public_config(&self.state.lock().config)
    }

    fn status_locked(state: &State, since: Option<u64>, include_transcript: bool) -> Value {
        let (key, _) = resolve_key(&state.config);
        let running = state.turn.is_some();
        let mut status = json!({
            "state": if running { "running" } else if key.is_none() { "unconfigured" } else { "idle" },
            "seq": state.seq,
            "config": public_config(&state.config),
            "error": state.error,
            "usage": state.usage,
            "itemCount": state.items.len(),
            "activeTurn": state.turn.as_ref().map(|turn| json!({
                "id": turn.id,
                "startedAt": turn.started_at,
                "step": turn.step
            }))
        });
        if include_transcript {
            let items: Vec<&TranscriptItem> = match since {
                Some(since) => state.items.iter().filter(|item| item.seq > since).collect(),
                None => state.items.iter().collect(),
            };
            status["transcript"] = json!(items);
            status["partial"] = json!(since.is_some());
        }
        status
    }

    pub fn status(&self, since: Option<u64>, include_transcript: bool) -> Value {
        Self::status_locked(&self.state.lock(), since, include_transcript)
    }

    fn publish_status(&self) {
        let status = self.status(None, false);
        self.publish(json!({ "type": "orchestrator", "orchestrator": status }));
    }

    pub fn update_config(&self, patch: &Value) -> Result<Value, String> {
        let text = |key: &str| {
            patch
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_owned)
        };
        let config = {
            let mut state = self.state.lock();
            let mut config = state.config.clone();
            if let Some(provider) = text("provider") {
                match provider.as_str() {
                    "openrouter" => {
                        if !config.is_openrouter() {
                            config.base_url = OPENROUTER_BASE_URL.into();
                            config.key_env = OPENROUTER_KEY_ENV.into();
                        }
                        config.provider = provider;
                    }
                    "custom" => {
                        if config.is_openrouter() && config.key_env == OPENROUTER_KEY_ENV {
                            config.key_env = CUSTOM_KEY_ENV.into();
                        }
                        config.provider = provider;
                    }
                    other => return Err(format!("Unknown provider \"{other}\".")),
                }
            }
            if let Some(base_url) = text("baseUrl") {
                if base_url.is_empty() {
                    config.base_url = if config.is_openrouter() { OPENROUTER_BASE_URL.into() } else { base_url };
                } else if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
                    return Err("The base URL must start with http:// or https://.".into());
                } else {
                    config.base_url = base_url.trim_end_matches('/').to_string();
                }
            }
            if let Some(model) = text("model") {
                if model.is_empty() {
                    return Err("A model id is required.".into());
                }
                config.model = model;
            }
            if let Some(key_env) = text("keyEnv") {
                config.key_env = if key_env.is_empty() {
                    if config.is_openrouter() { OPENROUTER_KEY_ENV.into() } else { CUSTOM_KEY_ENV.into() }
                } else {
                    key_env
                };
            }
            if let Some(api_key) = patch.get("apiKey") {
                config.api_key = match api_key {
                    Value::Null => None,
                    Value::String(key) if key.trim().is_empty() => None,
                    Value::String(key) => Some(key.trim().to_string()),
                    _ => return Err("apiKey must be a string.".into()),
                };
            }
            if let Some(reasoning) = text("reasoning") {
                if !matches!(reasoning.as_str(), "off" | "low" | "medium" | "high") {
                    return Err("reasoning must be off, low, medium or high.".into());
                }
                config.reasoning = reasoning;
            }
            if config.base_url.is_empty() {
                return Err("A base URL is required.".into());
            }
            if state.config != config {
                state.config = config.clone();
                state.error = None;
                state.seq += 1;
            }
            config
        };
        self.persist_config(&config);
        self.publish_status();
        Ok(public_config(&config))
    }

    /// Ends the running turn, if any. Items still streaming are marked
    /// cancelled so the transcript never shows a spinner forever.
    pub fn cancel(&self) -> bool {
        let (cancelled, changed) = {
            let mut state = self.state.lock();
            let Some(turn) = state.turn.take() else {
                return false;
            };
            turn.abort.abort();
            state.seq += 1;
            let seq = state.seq;
            let now = iso_now();
            let mut changed = Vec::new();
            for item in state.items.iter_mut().filter(|item| item.status == "streaming") {
                item.status = "cancelled".into();
                item.finished_at = Some(now.clone());
                item.rev += 1;
                item.seq = seq;
                changed.push(item.clone());
            }
            self.persist_history_locked(&state);
            (true, changed)
        };
        for item in changed {
            self.publish_item(&item);
        }
        self.publish_status();
        cancelled
    }

    pub fn clear(&self) {
        self.cancel();
        {
            let mut state = self.state.lock();
            state.items.clear();
            state.error = None;
            state.seq += 1;
            self.persist_history_locked(&state);
        }
        let seq = self.state.lock().seq;
        self.publish(json!({ "type": "orchestrator_reset", "seq": seq }));
        self.publish_status();
    }

    fn publish_item(&self, item: &TranscriptItem) {
        self.publish(json!({ "type": "orchestrator_item", "item": item, "seq": item.seq }));
    }

    fn push_item(&self, mut item: TranscriptItem) -> TranscriptItem {
        {
            let mut state = self.state.lock();
            state.seq += 1;
            item.seq = state.seq;
            state.items.push(item.clone());
            if state.items.len() > MAX_ITEMS {
                let excess = state.items.len() - MAX_ITEMS;
                state.items.drain(..excess);
            }
        }
        self.publish_item(&item);
        item
    }

    /// Applies `update` to one item, bumps its revision and broadcasts it.
    fn update_item(&self, id: &str, persist: bool, update: impl FnOnce(&mut TranscriptItem)) {
        let item = {
            let mut state = self.state.lock();
            state.seq += 1;
            let seq = state.seq;
            let Some(item) = state.items.iter_mut().find(|item| item.id == id) else {
                return;
            };
            update(item);
            item.rev += 1;
            item.seq = seq;
            let snapshot = item.clone();
            if persist {
                self.persist_history_locked(&state);
            }
            snapshot
        };
        self.publish_item(&item);
    }

    fn set_step(&self, step: &str) {
        let mut state = self.state.lock();
        if let Some(turn) = state.turn.as_mut() {
            turn.step = step.to_string();
        }
    }

    fn finish_turn(&self, turn_id: &str, error: Option<String>, usage: Usage) {
        {
            let mut state = self.state.lock();
            if state.turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
                state.turn = None;
            }
            state.error = error;
            state.usage.prompt_tokens += usage.prompt_tokens;
            state.usage.completion_tokens += usage.completion_tokens;
            state.usage.cost += usage.cost;
            state.usage.turns += 1;
            state.seq += 1;
            self.persist_history_locked(&state);
        }
        self.publish_status();
    }

    fn new_item(turn_id: &str, role: &str, status: &str) -> TranscriptItem {
        TranscriptItem {
            id: uuid::Uuid::new_v4().simple().to_string(),
            rev: 1,
            seq: 0,
            turn_id: turn_id.to_string(),
            role: role.to_string(),
            text: String::new(),
            reasoning: None,
            tool_calls: Vec::new(),
            tool: None,
            status: status.to_string(),
            at: iso_now(),
            finished_at: None,
            model: None,
        }
    }

    fn reasoning_parameter(&self, config: &OrchestratorConfig) -> Option<Value> {
        if !config.is_openrouter() {
            return None;
        }
        // Only ask for reasoning when the catalog says the model supports it;
        // an unknown model is left to OpenRouter's defaults.
        let supports = {
            let state = self.state.lock();
            state
                .catalog
                .as_ref()
                .and_then(|cached| cached.catalog.models.iter().find(|model| model.id == config.model))
                .map(|model| model.reasoning)
        };
        match (supports, config.reasoning.as_str()) {
            (Some(true), "off") => Some(json!({ "enabled": false })),
            (Some(true), effort) => Some(json!({ "effort": effort })),
            _ => None,
        }
    }

    pub async fn models(&self, refresh: bool) -> Value {
        let config = self.config();
        let cache_key = format!("{}|{}", config.provider, config.base_url);
        if !refresh {
            let state = self.state.lock();
            if let Some(cached) = state.catalog.as_ref() {
                if cached.key == cache_key && cached.fetched.elapsed() < CATALOG_TTL {
                    return catalog::to_value(Some(&cached.catalog), &config.model, None);
                }
            }
        }
        let (key, _) = resolve_key(&config);
        match catalog::fetch(&self.http, &config.base_url, key.as_deref(), config.is_openrouter()).await {
            Ok(fetched) => {
                let value = catalog::to_value(Some(&fetched), &config.model, None);
                self.state.lock().catalog = Some(CachedCatalog {
                    key: cache_key,
                    fetched: Instant::now(),
                    catalog: fetched,
                });
                value
            }
            Err(error) => {
                let state = self.state.lock();
                let stale = state
                    .catalog
                    .as_ref()
                    .filter(|cached| cached.key == cache_key)
                    .map(|cached| &cached.catalog);
                catalog::to_value(stale, &config.model, Some(&error))
            }
        }
    }

    /// Warms the catalog so the first turn knows whether the model reasons.
    async fn ensure_catalog(&self) {
        let needs_fetch = {
            let state = self.state.lock();
            let key = format!("{}|{}", state.config.provider, state.config.base_url);
            !state
                .catalog
                .as_ref()
                .is_some_and(|cached| cached.key == key && cached.fetched.elapsed() < CATALOG_TTL)
        };
        if needs_fetch {
            let _ = self.models(true).await;
        }
    }

    pub async fn test_connection(&self) -> Value {
        let config = self.config();
        let (key, source) = resolve_key(&config);
        let Some(key) = key else {
            return json!({
                "ok": false,
                "message": format!("No API key: set {} or enter one in the panel.", config.key_env)
            });
        };
        if config.is_openrouter() {
            match llm::get_json(&self.http, &config.base_url, "key", Some(&key), true).await {
                Ok(value) => {
                    let data = value.get("data").cloned().unwrap_or(Value::Null);
                    let label = data.get("label").and_then(Value::as_str).unwrap_or("OpenRouter key");
                    let usage = data.get("usage").and_then(Value::as_f64).unwrap_or(0.0);
                    let limit = data.get("limit").and_then(Value::as_f64);
                    let message = match limit {
                        Some(limit) => format!("{label}: ${usage:.2} used of ${limit:.2} ({source} key)"),
                        None => format!("{label}: ${usage:.2} used, no limit ({source} key)"),
                    };
                    json!({ "ok": true, "message": message, "key": data })
                }
                Err(error) => json!({ "ok": false, "message": error }),
            }
        } else {
            match llm::get_json(&self.http, &config.base_url, "models", Some(&key), false).await {
                Ok(value) => {
                    let count = value
                        .get("data")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0);
                    json!({ "ok": true, "message": format!("Endpoint reachable; it lists {count} models ({source} key).") })
                }
                Err(error) => json!({ "ok": false, "message": error }),
            }
        }
    }
}

/// Appends the user's message and runs one turn in the background. Returns
/// the status the caller should show, or an HTTP status + message.
pub async fn send_message(app: &AppState, text: String) -> Result<Value, (u16, String)> {
    let orchestrator = app.orchestrator.clone();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err((400, "Say something first.".into()));
    }
    let config = orchestrator.config();
    let (key, _) = resolve_key(&config);
    let Some(api_key) = key else {
        return Err((
            409,
            format!(
                "No API key is configured. Set {} in your environment or enter a key in the orchestrator settings.",
                config.key_env
            ),
        ));
    };
    if orchestrator.state.lock().turn.is_some() {
        return Err((409, "The orchestrator is still working on the previous message; stop it or wait.".into()));
    }

    let turn_id = uuid::Uuid::new_v4().simple().to_string();
    let mut user = Orchestrator::new_item(&turn_id, "user", "done");
    user.text = text;
    orchestrator.push_item(user);

    let app_for_turn = app.clone();
    let turn_for_task = turn_id.clone();
    let handle = tokio::spawn(async move {
        run_turn(app_for_turn, turn_for_task, config, api_key).await;
    });
    {
        let mut state = orchestrator.state.lock();
        state.turn = Some(ActiveTurn {
            id: turn_id,
            started_at: iso_now(),
            step: "thinking".into(),
            abort: handle.abort_handle(),
        });
        state.error = None;
        state.seq += 1;
        orchestrator.persist_history_locked(&state);
    }
    orchestrator.publish_status();
    Ok(orchestrator.status(None, false))
}

fn usage_delta(usage: &Option<Value>) -> Usage {
    let Some(usage) = usage else {
        return Usage::default();
    };
    Usage {
        prompt_tokens: usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        completion_tokens: usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        cost: usage.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
        turns: 0,
    }
}

async fn run_turn(app: AppState, turn_id: String, config: OrchestratorConfig, api_key: String) {
    let orchestrator = app.orchestrator.clone();
    orchestrator.ensure_catalog().await;
    let reasoning = orchestrator.reasoning_parameter(&config);
    let tools = tools::definitions();
    let mut turn_usage = Usage::default();

    let mut messages: Vec<Value> = Vec::new();
    messages.push(json!({ "role": "system", "content": context::system_prompt(&app, &config) }));
    let history = context::history_messages(&orchestrator.state.lock().items);
    messages.extend(history);

    let mut error: Option<String> = None;
    for step in 0..MAX_STEPS {
        orchestrator.set_step("thinking");
        let assistant = orchestrator.push_item(Orchestrator::new_item(&turn_id, "assistant", "streaming"));
        let assistant_id = assistant.id.clone();
        let mut last_publish = Instant::now();
        let request = llm::ChatRequest {
            base_url: &config.base_url,
            api_key: &api_key,
            model: &config.model,
            openrouter: config.is_openrouter(),
            reasoning: reasoning.clone(),
            messages: &messages,
            tools: &tools,
        };
        let completion = llm::stream_chat(&orchestrator.http, request, |text, reasoning_text| {
            if last_publish.elapsed() < STREAM_PUBLISH_INTERVAL {
                return;
            }
            last_publish = Instant::now();
            let text = text.to_string();
            let reasoning_text = (!reasoning_text.is_empty()).then(|| reasoning_text.to_string());
            orchestrator.update_item(&assistant_id, false, |item| {
                item.text = text;
                item.reasoning = reasoning_text;
            });
        })
        .await;

        let completion = match completion {
            Ok(completion) => completion,
            Err(message) => {
                orchestrator.update_item(&assistant_id, false, |item| {
                    item.status = if item.text.is_empty() { "error".into() } else { "done".into() };
                    item.finished_at = Some(iso_now());
                });
                let mut failure = Orchestrator::new_item(&turn_id, "error", "error");
                failure.text = message.clone();
                failure.finished_at = Some(iso_now());
                orchestrator.push_item(failure);
                error = Some(message);
                break;
            }
        };

        let delta = usage_delta(&completion.usage);
        turn_usage.prompt_tokens += delta.prompt_tokens;
        turn_usage.completion_tokens += delta.completion_tokens;
        turn_usage.cost += delta.cost;

        let tool_calls: Vec<ToolCall> = completion
            .tool_calls
            .iter()
            .map(|call| ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: if call.arguments.trim().is_empty() { "{}".into() } else { call.arguments.clone() },
            })
            .collect();
        let final_text = completion.text.clone();
        let final_reasoning = (!completion.reasoning.is_empty()).then(|| completion.reasoning.clone());
        let model = completion.model.clone();
        let calls_for_item = tool_calls.clone();
        orchestrator.update_item(&assistant_id, true, |item| {
            item.text = final_text;
            item.reasoning = final_reasoning;
            item.tool_calls = calls_for_item;
            item.model = model;
            item.status = "done".into();
            item.finished_at = Some(iso_now());
        });

        let mut assistant_message = json!({
            "role": "assistant",
            "content": if completion.text.is_empty() { Value::Null } else { Value::String(completion.text.clone()) }
        });
        if !tool_calls.is_empty() {
            assistant_message["tool_calls"] = json!(tool_calls
                .iter()
                .map(|call| json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments }
                }))
                .collect::<Vec<_>>());
        }
        messages.push(assistant_message);

        if tool_calls.is_empty() {
            break;
        }

        for call in &tool_calls {
            let arguments: Value = serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
            let summary = tools::summarize(&app, &call.name, &arguments);
            orchestrator.set_step(&call.name);
            let mut record = Orchestrator::new_item(&turn_id, "tool", "streaming");
            record.tool = Some(ToolRecord {
                call_id: call.id.clone(),
                name: call.name.clone(),
                arguments: arguments.clone(),
                summary: summary.clone(),
                result: String::new(),
                ok: true,
            });
            let record = orchestrator.push_item(record);
            let outcome = if serde_json::from_str::<Value>(&call.arguments).is_err() {
                Err(format!("The arguments for {} were not valid JSON: {}", call.name, call.arguments))
            } else {
                tools::execute(&app, &call.name, &arguments).await
            };
            let (ok, mut result) = match outcome {
                Ok(result) => (true, result),
                Err(message) => (false, message),
            };
            if result.chars().count() > MAX_TOOL_RESULT {
                let kept: String = result.chars().take(MAX_TOOL_RESULT).collect();
                result = format!("{kept}\n…[result trimmed]");
            }
            let result_for_item = result.clone();
            orchestrator.update_item(&record.id, true, |item| {
                if let Some(tool) = item.tool.as_mut() {
                    tool.result = result_for_item;
                    tool.ok = ok;
                }
                item.status = if ok { "done".into() } else { "error".into() };
                item.finished_at = Some(iso_now());
            });
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": if ok { result } else { format!("Error: {result}") }
            }));
        }

        if step + 1 == MAX_STEPS {
            messages.push(json!({
                "role": "user",
                "content": "[You have used the tool budget for this turn. Answer the user now with what you know.]"
            }));
            let assistant = orchestrator.push_item(Orchestrator::new_item(&turn_id, "assistant", "streaming"));
            let request = llm::ChatRequest {
                base_url: &config.base_url,
                api_key: &api_key,
                model: &config.model,
                openrouter: config.is_openrouter(),
                reasoning: reasoning.clone(),
                messages: &messages,
                tools: &[],
            };
            let closing = llm::stream_chat(&orchestrator.http, request, |_, _| {}).await;
            let (text, status) = match closing {
                Ok(completion) => (completion.text, "done"),
                Err(message) => (message, "error"),
            };
            orchestrator.update_item(&assistant.id, true, |item| {
                item.text = text;
                item.status = status.into();
                item.finished_at = Some(iso_now());
            });
        }
    }

    orchestrator.finish_turn(&turn_id, error, turn_usage);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_key_overrides_environment_and_previews_are_masked() {
        let mut config = OrchestratorConfig {
            key_env: "TERMINAL_ORCHESTRATOR_TEST_KEY_THAT_IS_UNSET".into(),
            ..OrchestratorConfig::default()
        };
        assert_eq!(resolve_key(&config), (None, "none"));
        config.api_key = Some("sk-or-v1-abcdefghijklmnopqrstuvwxyz".into());
        let (key, source) = resolve_key(&config);
        assert_eq!(source, "manual");
        assert_eq!(key_preview(&key.unwrap()), "sk-or-v1…wxyz");
    }

    #[test]
    fn config_updates_validate_and_switch_provider_defaults() {
        let root = tempfile::tempdir().unwrap();
        let (events, _) = broadcast::channel(8);
        let orchestrator = Orchestrator::new(root.path(), events);
        let updated = orchestrator
            .update_config(&json!({ "provider": "custom", "baseUrl": "http://localhost:1234/v1/", "model": "local-coder" }))
            .unwrap();
        assert_eq!(updated["provider"], "custom");
        assert_eq!(updated["baseUrl"], "http://localhost:1234/v1");
        assert_eq!(updated["keyEnv"], CUSTOM_KEY_ENV);
        assert!(orchestrator
            .update_config(&json!({ "baseUrl": "localhost:1234" }))
            .is_err());
        assert!(orchestrator.update_config(&json!({ "reasoning": "max" })).is_err());
        let back = orchestrator.update_config(&json!({ "provider": "openrouter" })).unwrap();
        assert_eq!(back["baseUrl"], OPENROUTER_BASE_URL);
        assert_eq!(back["keyEnv"], OPENROUTER_KEY_ENV);
        // The manual key never leaves the process in clear text.
        let with_key = orchestrator
            .update_config(&json!({ "apiKey": "sk-or-v1-0123456789abcdefghij" }))
            .unwrap();
        assert_eq!(with_key["keySource"], "manual");
        assert_eq!(with_key["keyPreview"], "sk-or-v1…ghij");
        assert!(with_key.get("apiKey").is_none());
        let persisted: OrchestratorConfig = read_json(&root.path().join(CONFIG_FILE));
        assert_eq!(persisted.api_key.as_deref(), Some("sk-or-v1-0123456789abcdefghij"));
        let cleared = orchestrator.update_config(&json!({ "apiKey": "" })).unwrap();
        assert_ne!(cleared["keySource"], "manual");
    }

    #[test]
    fn transcript_survives_a_restart_with_streaming_items_cancelled() {
        let root = tempfile::tempdir().unwrap();
        let (events, _) = broadcast::channel(8);
        let orchestrator = Orchestrator::new(root.path(), events.clone());
        let mut item = Orchestrator::new_item("turn", "assistant", "streaming");
        item.text = "half an answer".into();
        orchestrator.push_item(item);
        orchestrator.state.lock().items[0].seq = 5;
        let state = orchestrator.state.lock();
        orchestrator.persist_history_locked(&state);
        drop(state);

        let reloaded = Orchestrator::new(root.path(), events);
        let status = reloaded.status(None, true);
        assert_eq!(status["transcript"][0]["status"], "cancelled");
        assert_eq!(status["transcript"][0]["text"], "half an answer");
        let partial = reloaded.status(Some(5), true);
        assert_eq!(partial["transcript"].as_array().unwrap().len(), 0);
        assert_eq!(partial["partial"], true);
    }
}
