// Integration smoke test for the Node ws relay (src/socket.ts).
// Simulates the MCP server (peer A) and the Figma plugin (peer B) joining the
// same channel and exchanging a request/response, exercising the ported
// join/message broadcast protocol. Exits 0 on success, 1 on failure.

import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 3055;
const CHANNEL = "smoke-test";
const URL = `ws://localhost:${PORT}`;

const relay = spawn("npx", ["tsx", "src/socket.ts"], {
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
relay.stderr.on("data", (d) => process.stderr.write(`[relay] ${d}`));

function fail(msg) {
  console.error("FAIL:", msg);
  relay.kill();
  process.exit(1);
}

const timer = setTimeout(() => fail("timed out after 10s"), 10_000);

function waitOpen(ws) {
  return new Promise((res) => ws.once("open", res));
}

await new Promise((r) => setTimeout(r, 1500)); // let relay bind

const peerA = new WebSocket(URL); // pretends to be the MCP server
const peerB = new WebSocket(URL); // pretends to be the Figma plugin
await Promise.all([waitOpen(peerA), waitOpen(peerB)]);

peerA.send(JSON.stringify({ type: "join", channel: CHANNEL, id: "join-a" }));
peerB.send(JSON.stringify({ type: "join", channel: CHANNEL, id: "join-b" }));
await new Promise((r) => setTimeout(r, 300));

// Peer B (plugin) echoes back any command it receives as a result.
peerB.on("message", (raw) => {
  const data = JSON.parse(raw.toString());
  if (data.type === "broadcast" && data.message?.command) {
    peerB.send(
      JSON.stringify({
        type: "message",
        channel: CHANNEL,
        message: { id: data.message.id, result: { ok: true, echoed: data.message.command } },
      })
    );
  }
});

// Peer A (MCP server) sends a command and waits for the result to come back.
const reqId = "req-1";
const resultP = new Promise((resolve) => {
  peerA.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    if (data.type === "broadcast" && data.message?.id === reqId && data.message?.result) {
      resolve(data.message.result);
    }
  });
});

peerA.send(
  JSON.stringify({
    type: "message",
    channel: CHANNEL,
    id: reqId,
    message: { id: reqId, command: "create_frame", params: {} },
  })
);

const result = await resultP;
clearTimeout(timer);
if (result && result.ok && result.echoed === "create_frame") {
  console.log("PASS: relay round-trip ok ->", JSON.stringify(result));
  peerA.close();
  peerB.close();
  relay.kill();
  process.exit(0);
} else {
  fail("unexpected result " + JSON.stringify(result));
}
