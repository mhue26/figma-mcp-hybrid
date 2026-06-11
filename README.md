# Figma MCP (Hybrid)

A local Model Context Protocol server that gives Cursor (or any MCP client) **both**:

- **REST reads** — read *any* Figma file by key (document tree, nodes, components, styles, comments, image exports), with a small in-memory TTL cache. Works without opening the file in Figma.
- **Canvas writes** — create/edit/delete nodes, set fills, auto-layout, components, text, and more, by driving the Figma Plugin API over a local WebSocket bridge.

It is a hybrid of two approaches:

- The write/plugin bridge and its ~45 canvas tools are based on [`sonnylazuardi/cursor-talk-to-figma-mcp`](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp) (MIT), ported to run entirely on **Node** (no Bun).
- The REST read tools (`get_figma_*`) are added on top in [`src/figma-api.ts`](src/figma-api.ts) and [`src/talk_to_figma_mcp/server.ts`](src/talk_to_figma_mcp/server.ts).

## Architecture

```
Cursor (MCP host)
   stdio / JSON-RPC
MCP server  (src/talk_to_figma_mcp/server.ts, Node + tsx)
   REST + TTL cache  ->  Figma REST API            (read any file by key)
   WebSocket client  ->  Relay (src/socket.ts) <-> Figma plugin  (write canvas)
```

Three independent processes connect over `ws://localhost:3055`:

1. The **relay** ([`src/socket.ts`](src/socket.ts)) — a channel-based WebSocket broker.
2. The **MCP server** — connects to the relay as a client and to Cursor over stdio.
3. The **Figma plugin** ([`src/cursor_mcp_plugin`](src/cursor_mcp_plugin)) — its iframe UI owns the WebSocket (the plugin sandbox can't), and relays commands to the Figma scene.

The MCP server and plugin pair up by joining the same **channel**.

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

### REST read tools (need `FIGMA_TOKEN`, work on any file by key)

| Tool | Purpose |
|---|---|
| `get_figma_file` | Document tree (defaults to `depth=2`; slimmed to name/lastModified/document) |
| `get_figma_nodes` | Specific nodes by comma-separated IDs |
| `get_figma_components` | Published components |
| `get_figma_styles` | Color/text/effect/grid styles |
| `get_figma_comments` | File comments |
| `post_figma_comment` | Add a comment (optionally anchored to a node) |
| `get_figma_images` | Render nodes to PNG/JPG/SVG/PDF URLs |

### Canvas/plugin tools (need the relay + plugin running, plus `join_channel`)

`create_frame`, `create_text`, `create_rectangle`, `set_fill_color`, `set_stroke_color`, `move_node`, `resize_node`, `clone_node`, `delete_node`, auto-layout (`set_layout_mode`, `set_padding`, `set_item_spacing`, ...), component instances, annotations, text scanning, and more — see [`src/talk_to_figma_mcp/server.ts`](src/talk_to_figma_mcp/server.ts).

## Verify

```bash
npm run typecheck            # tsc --noEmit
node scripts/relay-smoke.mjs # relay request/response round-trip
node scripts/mcp-smoke.mjs   # boot server over stdio, list tools
```

For a full end-to-end check, set `FIGMA_TOKEN`, start the relay + plugin, `join_channel`, then call `get_figma_file` on a known key and `create_frame` followed by `set_fill_color`.

## Gotchas

- **stdio is sacred.** The MCP server must never write to stdout except JSON-RPC. It logs to stderr via a `logger`. The relay is a separate process, so its stdout logging is fine.
- **WebSocket lives in the plugin UI.** The Figma plugin sandbox has no `WebSocket`; the iframe (`ui.html`) owns the socket and relays to the main thread.
- **Channel mismatch = silence.** If write tools hang, confirm the plugin and `join_channel` use the same channel and the relay is running.
- **Response size.** Keep `get_figma_file` at low `depth`; use `get_figma_nodes` for targeted reads.

## Credits

Write bridge and plugin: [`sonnylazuardi/cursor-talk-to-figma-mcp`](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp) (MIT). REST read layer and Node port added here.
