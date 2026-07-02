import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./store.js";
import type { LockManager } from "./lockManager.js";
import type { FactStore } from "./factStore.js";
import type { SessionCtx } from "./types.js";
import { parseSurface, surfaceToString } from "./surface.js";

export interface Core {
  store: Store;
  lock: LockManager;
  facts: FactStore;
}

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });

/** Machine-readable tool errors: `{ code, message }` so clients never string-match. */
export type ErrCode =
  | "NOT_IN_RUN" | "NO_SUCH_RUN" | "RUN_ENDED" | "RUN_ACTIVE"
  | "NO_CLAIM" | "NOT_OWNER" | "VERSION_CONFLICT" | "PAYLOAD_TOO_LARGE" | "FACT_ERROR";
const err = (code: ErrCode, msg: string) =>
  ({ content: [{ type: "text" as const, text: JSON.stringify({ code, message: msg }) }], isError: true });

// Serialized-size cap for agent-authored blobs (blackboard values, journal
// payloads). DESIGN §11 flagged unbounded cells; this is the enforcement.
const MAX_BLOB_BYTES = 256 * 1024;
/** JSON-encode defensively: rejects circular structures and oversized blobs. */
const checkBlob = (v: unknown): ErrCode | null => {
  try {
    const s = JSON.stringify(v);
    if (s !== undefined && Buffer.byteLength(s) > MAX_BLOB_BYTES) return "PAYLOAD_TOO_LARGE";
    return null;
  } catch { return "PAYLOAD_TOO_LARGE"; }
};

// setTimeout overflows past 2^31-1 ms and fires immediately — clamp well below.
const MAX_TTL_MS = 86_400_000;      // 24h lease ceiling
const MAX_TIMEOUT_MS = 600_000;     // 10min blocking-claim long-poll ceiling

/**
 * Build a fresh McpServer for one agent session (the SDK pairs McpServer 1:1
 * with a transport). Tools close over the shared `core` and this session's
 * mutable `ctx` — so `agent_id`/`run_id` are session-bound (ADR 0003).
 */
