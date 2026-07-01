// Core domain types for the v1 coordination spine.
// Glossary lives in CONTEXT.md; decisions in docs/adr/.

export type SurfaceKind = "path" | "entity";

/**
 * A Surface — the unit two agents can collide on.
 * - path:   hierarchical string, overlap = prefix relation (ancestor/descendant).
 * - entity: typed id `type:id`, overlap = exact match.
 * Canonical string form: `path:<key>` or `entity:<type>:<id>`.
 */
export interface Surface {
  kind: SurfaceKind;
  /** For path: the slash-delimited key. For entity: `<type>:<id>`. */
  key: string;
}

export type ClaimMode = "shared" | "exclusive";

export type ClaimStatus = "granted" | "queued" | "denied" | "deadlock";

/** An active, granted Claim held in the in-memory lock manager (ADR 0003). */
export interface Claim {
  id: string;
  runId: string;
  agentId: string;
  mode: ClaimMode;
  surfaces: Surface[];
  ttlMs: number;
  /** epoch ms; the lease expiry. */
  expiresAt: number;
}

export interface ClaimResult {
  status: ClaimStatus;
  claimId?: string;
  /** On denied/queued/deadlock: the agents/surfaces we conflict with. */
  conflicts?: { agentId: string; surface: string; mode: ClaimMode }[];
  /** On deadlock: the cycle of agentIds. */
  cycle?: string[];
}

export interface RunRow {
  id: string;
  label: string | null;
  status: "active" | "ended";
  created_at: number;
  ended_at: number | null;
}

export interface AgentRow {
  id: string;
  run_id: string;
  label: string | null;
  session_id: string;
  joined_at: number;
  left_at: number | null;
}

export interface JournalEntry {
  run_id: string;
  seq: number;
  agent_id: string | null;
  ts: number;
  type: string;
  surface: string | null;
  payload: unknown;
}

export interface BlackboardCell {
  run_id: string;
  surface: string;
  value: unknown;
  version: number;
  author: string;
  updated_at: number;
}

/** Per-session context: which agent/run this MCP connection is bound to. */
export interface SessionCtx {
  sessionId: string;
  agentId?: string;
  runId?: string;
}
