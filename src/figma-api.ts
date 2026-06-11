// Thin wrapper around the Figma REST API with a small in-memory TTL cache.
// Reads work on ANY file by key (unlike the plugin bridge, which only sees the
// file currently open in Figma Desktop).

const FIGMA_API_BASE = "https://api.figma.com/v1";

interface CacheEntry {
  data: unknown;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function getToken(): string {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      "FIGMA_TOKEN is not set. Add it to the MCP server env (see README) to use REST read tools."
    );
  }
  return token;
}

/**
 * GET a Figma REST endpoint with a TTL cache. `path` must start with "/"
 * (e.g. "/files/abc123?depth=2"). Cache is keyed by the full path.
 */
export async function figmaGet<T = any>(path: string, ttlMs = 60_000): Promise<T> {
  const hit = cache.get(path);
  if (hit && hit.expires > Date.now()) {
    return hit.data as T;
  }

  const res = await fetch(`${FIGMA_API_BASE}${path}`, {
    headers: { "X-Figma-Token": getToken() },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Figma API ${res.status} ${res.statusText}: ${body}`);
  }

  const data = (await res.json()) as T;
  cache.set(path, { data, expires: Date.now() + ttlMs });
  return data;
}

/**
 * POST to a Figma REST endpoint. Not cached. Invalidates any cached GET for the
 * same path prefix is the caller's responsibility (kept simple here).
 */
export async function figmaPost<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${FIGMA_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Figma-Token": getToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma API ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

/** True when a Figma personal access token is configured. */
export function hasFigmaToken(): boolean {
  return Boolean(process.env.FIGMA_TOKEN);
}

/** Clear the in-memory REST cache (mainly useful for tests/manual resets). */
export function clearFigmaCache(): void {
  cache.clear();
}
