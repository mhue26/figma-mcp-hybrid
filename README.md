# Figma MCP (Hybrid)

A local Model Context Protocol server that gives Cursor (or any MCP client) **both**:

- **REST reads** — read *any* Figma file by key (document tree, nodes, components, styles, comments, image exports), hardened against Figma's rate limits with a persistent disk cache, per-tier throttling, 429/Retry-After backoff, request coalescing, and stale-while-revalidate. Works without opening the file in Figma.
- **Canvas writes** — create/edit/delete nodes, set fills, auto-layout, components, text, and more, by driving the Figma Plugin API over a local WebSocket bridge.

It is a hybrid of two approaches:

- The write/plugin bridge and its ~45 canvas tools are based on [`sonnylazuardi/cursor-talk-to-figma-mcp`](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp) (MIT), ported to run entirely on **Node** (no Bun).
- The REST read tools (`get_figma_*`) are added on top in [`src/figma-api.ts`](src/figma-api.ts) and [`src/talk_to_figma_mcp/server.ts`](src/talk_to_figma_mcp/server.ts).

## Architecture

```
Cursor (MCP host)
   stdio / JSON-RPC
MCP server  (src/talk_to_figma_mcp/server.ts, Node + tsx)
   REST + disk cache + throttle  ->  Figma REST API        (read any file by key)
   WebSocket client  ->  Relay (src/socket.ts) <-> Figma plugin  (read open file + write canvas)
```

Three independent processes connect over `ws://localhost:3055`:

