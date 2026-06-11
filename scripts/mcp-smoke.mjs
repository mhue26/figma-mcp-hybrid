// Boots the MCP server over stdio, lists tools, and verifies the REST tools
// were registered alongside the plugin tools. Exits 0 on success.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/talk_to_figma_mcp/server.ts"],
  env: { ...process.env }, // no FIGMA_TOKEN -> should still boot (warns)
});

const client = new Client({ name: "smoke", version: "1.0.0" });

const timer = setTimeout(() => {
  console.error("FAIL: timed out");
  process.exit(1);
}, 20_000);

await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);

const expected = [
  "get_figma_file",
  "get_figma_nodes",
  "get_figma_components",
  "get_figma_styles",
  "get_figma_comments",
  "post_figma_comment",
  "get_figma_images",
  "figma_cache_stats",
  "figma_cache_clear",
  "join_channel",
  "create_frame",
  "set_fill_color",
];
const missing = expected.filter((n) => !names.includes(n));

clearTimeout(timer);
await client.close();

if (missing.length) {
  console.error("FAIL: missing tools:", missing.join(", "));
  process.exit(1);
}
console.log(`PASS: ${tools.length} tools registered (REST + plugin). Sample:`, expected.join(", "));
process.exit(0);