export function buildMcpServer(core: Core, ctx: SessionCtx): McpServer {
  const { store, lock, facts } = core;
  const server = new McpServer({ name: "thoughtful", version: "0.1.0" });

  const requireAgent = (): { runId: string; agentId: string } => {
    if (!ctx.runId || !ctx.agentId) throw new Error("NOT_IN_RUN: not in a run — call join_run first");
    return { runId: ctx.runId, agentId: ctx.agentId };
  };

  /** Mutations (claim, bb_write, journal_append) require the Run to still be active — ended Runs are frozen. */
  const requireActiveRun = async (): Promise<{ runId: string; agentId: string } | ReturnType<typeof err>> => {
    const ids = requireAgent();
    const run = await store.getRun(ids.runId);
    if (!run) return err("NO_SUCH_RUN", `no such run: ${ids.runId}`);
    if (run.status !== "active") return err("RUN_ENDED", `run ${ids.runId} is ended — Blackboard and Journal are frozen`);
    return ids;
  };
  const isErr = (r: unknown): r is ReturnType<typeof err> => !!(r as any)?.isError;

  // ---- Run / identity ---------------------------------------------------
  server.registerTool("create_run",
    { description: "Open a new Run (top-level collaboration grouping).", inputSchema: { label: z.string().optional() } },
    async ({ label }) => text({ run_id: store.createRun(label).id }));

  server.registerTool("join_run",
    { description: "Register into a Run; returns a server-issued agent_id bound to this session.",
      inputSchema: { run_id: z.string(), label: z.string().optional() } },
    async ({ run_id, label }) => {
      const run = await store.getRun(run_id);
      if (!run) return err("NO_SUCH_RUN", `no such run: ${run_id}`);
      if (run.status !== "active") return err("RUN_ENDED", `run ${run_id} is ended`);
      const agent = store.joinRun(run_id, ctx.sessionId, label);
      ctx.agentId = agent.id;
      ctx.runId = run_id;
      return text({ agent_id: agent.id, run_id });
    });

  server.registerTool("list_runs",
    { description: "List all Runs, newest first.", inputSchema: {} },
    async () => text({ runs: await store.listRuns() }));

  server.registerTool("whoami",
    { description: "Return this session's agent_id and run_id.", inputSchema: {} },
    async () => text({ agent_id: ctx.agentId ?? null, run_id: ctx.runId ?? null }));

  server.registerTool("end_run",
    { description: "End a Run: release its Claims, freeze Blackboard + Journal.", inputSchema: { run_id: z.string().optional() } },
    async ({ run_id }) => {
      const id = run_id ?? ctx.runId;
      if (!id) return err("NOT_IN_RUN", "no run_id and session not in a run");
      lock.releaseByRun(id);
      store.endRun(id);
      store.journal(id, ctx.agentId ?? null, "run.ended", null, {});
      return text({ ok: true, run_id: id });
    });

  server.registerTool("purge_run",
    { description: "Permanently delete an ENDED Run and all its data. Pass force=true to purge a still-active Run.",
      inputSchema: { run_id: z.string(), force: z.boolean().default(false) } },
    async ({ run_id, force }) => {
      const run = await store.getRun(run_id);
      if (!run) return err("NO_SUCH_RUN", `no such run: ${run_id}`);
      if (run.status === "active" && !force) {
        return err("RUN_ACTIVE", `run ${run_id} is still active — end_run it first, or pass force=true`);
      }
      lock.releaseByRun(run_id);
      store.purgeRun(run_id);
      return text({ ok: true, run_id });
    });

  // ---- Claims -----------------------------------------------------------
  server.registerTool("claim",
    { description: "Pre-flight claim a bundle of Surfaces (atomic). mode: shared|exclusive. " +
        "Surfaces are strings like 'path:repo/src/auth' or 'entity:user:123'. block=true long-polls.",
      inputSchema: {
        surfaces: z.array(z.string()).min(1).max(32),
        mode: z.enum(["shared", "exclusive"]).default("exclusive"),
        ttl_ms: z.number().int().positive().max(MAX_TTL_MS).default(30_000),
        block: z.boolean().default(false),
        timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).default(15_000),
      } },
    async ({ surfaces, mode, ttl_ms, block, timeout_ms }) => {
      const ids = await requireActiveRun();
      if (isErr(ids)) return ids;
      const parsed = surfaces.map(parseSurface);
      const res = await lock.claim(ids.runId, ids.agentId, parsed, mode, ttl_ms, block, timeout_ms);
      return text(res);
    });

  server.registerTool("renew",
    { description: "Heartbeat: extend a held Claim's lease. Only the holding agent may renew.",
      inputSchema: { claim_id: z.string(), ttl_ms: z.number().int().positive().max(MAX_TTL_MS).default(30_000) } },
    async ({ claim_id, ttl_ms }) => {
      const { agentId } = requireAgent();
      return text({ ok: lock.renew(claim_id, ttl_ms, agentId) });
    });

  server.registerTool("release",
    { description: "Release a held Claim early (the normal path; Leases are the crash net). Only the holding agent may release.",
      inputSchema: { claim_id: z.string() } },
    async ({ claim_id }) => {
      const { agentId } = requireAgent();
      return text({ ok: lock.release(claim_id, agentId) });
    });

  // ---- Blackboard -------------------------------------------------------
  server.registerTool("bb_read",
    { description: "Read Blackboard cells. Pass `surface` for exact, or `prefix` for a path-subtree survey.",
      inputSchema: { surface: z.string().optional(), prefix: z.string().optional() } },
    async ({ surface, prefix }) => {
      const { runId } = requireAgent();
      const exact = surface ? surfaceToString(parseSurface(surface)) : undefined;
      const pfx = prefix ? surfaceToString(parseSurface(prefix)) : undefined;
      return text({ cells: await store.bbRead(runId, exact, pfx) });
    });

  server.registerTool("bb_write",
    { description: "Write a Blackboard cell. Requires a live EXCLUSIVE Claim covering the Surface (enforced). " +
        "Optional expected_version → conflict if stale.",
      inputSchema: { surface: z.string(), value: z.unknown(), expected_version: z.number().int().optional() } },
    async ({ surface, value, expected_version }) => {
      const ids = await requireActiveRun();
      if (isErr(ids)) return ids;
      const { runId, agentId } = ids;
      const s = parseSurface(surface);
      const key = surfaceToString(s);
      const tooBig = checkBlob(value);
      if (tooBig) return err(tooBig, `value rejected: not JSON-serializable or exceeds ${MAX_BLOB_BYTES} bytes`);
      if (!lock.holdsExclusiveCovering(runId, agentId, s)) {
        return err("NO_CLAIM", `write rejected: no live exclusive claim covering ${key}`);
      }
      if (expected_version != null) {
        const have = await store.bbCurrentVersion(runId, key);
        if (have !== expected_version) return err("VERSION_CONFLICT", `version conflict on ${key}: expected ${expected_version}, have ${have}`);
      }
      return text({ version: await store.bbWrite(runId, key, value, agentId) });
    });

  // ---- Journal ----------------------------------------------------------
  server.registerTool("journal_append",
    { description: "Append a free-form entry to the Run's Journal.",
      inputSchema: { type: z.string(), payload: z.unknown().optional(), surface: z.string().optional() } },
    async ({ type, payload, surface }) => {
      const ids = await requireActiveRun();
      if (isErr(ids)) return ids;
      const tooBig = checkBlob(payload ?? {});
      if (tooBig) return err(tooBig, `payload rejected: not JSON-serializable or exceeds ${MAX_BLOB_BYTES} bytes`);
      const s = surface ? surfaceToString(parseSurface(surface)) : null;
      const e = store.journal(ids.runId, ids.agentId, type, s, payload ?? {});
      return text({ seq: e.seq });
    });

  server.registerTool("journal_read",
    { description: "Read the Run's Journal in seq order, with optional filters.",
      inputSchema: { since_seq: z.number().int().optional(), agent_id: z.string().optional(), type: z.string().optional(), surface: z.string().optional() } },
    async ({ since_seq, agent_id, type, surface }) => {
      const { runId } = requireAgent();
      return text({ entries: await store.readJournal(runId, { sinceSeq: since_seq, agentId: agent_id, type, surface }) });
    });

  // ---- Facts (v1.5) -----------------------------------------------------
  // Facts outlive Runs, so these do NOT require an active Run. Provenance is
  // auto-filled from the session if the caller happens to be in one.
  server.registerTool("fact_write",
    { description: "Write a durable Fact into a Namespace. Deduped: near-identical text corroborates, " +
        "an update supersedes. Provenance auto-filled from the session; a distiller may pass " +
        "source_run_id to attribute a Fact to the Run it was distilled from.",
      inputSchema: {
        namespace: z.string(), text: z.string(), tags: z.array(z.string()).optional(),
        source_run_id: z.string().optional(), source_agent_id: z.string().optional(),
      } },
    async ({ namespace, text: body, tags, source_run_id, source_agent_id }) => {
      try {
        return text(await facts.write(namespace, body, tags ?? [],
          source_run_id ?? ctx.runId ?? null, source_agent_id ?? ctx.agentId ?? null));
      } catch (e) { return err("FACT_ERROR", (e as Error).message); }
    });

  server.registerTool("fact_search",
    { description: "Semantic search over active Facts in a Namespace (brute-force filtered cosine scan).",
      inputSchema: {
        namespace: z.string(), query: z.string(), k: z.number().int().positive().default(5),
        tags: z.array(z.string()).optional(), min_corroboration: z.number().int().optional(),
      } },
    async ({ namespace, query, k, tags, min_corroboration }) => {
      try {
        return text({ hits: await facts.search(namespace, query, k, { tags, minCorroboration: min_corroboration }) });
      } catch (e) { return err("FACT_ERROR", (e as Error).message); }
    });

  server.registerTool("list_namespaces",
    { description: "List Fact Namespaces with their pinned embed model and active fact count.", inputSchema: {} },
    async () => text({ namespaces: await facts.listNamespaces() }));

  return server;
}
