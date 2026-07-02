// Behavior-coverage suite (node:test): the paths smoke.ts doesn't exercise —
// lease expiry, renew + ownership, disconnect reclaim, auto-end, purge guard,
// frozen runs, journal filters, expected_version, prefix reads, supersede,
// search filters, SSE endpoints, 3-agent deadlock, distiller catch-up.
// Run: npx tsx test/coverage.ts   (boots one server on a scratch DB)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDistiller } from "../src/distiller.js";

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const DB = `.coverage-${process.pid}.db`;
const GRACE_MS = 300;

let server: ReturnType<typeof spawn>;
const clients: Client[] = [];
const transports = new Map<Client, StreamableHTTPClientTransport>();

async function connect(): Promise<Client> {
  const c = new Client({ name: "coverage", version: "0.0.0" });
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await c.connect(t);
  clients.push(c);
  transports.set(c, t);
  return c;
}

/** Clean disconnect: DELETE the session (fires server-side onclose), then close. */
async function disconnect(c: Client): Promise<void> {
  await transports.get(c)!.terminateSession();
  await c.close();
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const txt = r.content?.[0]?.text ?? "{}";
  const body = (() => { try { return JSON.parse(txt); } catch { return { raw: txt }; } })();
  return { ...body, _isError: !!r.isError };
}

/** New run with `n` joined agents; returns [runId, ...clients]. */
async function runWith(n: number, label: string): Promise<{ runId: string; agents: Client[] }> {
  const first = await connect();
  const runId = (await call(first, "create_run", { label })).run_id;
  const agents: Client[] = [first];
  await call(first, "join_run", { run_id: runId, label: `${label}-0` });
  for (let i = 1; i < n; i++) {
    const c = await connect();
    await call(c, "join_run", { run_id: runId, label: `${label}-${i}` });
    agents.push(c);
  }
  return { runId, agents };
}

