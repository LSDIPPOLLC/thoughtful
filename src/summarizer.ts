// Summarizers turn a finished Run's Journal + final Blackboard into candidate
// Facts. Distillation is agent-side (ADR 0006) — the server never runs this. The
// interface is pluggable: a deterministic heuristic (default, no LLM, offline)
// and a real MiniMax chat summarizer.

export interface DistillInput {
  runId: string;
  label: string | null;
  journal: { seq: number; agent_id: string | null; type: string; surface: string | null; payload: any }[];
  blackboard: { surface: string; value: any; version: number }[];
}

export interface Candidate { text: string; tags: string[] }

export interface Summarizer {
  readonly name: string;
  distill(input: DistillInput): Promise<Candidate[]>;
}

// System event types the heuristic ignores (they are coordination noise, not
// knowledge). Everything else in the Journal is an agent-authored entry.
const SYSTEM_TYPES = new Set([
  "claim.granted", "claim.denied", "claim.released", "claim.expired", "claim.queued",
  "claim.deadlock", "blackboard.write", "agent.joined", "agent.left", "run.ended",
]);

/**
 * Deterministic, no-LLM distiller (default). Promotes explicit agent entries
 * (notes/decisions/findings an agent journaled) and final Blackboard state into
 * Facts. Not generative, but a genuinely useful baseline and fully testable.
 */
export class HeuristicSummarizer implements Summarizer {
  readonly name = "heuristic-v1";

  async distill(input: DistillInput): Promise<Candidate[]> {
    const baseTags = ["distilled", ...(input.label ? [input.label] : [])];
    const out: Candidate[] = [];

    for (const e of input.journal) {
      if (SYSTEM_TYPES.has(e.type)) continue;
      const body = e.payload?.text ?? e.payload?.msg ?? e.payload?.note ??
        (typeof e.payload === "string" ? e.payload : null);
      if (!body) continue;
      out.push({ text: String(body), tags: [...baseTags, e.type] });
    }

    for (const c of input.blackboard) {
      out.push({ text: `Final state of ${c.surface}: ${JSON.stringify(c.value)}`, tags: [...baseTags, "blackboard"] });
    }

    // Dedup identical candidate text.
    const seen = new Set<string>();
    return out.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)));
  }
}

/**
 * Real generative distiller via MiniMax chat. Needs MINIMAX_API_KEY. Prompts the
 * model to emit a JSON array of {text, tags}. Untested here (no creds in CI); the
 * heuristic is the default so the harness runs offline.
 */
export class MiniMaxSummarizer implements Summarizer {
  readonly name = "minimax-chat";
  constructor(private apiKey: string, private model = process.env.MINIMAX_MODEL ?? "MiniMax-Text-01") {}

  async distill(input: DistillInput): Promise<Candidate[]> {
    const journal = input.journal
      .map((e) => `#${e.seq} [${e.type}] ${e.agent_id ?? ""} ${e.surface ?? ""} ${JSON.stringify(e.payload ?? {})}`)
      .join("\n");
    const board = input.blackboard.map((c) => `${c.surface} = ${JSON.stringify(c.value)}`).join("\n");
    const sys = "You distill durable, reusable facts from an AI agent run. Extract only knowledge worth " +
      "remembering across future runs (decisions, findings, stable configuration). Ignore coordination noise. " +
      'Respond ONLY with a JSON array of objects: [{"text": "...", "tags": ["..."]}].';
    const user = `Run: ${input.label ?? input.runId}\n\nJOURNAL:\n${journal}\n\nFINAL BLACKBOARD:\n${board}`;

    const res = await fetch("https://api.minimax.chat/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`minimax chat failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    const content: string = json.choices?.[0]?.message?.content ?? "[]";
    const match = content.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : "[]");
    return (Array.isArray(parsed) ? parsed : [])
      .filter((c: any) => c && typeof c.text === "string")
      .map((c: any) => ({ text: c.text, tags: Array.isArray(c.tags) ? c.tags.map(String) : ["distilled"] }));
  }
}

export function summarizerFromEnv(): Summarizer {
  const which = (process.env.SUMMARIZER ?? "heuristic").toLowerCase();
  if (which === "minimax") {
    const key = process.env.MINIMAX_API_KEY;
    if (!key) throw new Error("SUMMARIZER=minimax requires MINIMAX_API_KEY");
    return new MiniMaxSummarizer(key);
  }
  return new HeuristicSummarizer();
}
