// End-to-end with the REAL Qwen embedder (default provider): boot the server,
// write semantically-distinct facts, search with a PARAPHRASE (no lexical
// overlap), and confirm the semantically-matching fact ranks first. Proves real
// semantic retrieval through the whole MCP stack. Model must already be cached
// (run test/qwen.ts first). Run: npx tsx test/qwen-e2e.ts
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8797, DB = `.qe2e-${process.pid}.db`;
let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  try { return JSON.parse(r.content?.[0]?.text ?? "{}"); } catch { return { raw: r.content?.[0]?.text }; }
}

async function main() {
  // No EMBED_PROVIDER override -> uses the default (qwen).
  const server = spawn("npx", ["tsx", "src/index.ts"],
    { env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: "inherit", detached: true });
  const kill = () => { try { process.kill(-server.pid!, "SIGKILL"); } catch { server.kill("SIGKILL"); } };
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${PORT}/api/runs`); break; } catch { await sleep(300); } }
    const c = new Client({ name: "qe2e", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));

    const ns = "qwen-e2e";
    const auth = await call(c, "fact_write", { namespace: ns, text: "The login flow authenticates users by issuing signed JWT access tokens." });
    await call(c, "fact_write", { namespace: ns, text: "Nightly backups are written to object storage in us-east-1." });
    await call(c, "fact_write", { namespace: ns, text: "The UI uses a dark color palette with a teal accent." });
    ok(!!auth.fact_id, `wrote 3 facts (auth=${auth.fact_id})`);

    // Paraphrase with no shared keywords with the auth fact -> only semantics can match.
    const res = await call(c, "fact_search", { namespace: ns, query: "How are people signed in and verified?", k: 3 });
    const top = res.hits?.[0];
    console.log(`  top hit: "${top?.text}" (d=${top?.distance?.toFixed?.(3)})`);
    ok(top?.id === auth.fact_id, `paraphrase search returns the auth fact first (semantic, not lexical)`);

    const ln = await call(c, "list_namespaces", {});
    const n = ln.namespaces?.find((x: any) => x.name === ns);
    ok(n?.embed_model === "qwen3-embedding-0.6b" && n?.dim === 1024, `namespace pinned to ${n?.embed_model} dim ${n?.dim}`);

    await c.close();
  } finally {
    kill(); await sleep(200);
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { (await import("node:fs")).rmSync(f, { force: true }); } catch {} }
  }
  console.log(failures === 0 ? "\nQWEN E2E OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
