// Seeds a persistent wait-for edge (A holds an exclusive surface, B is queued on
// it) and stays alive so a browser can inspect the graph. Prints RUN=<id>.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = `http://localhost:${process.env.PORT ?? 8795}/mcp`;
const call = async (c: Client, name: string, args: any = {}) => {
  // timeout > the blocking claim's long-poll, or the SDK kills the request at its 60s default
  const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 610_000 });
  return JSON.parse(r.content?.[0]?.text ?? "{}");
};
const connect = async () => { const c = new Client({ name: "seed", version: "0" }); await c.connect(new StreamableHTTPClientTransport(new URL(BASE))); return c; };

const a = await connect();
const runId = (await call(a, "create_run", { label: "contention-demo" })).run_id;
await call(a, "join_run", { run_id: runId, label: "A" });
await call(a, "claim", { surfaces: ["path:repo/hot"], mode: "exclusive", ttl_ms: 600_000 });

const b = await connect();
await call(b, "join_run", { run_id: runId, label: "B" });
console.log(`RUN=${runId}`);

// Blocks (queued behind A) → keeps the process alive and the edge present.
await call(b, "claim", { surfaces: ["path:repo/hot"], mode: "exclusive", block: true, timeout_ms: 600_000 });
