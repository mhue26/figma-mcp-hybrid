// Hardened Figma REST client built to avoid rate limits.
//
// Read hierarchy (see README): prefer the plugin bridge (0 API calls), then the
// persistent disk cache (0 API calls), and only as a last resort make a REST
// call that is throttled per tier, coalesced, and 429/Retry-After backoff-aware.
// On failure with a stale cache entry, we serve the stale copy instead of erroring.

import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";

const FIGMA_API_BASE = "https://api.figma.com/v1";

export type Tier = 1 | 2 | 3;

export interface FigmaGetOptions {
  /** Override the cache TTL in milliseconds for this request. */
  ttlMs?: number;
  /** Figma rate-limit tier of the endpoint (controls throttle bucket). */
  tier?: Tier;
  /** Bypass the cache and force a fresh fetch (still written to cache). */
  forceRefresh?: boolean;
}

export interface FigmaGetResult<T> {
  data: T;
  /** True when the value came from cache (fresh or stale). */
  cached: boolean;
  /** True when the value is an expired cache entry served as a fallback. */
  stale: boolean;
  /** Human-readable note when stale/fallback occurred. */
  note?: string;
}

interface CacheEntry {
  path: string;
  data: unknown;
  fetchedAt: number;
  expires: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getToken(): string {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      "FIGMA_TOKEN is not set. Add it to the MCP server env (see README) to use REST read tools."
    );
  }
  return token;
}

/** True when a Figma personal access token is configured. */
export function hasFigmaToken(): boolean {
  return Boolean(process.env.FIGMA_TOKEN);
}

/** Parse a duration like "30d", "12h", "30m", "60s", "500ms". Returns ms. */
export function parseDuration(input: string | undefined, fallbackMs: number): number {
  if (!input) return fallbackMs;
  const m = String(input).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return fallbackMs;
  const value = parseFloat(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(value * (mult[unit] ?? 1));
}

const DEFAULT_TTL_MS = parseDuration(process.env.FIGMA_CACHE_TTL, 86_400_000); // 24h

function defaultCacheDir(): string {
  if (process.env.FIGMA_CACHE_DIR) return process.env.FIGMA_CACHE_DIR;
  const os = platform();
  if (os === "darwin") return join(homedir(), "Library", "Caches", "figma-mcp");
  if (os === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "figma-mcp"
    );
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "figma-mcp");
}

