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

// Whether the command-bar key toolbar is expanded. Defaults to true.
const KEYS_KEY = "justterminal.keysExpanded.v1";

export async function loadKeysExpanded(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEYS_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export async function saveKeysExpanded(value: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS_KEY, value ? "1" : "0");
  } catch {
    // best effort
  }
}
