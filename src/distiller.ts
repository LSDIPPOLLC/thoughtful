// Distiller harness (ADR 0006). A standalone agent-side process — NOT part of
// the server, which stays model-agnostic. It watches the global run-lifecycle
// stream and, when a Run ends, reads that Run's frozen Journal + Blackboard,
// summarizes them into candidate Facts, and writes them via the fact_write MCP
// tool (deduped/corroborated by the server). Also supports one-shot mode.
//
//   watch:    tsx src/distiller.ts
//   one-shot: tsx src/distiller.ts <run_id>
//
// Env: MCP_URL (default http://localhost:8787/mcp), DISTILL_NAMESPACE
// (default "distilled"), SUMMARIZER (heuristic|minimax).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { summarizerFromEnv, type Summarizer } from "./summarizer.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const HTTP_BASE = process.env.HTTP_BASE ?? MCP_URL.replace(/\/mcp\/?$/, "");
const NAMESPACE = process.env.DISTILL_NAMESPACE ?? "distilled";

export interface Distiller {
  distillRun(runId: string): Promise<number>;
  /** Distill every ended Run not yet attributed in the namespace (missed-event recovery). */
  catchUp(): Promise<void>;
  watch(): Promise<void>;
  close(): Promise<void>;
}

export async function createDistiller(opts: {
  mcpUrl?: string; httpBase?: string; namespace?: string; summarizer?: Summarizer;
} = {}): Promise<Distiller> {
  const mcpUrl = opts.mcpUrl ?? MCP_URL;
  const httpBase = opts.httpBase ?? (mcpUrl === MCP_URL ? HTTP_BASE : mcpUrl.replace(/\/mcp\/?$/, ""));
  const namespace = opts.namespace ?? NAMESPACE;
  const summarizer = opts.summarizer ?? summarizerFromEnv();

  const client = new Client({ name: "distiller", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  const getJson = async (path: string) => (await fetch(`${httpBase}${path}`)).json() as any;

  async function distillRun(runId: string): Promise<number> {
    const [state, journal] = await Promise.all([
      getJson(`/api/runs/${runId}/state`),
      getJson(`/api/runs/${runId}/journal`),
    ]);
    if (!state?.run) { console.error(`[distiller] no such run ${runId}`); return 0; }

    const candidates = await summarizer.distill({
      runId,
      label: state.run.label ?? null,
      journal: journal.entries ?? [],
      blackboard: (state.blackboard ?? []).map((c: any) => ({ surface: c.surface, value: c.value, version: c.version })),
    });

    let written = 0;
    for (const c of candidates) {
      const r: any = await client.callTool({
        name: "fact_write",
        arguments: { namespace, text: c.text, tags: c.tags, source_run_id: runId, source_agent_id: "distiller" },
      });
      if (!r.isError) written++;
    }
    console.log(`[distiller] run ${runId} (${state.run.label ?? "—"}): ${candidates.length} candidates, ${written} written to '${namespace}' via ${summarizer.name}`);
    return written;
  }

  /**
   * Catch-up: distill any ended Run not yet attributed in the target namespace.
   * The live stream only delivers `run.ended` events while we're connected — a
   * Run that ends while the distiller is down would otherwise never be distilled.
   * "Already distilled" = some fact (active or superseded) carries the Run's id
   * as source_run_id; a Run whose every candidate merely corroborated existing
   * facts leaves no such row and may be re-distilled (harmless — server dedup).
   */
  async function catchUp(): Promise<void> {
    const { runs } = await getJson(`/api/runs`);
    for (const run of runs ?? []) {
      if (run.status !== "ended") continue;
      const { facts } = await getJson(
        `/api/namespaces/${encodeURIComponent(namespace)}/facts?superseded=1&source_run_id=${encodeURIComponent(run.id)}`);
      if (facts?.length) continue;
      console.log(`[distiller] catch-up: run ${run.id} ended while unwatched — distilling`);
      await distillRun(run.id).catch((e) => console.error("[distiller] catch-up", e));
    }
  }

  let stop = false;
  async function watch(): Promise<void> {
    console.log(`[distiller] watching ${httpBase}/api/events → namespace '${namespace}' (${summarizer.name})`);
    while (!stop) {
      try {
        const res = await fetch(`${httpBase}/api/events`);
        if (!res.body) throw new Error("no event stream");
        await catchUp().catch((e) => console.error("[distiller] catch-up failed:", (e as Error).message));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!stop) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = parseSSE(chunk);
            if (ev.event === "run.ended" && ev.data) {
              const runId = JSON.parse(ev.data).run_id;
              if (runId) distillRun(runId).catch((e) => console.error("[distiller]", e));
            }
          }
        }
      } catch (e) {
        if (stop) break;
        console.error("[distiller] event stream error, retrying in 2s:", (e as Error).message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async function close() { stop = true; await client.close(); }
  return { distillRun, catchUp, watch, close };
}

function parseSSE(chunk: string): { event?: string; data?: string } {
  let event: string | undefined, data: string | undefined;
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = (data ? data + "\n" : "") + line.slice(5).trim();
  }
  return { event, data };
}

// CLI entry: run directly (not when imported).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const runArg = process.argv[2];
  const d = await createDistiller();
  if (runArg) { await d.distillRun(runArg); await d.close(); process.exit(0); }
  else { await d.watch(); }
}