const CACHE_DIR = defaultCacheDir();

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFileFor(path: string): string {
  const hash = createHash("sha256").update(path).digest("hex");
  return join(CACHE_DIR, `${hash}.json`);
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function readCache(path: string): CacheEntry | null {
  try {
    const file = cacheFileFor(path);
    if (!existsSync(file)) return null;
    const entry = JSON.parse(readFileSync(file, "utf-8")) as CacheEntry;
    if (!entry || typeof entry !== "object") return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(path: string, data: unknown, ttlMs: number): void {
  try {
    ensureCacheDir();
    const entry: CacheEntry = {
      path,
      data,
      fetchedAt: Date.now(),
      expires: Date.now() + ttlMs,
    };
    writeFileSync(cacheFileFor(path), JSON.stringify(entry));
  } catch {
    // Cache write failures should never break a read.
  }
}

export interface CacheStats {
  dir: string;
  entries: number;
  totalBytes: number;
}

export function getCacheStats(): CacheStats {
  let entries = 0;
  let totalBytes = 0;
  try {
    if (existsSync(CACHE_DIR)) {
      for (const f of readdirSync(CACHE_DIR)) {
        if (!f.endsWith(".json")) continue;
        entries++;
        totalBytes += statSync(join(CACHE_DIR, f)).size;
      }
    }
  } catch {
    // ignore
  }
  return { dir: CACHE_DIR, entries, totalBytes };
}

/**
 * Clear the disk cache. With no argument, wipes everything. With a `fileKey`,
 * removes only entries whose cached path contains that key.
 */
export function clearDiskCache(fileKey?: string): number {
  let removed = 0;
  try {
    if (!existsSync(CACHE_DIR)) return 0;
    for (const f of readdirSync(CACHE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const full = join(CACHE_DIR, f);
      if (!fileKey) {
        rmSync(full, { force: true });
        removed++;
        continue;
      }
      try {
        const entry = JSON.parse(readFileSync(full, "utf-8")) as CacheEntry;
        if (entry?.path?.includes(fileKey)) {
          rmSync(full, { force: true });
          removed++;
        }
      } catch {
        // ignore unreadable entry
      }
    }
  } catch {
    // ignore
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Per-tier throttle (in-house, no deps): serialized queue with a minimum
// interval between requests so we proactively stay under the per-minute bucket.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rpmFor(tier: Tier): number {
  const envKey = `FIGMA_RPM_TIER${tier}`;
  const fromEnv = process.env[envKey] ? Number(process.env[envKey]) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  // Defaults: Figma paid Dev/Full per-minute limits.
  return { 1: 10, 2: 25, 3: 50 }[tier];
}

class Throttle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private minIntervalMs: number) {}

  /** Queue work so calls are spaced at least minIntervalMs apart. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return fn();
    });
    // Keep the chain alive regardless of individual success/failure.
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const throttles = new Map<Tier, Throttle>();
function throttleFor(tier: Tier): Throttle {
  let t = throttles.get(tier);
  if (!t) {
    t = new Throttle(Math.ceil(60_000 / rpmFor(tier)));
    throttles.set(tier, t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Request coalescing: concurrent identical GETs share one in-flight promise.
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<unknown>>();

// ---------------------------------------------------------------------------
// Fetch with 429 / Retry-After backoff
// ---------------------------------------------------------------------------

class RateLimitError extends Error {
  constructor(message: string, readonly upgradeLink?: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

const MAX_RETRIES = Number(process.env.FIGMA_MAX_RETRIES ?? 5);
const BACKOFF_CAP_MS = 60_000;

async function fetchWithBackoff(path: string, tier: Tier): Promise<unknown> {
  const url = `${FIGMA_API_BASE}${path}`;
  const token = getToken();
  let attempt = 0;

  while (true) {
    const res = await throttleFor(tier).run(() =>
      fetch(url, { headers: { "X-Figma-Token": token } })
    );

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const rlType = res.headers.get("x-figma-rate-limit-type") ?? "unknown";
      const planTier = res.headers.get("x-figma-plan-tier") ?? "unknown";
      const upgrade = res.headers.get("x-figma-upgrade-link") ?? undefined;

      if (attempt++ >= MAX_RETRIES) {
        throw new RateLimitError(
          `Figma rate limit hit (429) after ${attempt} attempts. ` +
            `plan=${planTier}, limit-type=${rlType}.` +
            (upgrade ? ` Upgrade: ${upgrade}` : ""),
          upgrade
        );
      }

      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Figma API ${res.status} ${res.statusText}: ${body}`);
    }

    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Public GET: cache -> throttle/coalesce/backoff -> stale fallback
// ---------------------------------------------------------------------------

export async function figmaGet<T = any>(
  path: string,
  opts: FigmaGetOptions = {}
): Promise<FigmaGetResult<T>> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const tier = opts.tier ?? 1;

  const entry = readCache(path);
  const now = Date.now();

  if (!opts.forceRefresh && entry && entry.expires > now) {
    return { data: entry.data as T, cached: true, stale: false };
  }

  try {
    // Coalesce concurrent identical fetches.
    let pending = inFlight.get(path) as Promise<unknown> | undefined;
    if (!pending) {
      pending = fetchWithBackoff(path, tier).finally(() => inFlight.delete(path));
      inFlight.set(path, pending);
    }
    const data = (await pending) as T;
    writeCache(path, data, ttlMs);
    return { data, cached: false, stale: false };
  } catch (err) {
    // Stale-while-revalidate: serve an expired entry rather than failing.
    if (entry) {
      const reason = err instanceof Error ? err.message : String(err);
      const ageMin = Math.round((now - entry.fetchedAt) / 60_000);
      return {
        data: entry.data as T,
        cached: true,
        stale: true,
        note: `Served stale cache (~${ageMin}m old) because a fresh fetch failed: ${reason}`,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public POST (e.g. comments). Never cached; counts against the rate limit.
// ---------------------------------------------------------------------------

export async function figmaPost<T = any>(
  path: string,
  body: unknown,
  tier: Tier = 2
): Promise<T> {
  const url = `${FIGMA_API_BASE}${path}`;
  const token = getToken();
  let attempt = 0;

  while (true) {
    const res = await throttleFor(tier).run(() =>
      fetch(url, {
        method: "POST",
        headers: {
          "X-Figma-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (attempt++ >= MAX_RETRIES) {
        const upgrade = res.headers.get("x-figma-upgrade-link") ?? undefined;
        throw new RateLimitError(
          `Figma rate limit hit (429) on POST after ${attempt} attempts.` +
            (upgrade ? ` Upgrade: ${upgrade}` : ""),
          upgrade
        );
      }
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Figma API ${res.status} ${res.statusText}: ${text}`);
    }

    return (await res.json()) as T;
  }
}
