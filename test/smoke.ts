// End-to-end smoke test: boots the server, drives two agent sessions through the
// core coordination paths. Run: npx tsx test/smoke.ts
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const BASE = `http://localhost:${PORT}/mcp`;
const DB = `.smoke-${process.pid}.db`;

let failures = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };

async function connect(): Promise<Client> {
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE)));
  return client;
}

// tool call → parsed JSON of the first text block (+ isError flag)
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const txt = r.content?.[0]?.text ?? "{}";
  const body = (() => { try { return JSON.parse(txt); } catch { return { raw: txt }; } })();
  return { ...body, _isError: !!r.isError };
}

async function main() {
  const server = spawn("npx", ["tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, EMBED_PROVIDER: "local" }, stdio: "inherit", detached: true,
  });
  const killServer = () => { try { process.kill(-server.pid!, "SIGKILL"); } catch { server.kill("SIGKILL"); } };
  try {
    // wait for the server to listen
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://localhost:${PORT}/api/runs`); break; } catch { await sleep(200); }
    }

    const a = await connect();
    const runId = (await call(a, "create_run", { label: "smoke" })).run_id;
    ok(!!runId, `create_run -> ${runId}`);
    const aid = (await call(a, "join_run", { run_id: runId, label: "A" })).agent_id;
    ok(!!aid, `A join_run -> ${aid}`);

    // A claims an exclusive path surface
    const claimA = await call(a, "claim", { surfaces: ["path:repo/src/auth"], mode: "exclusive" });
    ok(claimA.status === "granted", `A claim exclusive repo/src/auth -> ${claimA.status}`);

    // A can write a covered cell; an uncovered cell is rejected
    const w1 = await call(a, "bb_write", { surface: "path:repo/src/auth/login.ts", value: { editing: true } });
    ok(w1.version === 1 && !w1._isError, `A bb_write covered cell -> v${w1.version}`);
    const w2 = await call(a, "bb_write", { surface: "path:repo/src/db/schema.ts", value: { x: 1 } });
    ok(w2._isError === true, `A bb_write uncovered cell -> rejected`);

    // B joins and hits the conflict on an overlapping (descendant) surface
    const b = await connect();
    const bid = (await call(b, "join_run", { run_id: runId, label: "B" })).agent_id;
    ok(!!bid, `B join_run -> ${bid}`);
    const claimB = await call(b, "claim", { surfaces: ["path:repo/src/auth/login.ts"], mode: "exclusive" });
    ok(claimB.status === "denied" && claimB.conflicts?.length > 0, `B claim overlapping -> ${claimB.status} (${claimB.conflicts?.[0]?.agentId})`);

    // A sibling surface does NOT conflict
    const claimB2 = await call(b, "claim", { surfaces: ["path:repo/src/db"], mode: "exclusive" });
    ok(claimB2.status === "granted", `B claim sibling repo/src/db -> ${claimB2.status}`);

    // Shared + shared coexist
    const s1 = await call(a, "claim", { surfaces: ["path:docs"], mode: "shared" });
    const s2 = await call(b, "claim", { surfaces: ["path:docs"], mode: "shared" });
    ok(s1.status === "granted" && s2.status === "granted", `shared+shared on docs both granted`);

    // --- Blocking claim: B queues on a held surface, grants when A releases ---
    const cxA = (await call(a, "claim", { surfaces: ["path:lock/x"], mode: "exclusive" })).claimId;
    const pB = call(b, "claim", { surfaces: ["path:lock/x"], mode: "exclusive", block: true, timeout_ms: 5000 });
    await sleep(300);
    await call(a, "release", { claim_id: cxA });
    const rB = await pB;
    ok(rB.status === "granted", `B blocking claim granted after A releases -> ${rB.status}`);
    await call(b, "release", { claim_id: rB.claimId });

    // --- Deadlock: A holds dl/a, B holds dl/b; B waits on dl/a, A claiming dl/b closes the cycle ---
    const cAa = (await call(a, "claim", { surfaces: ["path:dl/a"], mode: "exclusive" })).claimId;
    const cBb = (await call(b, "claim", { surfaces: ["path:dl/b"], mode: "exclusive" })).claimId;
    const pBwait = call(b, "claim", { surfaces: ["path:dl/a"], mode: "exclusive", block: true, timeout_ms: 5000 });
    await sleep(200);
    const dl = await call(a, "claim", { surfaces: ["path:dl/b"], mode: "exclusive", block: true, timeout_ms: 5000 });
    ok(dl.status === "deadlock" && dl.cycle?.length >= 2, `A claim closes cycle -> ${dl.status} (${(dl.cycle ?? []).join("→")})`);
    await call(a, "release", { claim_id: cAa });          // let B's queued claim proceed
    const rbw = await pBwait;
    ok(rbw.status === "granted", `B's queued claim grants after deadlock resolved -> ${rbw.status}`);
    await call(b, "release", { claim_id: rbw.claimId });
    await call(b, "release", { claim_id: cBb });

    // --- Facts (v1.5): write, corroborate, distinct, search, namespaces ---
    const f1 = await call(a, "fact_write", { namespace: "test", text: "The auth service uses JWT tokens.", tags: ["auth"] });
    ok(!!f1.fact_id && !f1.corroborated, `fact_write new -> ${f1.fact_id}`);
    const f2 = await call(a, "fact_write", { namespace: "test", text: "The auth service uses JWT tokens." });
    ok(f2.corroborated === true && f2.corroboration_count === 2, `fact_write identical -> corroborated x${f2.corroboration_count}`);
    const f3 = await call(a, "fact_write", { namespace: "test", text: "Postgres is the primary datastore." });
    ok(!!f3.fact_id && !f3.corroborated && f3.fact_id !== f1.fact_id, `fact_write distinct -> ${f3.fact_id}`);
    const fs = await call(a, "fact_search", { namespace: "test", query: "The auth service uses JWT tokens.", k: 3 });
    ok(fs.hits?.[0]?.id === f1.fact_id && fs.hits[0].distance < 0.01, `fact_search top hit is auth fact (d=${fs.hits?.[0]?.distance?.toFixed?.(3)})`);
    const ns = await call(a, "list_namespaces", {});
    const testNs = ns.namespaces?.find((n: any) => n.name === "test");
    ok(testNs?.fact_count === 2 && !!testNs?.embed_model, `namespace 'test' pinned to ${testNs?.embed_model}, ${testNs?.fact_count} active facts`);

    // Fact viz API (Namespace-scoped, over HTTP)
    const vizNs = await (await fetch(`http://localhost:${PORT}/api/namespaces`)).json();
    ok(vizNs.namespaces?.some((n: any) => n.name === "test"), `GET /api/namespaces lists 'test'`);
    const vizFacts = await (await fetch(`http://localhost:${PORT}/api/namespaces/test/facts`)).json();
    ok(vizFacts.facts?.length === 2 && vizFacts.facts[0].text != null, `GET /api/namespaces/test/facts -> ${vizFacts.facts?.length} facts`);
    const vizSearch = await (await fetch(`http://localhost:${PORT}/api/namespaces/test/search?q=${encodeURIComponent("JWT tokens")}&k=3`)).json();
    ok(vizSearch.hits?.[0]?.id === f1.fact_id, `GET /api/namespaces/test/search top hit is auth fact`);

    // Journal reflects the activity in seq order
    const jr = await call(a, "journal_read", {});
    const types = jr.entries.map((e: any) => e.type);
    ok(types.includes("claim.granted") && types.includes("blackboard.write"), `journal has claim.granted + blackboard.write (${jr.entries.length} entries)`);
    const seqs = jr.entries.map((e: any) => e.seq);
    ok(seqs.every((s: number, i: number) => i === 0 || s > seqs[i - 1]), `journal seq strictly increasing`);

    await a.close();
    await b.close();
  } finally {
    killServer();
    await sleep(200);
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { (await import("node:fs")).rmSync(f, { force: true }); } catch {} }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
