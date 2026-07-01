// Distiller harness test: an agent does work in a Run, the Run ends, and the
// distiller (a) auto-distills via the run.ended event stream, and (b) works in
// one-shot CLI mode. Uses the heuristic summarizer (offline). Run: npx tsx test/distiller.ts
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDistiller } from "../src/distiller.js";
import { HeuristicSummarizer } from "../src/summarizer.js";

const PORT = 8794, DB = `.distill-${process.pid}.db`;
const BASE = `http://localhost:${PORT}/mcp`, ROOT = `http://localhost:${PORT}`;
let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };

async function connect(): Promise<Client> {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE)));
  return c;
}
async function call(c: Client, name: string, args: any = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  try { return JSON.parse(r.content?.[0]?.text ?? "{}"); } catch { return { raw: r.content?.[0]?.text }; }
}

async function main() {
  const server = spawn("npx", ["tsx", "src/index.ts"],
    { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, EMBED_PROVIDER: "local" }, stdio: "inherit", detached: true });
  const killServer = () => { try { process.kill(-server.pid!, "SIGKILL"); } catch { server.kill("SIGKILL"); } };
  let distiller: Awaited<ReturnType<typeof createDistiller>> | null = null;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${ROOT}/api/runs`); break; } catch { await sleep(300); } }

    // Agent does some work and journals explicit knowledge.
    const a = await connect();
    const runId = (await call(a, "create_run", { label: "auth-work" })).run_id;
    await call(a, "join_run", { run_id: runId, label: "worker" });
    const cl = await call(a, "claim", { surfaces: ["path:svc/auth"], mode: "exclusive" });
    await call(a, "bb_write", { surface: "path:svc/auth/config", value: { jwt: true, ttl: 3600 } });
    await call(a, "journal_append", { type: "decision", payload: { text: "Chose JWT over server sessions for statelessness" } });
    await call(a, "journal_append", { type: "finding", payload: { text: "Login endpoint is rate-limited to 5 requests per minute" } });
    await call(a, "release", { claim_id: cl.claimId });

    // Start the distiller in WATCH mode (auto path).
    distiller = await createDistiller({ mcpUrl: BASE, httpBase: ROOT, namespace: "distilled", summarizer: new HeuristicSummarizer() });
    distiller.watch(); // background
    await sleep(600);  // let it connect to /api/events

    // End the Run → run.ended → distiller distills automatically.
    await call(a, "end_run", { run_id: runId });

    // Poll for distilled facts to appear.
    let hits: any = { hits: [] };
    for (let i = 0; i < 25; i++) {
      hits = await call(a, "fact_search", { namespace: "distilled", query: "Chose JWT over server sessions for statelessness", k: 5 });
      if (hits.hits?.length) break;
      await sleep(200);
    }
    ok(hits.hits?.length > 0, `auto-distill produced facts on run.ended (${hits.hits?.length ?? 0} hits)`);
    ok(/JWT/.test(hits.hits?.[0]?.text ?? ""), `top hit is the JWT decision: "${hits.hits?.[0]?.text}"`);
    ok(hits.hits?.[0]?.provenance?.source_run_id === runId, `fact provenance points to source run ${runId}`);

    const ns = (await call(a, "list_namespaces", {})).namespaces?.find((n: any) => n.name === "distilled");
    ok(ns?.fact_count === 3, `distilled namespace has 3 facts (2 journal + 1 blackboard) — got ${ns?.fact_count}`);
    const bbFact = await call(a, "fact_search", { namespace: "distilled", query: "Final state of path:svc/auth/config", k: 3 });
    ok(/Final state of/.test(bbFact.hits?.[0]?.text ?? ""), `blackboard final-state distilled into a fact`);

    // One-shot CLI mode into a separate namespace.
    const cli = spawn("npx", ["tsx", "src/distiller.ts", runId],
      { env: { ...process.env, MCP_URL: BASE, HTTP_BASE: ROOT, DISTILL_NAMESPACE: "distilled-cli", SUMMARIZER: "heuristic" }, stdio: "inherit", detached: true });
    const cliDone = new Promise<number>((res) => cli.on("exit", (code) => res(code ?? 1)));
    const code = await Promise.race([cliDone, sleep(30_000).then(() => -1)]);
    ok(code === 0, `one-shot CLI exited cleanly (code ${code})`);
    const cliNs = (await call(a, "list_namespaces", {})).namespaces?.find((n: any) => n.name === "distilled-cli");
    ok(cliNs?.fact_count === 3, `one-shot CLI wrote 3 facts to 'distilled-cli' — got ${cliNs?.fact_count}`);

    await a.close();
  } finally {
    if (distiller) await distiller.close();
    killServer();
    await sleep(200);
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { (await import("node:fs")).rmSync(f, { force: true }); } catch {} }
  }
  console.log(failures === 0 ? "\nDISTILLER OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