before(async () => {
  server = spawn("npx", ["tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, EMBED_PROVIDER: "local", GRACE_MS: String(GRACE_MS) },
    stdio: "inherit", detached: true,
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/runs`); return; } catch { await sleep(200); }
  }
  throw new Error("server did not start");
});

after(async () => {
  for (const c of clients) { try { await c.close(); } catch {} }
  try { process.kill(-server.pid!, "SIGKILL"); } catch { server.kill("SIGKILL"); }
  await sleep(200);
  const { rmSync } = await import("node:fs");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
});

test("lease expiry frees the surface and journals claim.expired", async () => {
  const { runId, agents: [a, b] } = await runWith(2, "expiry");
  const c = await call(a, "claim", { surfaces: ["path:exp/x"], ttl_ms: 400 });
  assert.equal(c.status, "granted");
  await sleep(700); // lease lapses, no renew
  const cb = await call(b, "claim", { surfaces: ["path:exp/x"] });
  assert.equal(cb.status, "granted");
  const jr = await call(a, "journal_read", { type: "claim.expired" });
  assert.ok(jr.entries.length >= 1, "journal has claim.expired");
  await call(a, "end_run", { run_id: runId });
});

test("renew extends a lease past its original TTL", async () => {
  const { runId, agents: [a, b] } = await runWith(2, "renew");
  const c = await call(a, "claim", { surfaces: ["path:rn/x"], ttl_ms: 600 });
  await sleep(300);
  assert.deepEqual((await call(a, "renew", { claim_id: c.claimId, ttl_ms: 5000 })).ok, true);
  await sleep(600); // past original expiry — still held because renewed
  const cb = await call(b, "claim", { surfaces: ["path:rn/x"] });
  assert.equal(cb.status, "denied");
  await call(a, "end_run", { run_id: runId });
});

test("renew/release are owner-only", async () => {
  const { runId, agents: [a, b] } = await runWith(2, "owner");
  const c = await call(a, "claim", { surfaces: ["path:own/x"] });
  assert.equal((await call(b, "renew", { claim_id: c.claimId })).ok, false, "non-owner renew rejected");
  assert.equal((await call(b, "release", { claim_id: c.claimId })).ok, false, "non-owner release rejected");
  assert.equal((await call(a, "release", { claim_id: c.claimId })).ok, true, "owner release works");
  await call(a, "end_run", { run_id: runId });
});

test("ttl_ms above the clamp is rejected at the schema", async () => {
  const { runId, agents: [a] } = await runWith(1, "clamp");
  const r = await call(a, "claim", { surfaces: ["path:cl/x"], ttl_ms: 2 ** 31 });
  assert.equal(r._isError, true);
  await call(a, "end_run", { run_id: runId });
});

test("bb_write expected_version conflict + prefix survey", async () => {
  const { runId, agents: [a] } = await runWith(1, "bb");
  await call(a, "claim", { surfaces: ["path:app"] });
  assert.equal((await call(a, "bb_write", { surface: "path:app/a", value: 1 })).version, 1);
  await call(a, "bb_write", { surface: "path:app/b/c", value: 2 });
  const conflict = await call(a, "bb_write", { surface: "path:app/a", value: 9, expected_version: 0 });
  assert.equal(conflict._isError, true);
  assert.equal(conflict.code, "VERSION_CONFLICT");
  assert.equal((await call(a, "bb_write", { surface: "path:app/a", value: 9, expected_version: 1 })).version, 2);
  const survey = await call(a, "bb_read", { prefix: "path:app" });
  assert.equal(survey.cells.length, 2, "prefix survey finds the subtree");
  const exact = await call(a, "bb_read", { surface: "path:app/a" });
  assert.equal(exact.cells.length, 1);
  await call(a, "end_run", { run_id: runId });
});

test("oversized blackboard value is rejected with PAYLOAD_TOO_LARGE", async () => {
  const { runId, agents: [a] } = await runWith(1, "big");
  await call(a, "claim", { surfaces: ["path:big"] });
  const r = await call(a, "bb_write", { surface: "path:big/x", value: "x".repeat(300 * 1024) });
  assert.equal(r._isError, true);
  assert.equal(r.code, "PAYLOAD_TOO_LARGE");
  await call(a, "end_run", { run_id: runId });
});

test("journal_read filters: type, agent_id, since_seq, surface", async () => {
  const { runId, agents: [a, b] } = await runWith(2, "jf");
  const aid = (await call(a, "whoami", {})).agent_id;
  const s1 = (await call(a, "journal_append", { type: "note", payload: { n: 1 }, surface: "path:x" })).seq;
  await call(a, "journal_append", { type: "todo", payload: { n: 2 } });
  await call(b, "journal_append", { type: "note", payload: { n: 3 } });
  const byType = await call(a, "journal_read", { type: "note" });
  assert.equal(byType.entries.length, 2);
  const byAgent = await call(a, "journal_read", { agent_id: aid, type: "note" });
  assert.equal(byAgent.entries.length, 1);
  const since = await call(a, "journal_read", { since_seq: s1, type: "note" });
  assert.equal(since.entries.length, 1);
  const bySurface = await call(a, "journal_read", { surface: "path:x" });
  assert.ok(bySurface.entries.every((e: any) => e.surface === "path:x") && bySurface.entries.length >= 1);
  await call(a, "end_run", { run_id: runId });
});

test("ended runs are frozen: journal_append and claim are rejected", async () => {
  const { runId, agents: [a] } = await runWith(1, "frozen");
  await call(a, "end_run", { run_id: runId });
  const j = await call(a, "journal_append", { type: "note", payload: { late: true } });
  assert.equal(j.code, "RUN_ENDED");
  const c = await call(a, "claim", { surfaces: ["path:late"] });
  assert.equal(c.code, "RUN_ENDED");
  const jr = await call(a, "journal_read", {}); // reads still allowed (replay)
  assert.ok(jr.entries.length >= 1);
});

test("purge_run guards active runs; purges ended ones", async () => {
  const { runId, agents: [a] } = await runWith(1, "purge");
  const denied = await call(a, "purge_run", { run_id: runId });
  assert.equal(denied.code, "RUN_ACTIVE");
  await call(a, "end_run", { run_id: runId });
  assert.equal((await call(a, "purge_run", { run_id: runId })).ok, true);
  const res = await fetch(`${BASE}/api/runs/${runId}/state`);
  assert.equal(res.status, 404, "purged run is gone");
});

test("disconnect reclaims the agent's claims", async () => {
  const { runId, agents: [a, b] } = await runWith(2, "reclaim");
  const c = await call(a, "claim", { surfaces: ["path:rc/x"], ttl_ms: 60_000 });
  assert.equal(c.status, "granted");
  await disconnect(a);
  await sleep(500); // session termination → releaseByAgent
  const cb = await call(b, "claim", { surfaces: ["path:rc/x"] });
  assert.equal(cb.status, "granted", "surface freed by disconnect, not TTL");
  await call(b, "end_run", { run_id: runId });
});

test("run auto-ends after the last agent disconnects (grace period)", async () => {
  const { runId, agents: [a] } = await runWith(1, "autoend");
  await disconnect(a);
  await sleep(GRACE_MS + 700);
  const { run } = await (await fetch(`${BASE}/api/runs/${runId}/state`)).json();
  assert.equal(run.status, "ended");
});

test("near-duplicate fact supersedes; search filters by tags and corroboration", async () => {
  const c = await connect();
  const ns = "coverage-facts";
  const base = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike " +
    "november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
  const f1 = await call(c, "fact_write", { namespace: ns, text: `${base} one`, tags: ["x"] });
  assert.ok(f1.fact_id && !f1.corroborated);
  // one token changed out of ~27 → cosine ≈ 0.96 on the hash embedder: supersede window [T, T2)
  const f2 = await call(c, "fact_write", { namespace: ns, text: `${base} two`, tags: ["x"] });
  assert.equal(f2.superseded_id, f1.fact_id, "near-duplicate superseded the original");
  const f3 = await call(c, "fact_write", { namespace: ns, text: "completely different: postgres runs on port 5432", tags: ["x", "y"] });
  await call(c, "fact_write", { namespace: ns, text: "completely different: postgres runs on port 5432" }); // corroborate f3
  const byTags = await call(c, "fact_search", { namespace: ns, query: "postgres port", k: 10, tags: ["x", "y"] });
  assert.deepEqual(byTags.hits.map((h: any) => h.id), [f3.fact_id], "tags filter");
  const byCorr = await call(c, "fact_search", { namespace: ns, query: "anything", k: 10, min_corroboration: 2 });
  assert.deepEqual(byCorr.hits.map((h: any) => h.id), [f3.fact_id], "min_corroboration filter");
  const withSup = await (await fetch(`${BASE}/api/namespaces/${ns}/facts?superseded=1`)).json();
  assert.ok(withSup.facts.some((f: any) => f.id === f1.fact_id && f.superseded), "superseded fact listed with ?superseded=1");
});

test("3-agent deadlock cycle is detected and rejected", async () => {
  const { runId, agents: [a, b, c] } = await runWith(3, "dl3");
  await call(a, "claim", { surfaces: ["path:d3/a"] });
  await call(b, "claim", { surfaces: ["path:d3/b"] });
  const cc = await call(c, "claim", { surfaces: ["path:d3/c"] });
  const pA = call(a, "claim", { surfaces: ["path:d3/b"], block: true, timeout_ms: 5000 }); // A → B
  const pB = call(b, "claim", { surfaces: ["path:d3/c"], block: true, timeout_ms: 5000 }); // B → C
  await sleep(300);
  const dl = await call(c, "claim", { surfaces: ["path:d3/a"], block: true, timeout_ms: 5000 }); // C → A closes it
  assert.equal(dl.status, "deadlock");
  assert.ok(dl.cycle.length >= 3, `cycle spans 3 agents: ${dl.cycle?.join("→")}`);
  await call(c, "release", { claim_id: cc.claimId }); // unwind: B grants, then A
  assert.equal((await pB).status, "granted");
  await call(b, "end_run", { run_id: runId }); // releases everything incl. A's wait
  await pA;
});

test("SSE: run stream delivers journal events; global stream delivers run.ended", async () => {
  const { runId, agents: [a] } = await runWith(1, "sse");
  const events: string[] = [];
  const ac = new AbortController();
  const streamDone = (async () => {
    const res = await fetch(`${BASE}/api/runs/${runId}/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const m of buf.matchAll(/event: (\S+)/g)) events.push(m[1]);
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      if (events.includes("journal")) break;
    }
  })().catch(() => {});
  await sleep(200);
  await call(a, "journal_append", { type: "note", payload: { sse: true } });
  await sleep(500);
  assert.ok(events.includes("journal"), `run stream delivered journal event (saw: ${events.join(",")})`);

  const global: string[] = [];
  const globalDone = (async () => {
    const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!global.includes("run.ended")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const m of buf.matchAll(/event: (\S+)/g)) global.push(m[1]);
    }
  })().catch(() => {});
  await sleep(200);
  await call(a, "end_run", { run_id: runId });
  await sleep(500);
  assert.ok(global.includes("run.ended"), `global stream delivered run.ended (saw: ${global.join(",")})`);
  ac.abort();
  await Promise.allSettled([streamDone, globalDone]);
});

