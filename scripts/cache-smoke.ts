// Smoke test for the hardened Figma REST client (src/figma-api.ts).
// Mocks globalThis.fetch to validate: (a) disk cache hit, (b) 429/Retry-After
// retry, (c) request coalescing, (d) stale-while-revalidate. Run with:
//   npx tsx scripts/cache-smoke.ts
// Exits 0 on success, 1 on failure.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Configure env BEFORE importing the module (it reads env at load time).
const cacheDir = mkdtempSync(join(tmpdir(), "figma-cache-test-"));
process.env.FIGMA_CACHE_DIR = cacheDir;
process.env.FIGMA_TOKEN = "test-token";
process.env.FIGMA_RPM_TIER1 = "6000"; // ~10ms spacing so the test is fast
process.env.FIGMA_MAX_RETRIES = "3";

// ---- Mock fetch -----------------------------------------------------------
type Mode = "ok" | "429-once" | "neterror";
let mode: Mode = "ok";
const fetchCounts = new Map<string, number>();
let total429 = 0;

function keyFor(path: string) {
  // path is like "/files/AAA?depth=2"; the client prepends the "/v1" API base.
  return "/v1" + path;
}
function bump(url: string) {
  const u = new URL(url).pathname + new URL(url).search;
  fetchCounts.set(u, (fetchCounts.get(u) ?? 0) + 1);
}
function count(path: string) {
  return fetchCounts.get(keyFor(path));
}

(globalThis as any).fetch = async (url: string, _opts?: any) => {
  bump(url);
  if (mode === "neterror") {
    throw new Error("simulated network failure");
  }
  if (mode === "429-once") {
    total429++;
    if (total429 === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "1", "x-figma-rate-limit-type": "high" },
      });
    }
  }
  // small delay so concurrent calls overlap (for coalescing test)
  await sleep(40);
  return new Response(JSON.stringify({ ok: true, at: Date.now() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const { figmaGet } = await import("../src/figma-api.ts");

function fail(msg: string): never {
  console.error("FAIL:", msg);
  rmSync(cacheDir, { recursive: true, force: true });
  process.exit(1);
}

// (a) Disk cache hit: second identical read makes no fetch.
{
  const p = "/files/AAA?depth=2";
  const r1 = await figmaGet<any>(p, { tier: 1 });
  const r2 = await figmaGet<any>(p, { tier: 1 });
  if (r1.cached) fail("(a) first read should not be cached");
  if (!r2.cached || r2.stale) fail("(a) second read should be a fresh cache hit");
  if (count(p) !== 1) fail(`(a) expected 1 fetch, got ${count(p)}`);
  console.log("PASS (a) disk cache hit -> 1 fetch, second served from cache");
}

// (b) 429 + Retry-After retry succeeds.
{
  mode = "429-once";
  const p = "/files/BBB?depth=2";
  const r = await figmaGet<any>(p, { tier: 1 });
  if (!r.data?.ok) fail("(b) expected success after retry");
  if (count(p) !== 2) fail(`(b) expected 2 fetches (429 then 200), got ${count(p)}`);
  console.log("PASS (b) 429/Retry-After -> retried and succeeded");
  mode = "ok";
}

// (c) Request coalescing: concurrent identical reads share one fetch.
{
  const p = "/files/CCC?depth=2";
  const [c1, c2] = await Promise.all([
    figmaGet<any>(p, { tier: 1 }),
    figmaGet<any>(p, { tier: 1 }),
  ]);
  if (!c1.data?.ok || !c2.data?.ok) fail("(c) both concurrent reads should resolve");
  if (count(p) !== 1) fail(`(c) expected 1 coalesced fetch, got ${count(p)}`);
  console.log("PASS (c) coalescing -> 2 concurrent reads, 1 fetch");
}

// (d) Stale-while-revalidate: expired entry served when refresh fails.
{
  const p = "/files/DDD?depth=2";
  await figmaGet<any>(p, { tier: 1, ttlMs: 30 }); // populate, short TTL
  await sleep(50); // expire
  mode = "neterror";
  const r = await figmaGet<any>(p, { tier: 1, ttlMs: 30 });
  if (!r.stale) fail("(d) expected stale=true on refresh failure");
  if (!r.data?.ok) fail("(d) expected stale data to be served");
  if (!r.note) fail("(d) expected a stale note");
  console.log("PASS (d) stale-while-revalidate -> served expired cache on failure");
  mode = "ok";
}

rmSync(cacheDir, { recursive: true, force: true });
console.log("ALL CACHE TESTS PASSED");
process.exit(0);