1. The **relay** ([`src/socket.ts`](src/socket.ts)) — a channel-based WebSocket broker.
2. The **MCP server** — connects to the relay as a client and to Cursor over stdio.
3. The **Figma plugin** ([`src/cursor_mcp_plugin`](src/cursor_mcp_plugin)) — its iframe UI owns the WebSocket (the plugin sandbox can't), and relays commands to the Figma scene.

The MCP server and plugin pair up by joining the same **channel**.

## Avoiding Figma rate limits

Figma's REST API is rate-limited (leaky bucket, per-minute; e.g. Tier-1 file/image reads are 10-20/min on paid Dev/Full seats but only **6 per month** on Starter). This server minimizes how often it actually calls the API using a read hierarchy:

```
1. Plugin bridge   -> read the open file via the Plugin API   (0 REST calls, no limit, no token)
2. Disk cache      -> serve a fresh cached response           (0 REST calls)
3. Throttled fetch -> per-tier queue + coalesce duplicates    (1 REST call, then cached)
   - on 429        -> wait Retry-After, exponential backoff
   - on failure    -> serve stale cache with a [STALE] note
```

Practical effect: an agent that would otherwise make hundreds of reads makes one (or zero, when the file is open in Figma). REST tool results are prefixed with `[cache hit]` or `[STALE] ...` so you can see when no API call was made. Pass `forceRefresh: true` to any read tool (or use `figma_cache_clear`) to bypass the cache.

### Caching / throttling env vars (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `FIGMA_CACHE_DIR` | OS cache dir (`~/Library/Caches/figma-mcp`, `~/.cache/figma-mcp`, `%LOCALAPPDATA%/figma-mcp`) | Where cached responses are written |
| `FIGMA_CACHE_TTL` | `24h` | TTL for file/node/component/style/comment reads (`30d`, `12h`, `30m`, `60s`, `500ms`) |
| `FIGMA_IMAGE_CACHE_TTL` | `1h` | TTL for image renders (URLs expire, so kept short) |
| `FIGMA_RPM_TIER1` | `10` | Max requests/min for Tier 1 (file, nodes, images) |
| `FIGMA_RPM_TIER2` | `25` | Max requests/min for Tier 2 (comments) |
| `FIGMA_RPM_TIER3` | `50` | Max requests/min for Tier 3 (components, styles) |
| `FIGMA_MAX_RETRIES` | `5` | Max 429 retries before giving up (then stale cache is served if available) |

Raise `FIGMA_CACHE_TTL` (e.g. `30d`) for stable/finished designs to make API calls extremely rare. Lower the `FIGMA_RPM_*` values to match a Starter seat's stricter limits.

## Requirements

- Node.js 18+ (developed on Node 24; uses the global `fetch`). No Bun required.
- Figma Desktop (for the write/plugin path).
- A Figma personal access token (for the REST read path): Figma → Settings → Security → Personal access tokens.

## Install

```bash
npm install
```

## Configure Cursor

Add to `~/.cursor/mcp.json` (use an absolute path to this folder):

```json
{
  "mcpServers": {
    "figma-hybrid": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/figma-mcp/src/talk_to_figma_mcp/server.ts"],
      "env": {
        "FIGMA_TOKEN": "your-figma-personal-access-token"
      }
    }
  }
}
```

A project-scoped equivalent is in [`.mcp.json`](.mcp.json). The `FIGMA_TOKEN` is only needed for REST read tools; the plugin/WebSocket write tools work without it.

## Run order

1. **Start the relay:**
   ```bash
   npm run socket
   ```
   (Listens on `ws://localhost:3055`. Override with `WS_PORT`.)
2. **Run the Figma plugin:** Figma Desktop → Plugins → Development → Import plugin from manifest → select [`src/cursor_mcp_plugin/manifest.json`](src/cursor_mcp_plugin/manifest.json) → run it. In the plugin UI, copy/generate a **channel** name and connect.
3. **The MCP server** is started by Cursor automatically from `mcp.json`. To run it manually: `npm run start`.
4. **In Cursor**, call the `join_channel` tool with the same channel name from step 2. Now both read and write tools are live.

## Tools

### REST read tools (need `FIGMA_TOKEN`, work on any file by key, cached)

All read tools accept `forceRefresh: true` to bypass the cache.

| Tool | Tier | Purpose |
|---|---|---|
| `get_figma_file` | 1 | Document tree (defaults to `depth=2`; slimmed to name/lastModified/document) |
| `get_figma_nodes` | 1 | Specific nodes by comma-separated IDs |
| `get_figma_images` | 1 | Render nodes to PNG/JPG/SVG/PDF URLs (short cache) |
| `get_figma_comments` | 2 | File comments |
| `post_figma_comment` | 2 | Add a comment (optionally anchored to a node); not cached |
| `get_figma_components` | 3 | Published components |
| `get_figma_styles` | 3 | Color/text/effect/grid styles |
| `figma_cache_stats` | - | Cache location, entry count, size |
| `figma_cache_clear` | - | Clear cache (all, or by `fileKey`) |

### Canvas/plugin tools (need the relay + plugin running, plus `join_channel`)

`create_frame`, `create_text`, `create_rectangle`, `set_fill_color`, `set_stroke_color`, `move_node`, `resize_node`, `clone_node`, `delete_node`, auto-layout (`set_layout_mode`, `set_padding`, `set_item_spacing`, ...), component instances, annotations, text scanning, and more — see [`src/talk_to_figma_mcp/server.ts`](src/talk_to_figma_mcp/server.ts).

## Verify

```bash
npm run typecheck            # tsc --noEmit
node scripts/relay-smoke.mjs # relay request/response round-trip
node scripts/mcp-smoke.mjs   # boot server over stdio, list tools
npx tsx scripts/cache-smoke.ts # cache hit, 429 backoff, coalescing, stale-while-revalidate
```

For a full end-to-end check, set `FIGMA_TOKEN`, start the relay + plugin, `join_channel`, then call `get_figma_file` on a known key and `create_frame` followed by `set_fill_color`.

## Gotchas

- **stdio is sacred.** The MCP server must never write to stdout except JSON-RPC. It logs to stderr via a `logger`. The relay is a separate process, so its stdout logging is fine.
- **WebSocket lives in the plugin UI.** The Figma plugin sandbox has no `WebSocket`; the iframe (`ui.html`) owns the socket and relays to the main thread.
- **Channel mismatch = silence.** If write tools hang, confirm the plugin and `join_channel` use the same channel and the relay is running.
- **Response size.** Keep `get_figma_file` at low `depth`; use `get_figma_nodes` for targeted reads.

## Credits

Write bridge and plugin: [`sonnylazuardi/cursor-talk-to-figma-mcp`](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp) (MIT). REST read layer and Node port added here.
