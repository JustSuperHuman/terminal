import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ServerEndpoint } from "./endpoint";

const SERVERS_KEY = "justterminal.servers.v1";
const LAST_KEY = "justterminal.lastServerId.v1";

export async function loadServers(): Promise<ServerEndpoint[]> {
  try {
    const raw = await AsyncStorage.getItem(SERVERS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ServerEndpoint[]) : [];
  } catch {
    return [];
  }
}

export async function saveServers(servers: ServerEndpoint[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
  } catch {
    // best effort
  }
}

/** Insert or update an endpoint (keyed by id) and move it to the front. */
export async function rememberServer(endpoint: ServerEndpoint): Promise<ServerEndpoint[]> {
  const servers = await loadServers();
  const rest = servers.filter((item) => item.id !== endpoint.id);
  const next = [endpoint, ...rest].slice(0, 12);
  await saveServers(next);
  await AsyncStorage.setItem(LAST_KEY, endpoint.id);
  return next;
}

export async function forgetServer(id: string): Promise<ServerEndpoint[]> {
  const servers = await loadServers();
  const next = servers.filter((item) => item.id !== id);
  await saveServers(next);
  return next;
}

export async function loadLastServerId(): Promise<string | undefined> {
  try {
    return (await AsyncStorage.getItem(LAST_KEY)) ?? undefined;
  } catch {
    return undefined;
  }
}

// Per-host recent working directories for new sessions. Most-recent first; the
// first entry doubles as the saved default cwd for that host.
const CWDS_PREFIX = "justterminal.cwds.";

function cwdsKey(endpointId: string): string {
  return `${CWDS_PREFIX}${endpointId}`;
}

export async function loadRecentCwds(endpointId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(cwdsKey(endpointId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export async function rememberCwd(endpointId: string, cwd: string): Promise<string[]> {
  const value = cwd.trim();
  if (!value) {
    return loadRecentCwds(endpointId);
  }
  const current = await loadRecentCwds(endpointId);
  const next = [value, ...current.filter((item) => item !== value)].slice(0, 8);
  try {
    await AsyncStorage.setItem(cwdsKey(endpointId), JSON.stringify(next));
  } catch {
    // best effort
  }
  return next;
}

export async function forgetCwd(endpointId: string, cwd: string): Promise<string[]> {
  const current = await loadRecentCwds(endpointId);
  const next = current.filter((item) => item !== cwd);
  try {
    await AsyncStorage.setItem(cwdsKey(endpointId), JSON.stringify(next));
  } catch {
    // best effort
  }
  return next;
}

// Composer vs direct typing. Composer mode edits locally and sends whole
// messages; direct mode hands every keystroke to the terminal. Persisted so
// the app opens the way it was left.
const COMPOSER_MODE_KEY = "justterminal.composerMode.v1";

export async function loadComposerMode(): Promise<boolean> {
  try {
    // Composer-first is the default: it is what makes Claude/Codex usable on a
    // phone. Only an explicit opt-out is stored as "0".
    return (await AsyncStorage.getItem(COMPOSER_MODE_KEY)) !== "0";
  } catch {
    return true;
  }
}

export async function saveComposerMode(value: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(COMPOSER_MODE_KEY, value ? "1" : "0");
  } catch {
    // best effort
  }
}

// Unsent composer text, kept per session so switching away mid-thought (or
// backgrounding the app) does not lose it. One record for all sessions: a key
// per session would leak entries as sessions come and go.
const DRAFTS_KEY = "justterminal.drafts.v1";
const MAX_DRAFTS = 40;

type DraftMap = Record<string, string>;

function draftKey(endpointId: string, sessionId: string): string {
  return `${endpointId}|${sessionId}`;
}

async function loadDrafts(): Promise<DraftMap> {
  try {
    const raw = await AsyncStorage.getItem(DRAFTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as DraftMap) : {};
  } catch {
    return {};
  }
}

export async function loadDraft(endpointId: string, sessionId: string): Promise<string> {
  return (await loadDrafts())[draftKey(endpointId, sessionId)] ?? "";
}

export async function saveDraft(endpointId: string, sessionId: string, text: string): Promise<void> {
  const drafts = await loadDrafts();
  const key = draftKey(endpointId, sessionId);
  if (text.trim()) {
    drafts[key] = text;
  } else {
    delete drafts[key];
  }

  // Oldest-first eviction is not worth tracking timestamps for; insertion
  // order is close enough and keeps the record bounded.
  const keys = Object.keys(drafts);
  const trimmed: DraftMap = {};
  for (const item of keys.slice(Math.max(0, keys.length - MAX_DRAFTS))) {
    trimmed[item] = drafts[item]!;
  }

  try {
    await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(trimmed));
  } catch {
    // best effort
  }
}

// Sent prompts, per host. Recalling "that long prompt I wrote yesterday" is
// the single biggest time-saver when typing on a phone.
const PROMPTS_PREFIX = "justterminal.prompts.";
const MAX_PROMPTS = 120;

export interface PromptHistoryEntry {
  text: string;
  at: number;
  cwd?: string;
}

function promptsKey(endpointId: string): string {
  return `${PROMPTS_PREFIX}${endpointId}`;
}

export async function loadPromptHistory(endpointId: string): Promise<PromptHistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(promptsKey(endpointId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PromptHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export async function rememberPrompt(
  endpointId: string,
  text: string,
  cwd?: string
): Promise<PromptHistoryEntry[]> {
  const value = text.trim();
  if (!value) {
    return loadPromptHistory(endpointId);
  }

  const current = await loadPromptHistory(endpointId);
  const next = [{ text: value, at: Date.now(), cwd }, ...current.filter((item) => item.text !== value)].slice(
    0,
    MAX_PROMPTS
  );
  try {
    await AsyncStorage.setItem(promptsKey(endpointId), JSON.stringify(next));
  } catch {
    // best effort
  }
  return next;
}

export async function forgetPrompt(endpointId: string, text: string): Promise<PromptHistoryEntry[]> {
  const next = (await loadPromptHistory(endpointId)).filter((item) => item.text !== text);
  try {
    await AsyncStorage.setItem(promptsKey(endpointId), JSON.stringify(next));
  } catch {
    // best effort
  }
  return next;
}

// Sessions-drawer ordering: false = grouped by project in server order,
// true = flat list by last update with the most recent at the bottom.
const SORT_RECENT_KEY = "justterminal.sortRecent.v1";

export async function loadSortRecent(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SORT_RECENT_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function saveSortRecent(value: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(SORT_RECENT_KEY, value ? "1" : "0");
  } catch {
    // best effort
  }
}
