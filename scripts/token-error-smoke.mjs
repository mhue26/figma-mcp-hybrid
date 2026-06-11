// Verifies a REST tool returns a clean, descriptive error (not a crash) when
// FIGMA_TOKEN is absent. Exits 0 on success.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = { ...process.env };
delete env.FIGMA_TOKEN;

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/talk_to_figma_mcp/server.ts"],
  env,
});
const client = new Client({ name: "token-smoke", version: "1.0.0" });
await client.connect(transport);

const res = await client.callTool({
  name: "get_figma_file",
  arguments: { fileKey: "dummy" },
});
await client.close();

const text = res.content?.[0]?.text ?? "";
if (res.isError && /FIGMA_TOKEN/.test(text)) {
  console.log("PASS: missing-token error surfaced ->", text);
  process.exit(0);
}
console.error("FAIL: unexpected result", JSON.stringify(res));
process.exit(1);
