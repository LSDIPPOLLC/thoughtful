import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bus } from "./bus.js";
import { buildMcpServer, type Core } from "./mcp.js";
import type { SessionCtx } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRACE_MS = Number(process.env.GRACE_MS ?? 10_000); // last-agent-disconnect auto-end grace

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  ctx: SessionCtx;
}

export function startServer(core: Core, port: number) {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  const sessions = new Map<string, Session>();

  // Auto-end a Run a grace period after its last agent disconnects (ADR 0008).
  const scheduleAutoEnd = (runId: string) => {
    setTimeout(async () => {
      const run = await core.store.getRun(runId);
      if (run?.status === "active" && (await core.store.activeAgentCount(runId)) === 0) {
        core.lock.releaseByRun(runId);
        core.store.endRun(runId);
        core.store.journal(runId, null, "run.ended", null, { reason: "last agent disconnected" });
      }
    }, GRACE_MS);
  };

  // ---- MCP endpoint (one transport per agent session) -------------------
  app.post("/mcp", async (req: Request, res: Response) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid && sessions.has(sid)) {
      await sessions.get(sid)!.transport.handleRequest(req, res, req.body);
      return;
    }
    if (!sid && isInitializeRequest(req.body)) {
      const ctx: SessionCtx = { sessionId: "" };
      const server = buildMcpServer(core, ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          ctx.sessionId = id;
          sessions.set(id, { transport, server, ctx });
        },
      });
      transport.onclose = () => {
        if (!ctx.sessionId) return;
        sessions.delete(ctx.sessionId);
        if (ctx.agentId && ctx.runId) {
          core.lock.releaseByAgent(ctx.agentId);        // session = liveness (ADR 0003)
          core.store.leaveAgent(ctx.runId, ctx.agentId);
          scheduleAutoEnd(ctx.runId);
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).json({ error: "no valid session; send an initialize request first" });
  });

  const sessionReq = async (req: Request, res: Response) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (!sid || !sessions.has(sid)) { res.status(400).send("unknown session"); return; }
    await sessions.get(sid)!.transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionReq);     // server -> client stream
  app.delete("/mcp", sessionReq);  // explicit termination

  // ---- Read-only viz API ------------------------------------------------
  app.get("/api/health", (_req, res) => res.json({
    ok: core.store.journalWriteFailures === 0,
    journal_write_failures: core.store.journalWriteFailures,
    sessions: sessions.size,
  }));

  app.get("/api/runs", async (_req, res) => res.json({ runs: await core.store.listRuns() }));

  app.get("/api/runs/:id/state", async (req, res) => {
    const id = req.params.id;
    const run = await core.store.getRun(id);
    if (!run) { res.status(404).json({ error: "no such run" }); return; }
    res.json({
      run,
      agents: await core.store.listAgents(id),
      blackboard: await core.store.bbRead(id),
      lock: core.lock.snapshot(id),
    });
  });

  app.get("/api/runs/:id/journal", async (req, res) => {
    const since = req.query.since ? Number(req.query.since) : undefined;
    res.json({ entries: await core.store.readJournal(req.params.id, { sinceSeq: since }) });
  });

  // ---- Facts (v1.5) viz API — Namespace-scoped, cross-Run --------------
  app.get("/api/namespaces", async (_req, res) => res.json({ namespaces: await core.facts.listNamespaces() }));

  app.get("/api/namespaces/:name/facts", async (req, res) => {
    const includeSuperseded = req.query.superseded === "1";
    const sourceRunId = req.query.source_run_id ? String(req.query.source_run_id) : undefined;
    res.json({ facts: await core.facts.listFacts(req.params.name, includeSuperseded, sourceRunId) });
  });

  app.get("/api/namespaces/:name/search", async (req, res) => {
    const q = String(req.query.q ?? "");
    if (!q) { res.json({ hits: [] }); return; }
    const k = req.query.k ? Number(req.query.k) : 10;
    try {
      res.json({ hits: await core.facts.search(req.params.name, q, k) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Global run-lifecycle stream — a distiller subscribes here and distills each
  // Run when it ends (ADR 0006; "auto" distillation is a convention, not server
  // magic). Emits `run.ended` events across all Runs.
  // Heartbeat comment so idle proxies don't silently kill SSE streams.
  const SSE_HEARTBEAT_MS = 25_000;

  app.get("/api/events", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: hello\ndata: {}\n\n`);
    const onJournal = (e: any) => {
      if (e.type === "run.ended") res.write(`event: run.ended\ndata: ${JSON.stringify({ run_id: e.run_id })}\n\n`);
    };
    const beat = setInterval(() => res.write(`: hb\n\n`), SSE_HEARTBEAT_MS);
    bus.on("journal", onJournal);
    _req.on("close", () => { clearInterval(beat); bus.off("journal", onJournal); });
  });

  // Live tail via SSE — pushed straight from the in-process bus, no polling.
  app.get("/api/runs/:id/stream", (req, res) => {
    const id = req.params.id;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ run: id })}\n\n`);
    const onJournal = (e: unknown) => res.write(`event: journal\ndata: ${JSON.stringify(e)}\n\n`);
    const onState = () => res.write(`event: state\ndata: {}\n\n`);
    const beat = setInterval(() => res.write(`: hb\n\n`), SSE_HEARTBEAT_MS);
    bus.on(`journal:${id}`, onJournal);
    bus.on(`state:${id}`, onState);
    req.on("close", () => {
      clearInterval(beat);
      bus.off(`journal:${id}`, onJournal);
      bus.off(`state:${id}`, onState);
    });
  });

  // ---- Static viz SPA + vendored libs (served locally, offline) ---------
  app.use("/vendor", express.static(join(__dirname, "..", "node_modules", "cytoscape", "dist")));
  app.use(express.static(join(__dirname, "..", "web")));

  app.listen(port, () => {
    console.log(`thoughtful: MCP at http://localhost:${port}/mcp — viz at http://localhost:${port}/`);
  });
}
