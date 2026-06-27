const storageKey = "terminal-web-access-token";

export function getAccessToken(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? params.get("access_token");
  if (token) {
    window.localStorage.setItem(storageKey, token);
    return token;
  }

  return window.localStorage.getItem(storageKey) ?? undefined;
}

export function setAccessToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed) {
    window.localStorage.setItem(storageKey, trimmed);
  }
}

export function accessTokenHeaders(): HeadersInit {
  const token = getAccessToken();
  return token ? { "x-terminal-web-token": token } : {};
}

export function withAccessToken(path: string): string {
  const token = getAccessToken();
  if (!token) {
    return path;
  }

  const url = new URL(path, window.location.href);
  url.searchParams.set("token", token);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function withAccessTokenUrl(url: string): string {
  const token = getAccessToken();
  if (!token) {
    return url;
  }

  const nextUrl = new URL(url);
  nextUrl.searchParams.set("token", token);
  return nextUrl.toString();
}