test("distiller catch-up distills runs that ended while unwatched, idempotently", async () => {
  const ns = "coverage-catchup";
  const { runId, agents: [a] } = await runWith(1, "catchup");
  await call(a, "claim", { surfaces: ["path:cu"] });
  await call(a, "bb_write", { surface: "path:cu/state", value: { done: true } });
  await call(a, "journal_append", { type: "note", payload: { note: "the deploy uses blue-green rollout" } });
  await call(a, "end_run", { run_id: runId }); // ends BEFORE any distiller is watching
  const d = await createDistiller({ mcpUrl: `${BASE}/mcp`, namespace: ns });
  try {
    await d.catchUp();
    const { facts } = await (await fetch(`${BASE}/api/namespaces/${ns}/facts?superseded=1&source_run_id=${runId}`)).json();
    assert.ok(facts.length >= 2, `catch-up wrote facts for the missed run (${facts.length})`);
    await d.catchUp(); // second pass must not duplicate
    const again = await (await fetch(`${BASE}/api/namespaces/${ns}/facts?superseded=1&source_run_id=${runId}`)).json();
    assert.equal(again.facts.length, facts.length, "catch-up is idempotent");
  } finally { await d.close(); }
});

test("/api/health reports no journal write failures", async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.journal_write_failures, 0);
});
