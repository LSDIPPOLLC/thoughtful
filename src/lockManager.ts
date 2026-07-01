import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { bus } from "./bus.js";
import type { Store } from "./store.js";
import type { Claim, ClaimMode, ClaimResult, Surface } from "./types.js";
import { modesCompatible, surfacesOverlap, surfaceToString, surfaceCovers } from "./surface.js";

const now = () => Date.now();

interface HeldClaim extends Claim {
  timer: NodeJS.Timeout;
}

interface Waiter {
  id: string;
  runId: string;
  agentId: string;
  mode: ClaimMode;
  surfaces: Surface[];
  ttlMs: number;
  /** agents this waiter is blocked behind, snapshotted at enqueue (for deadlock). */
  holders: Set<string>;
  resolve: (r: ClaimResult) => void;
  timeout: NodeJS.Timeout;
}

/**
 * In-memory-authoritative lock manager (ADR 0003). The single-threaded event
 * loop is the mutex (ADR 0005) — every method below runs to completion without
 * preemption, so overlap checks and grant/queue mutations are atomic by
 * construction. Turso is a durable mirror only.
 */
export class LockManager {
  private claims = new Map<string, HeldClaim>();
  private waiters: Waiter[] = [];

  constructor(private db: DB, private store: Store) {}

  // ---- public API -------------------------------------------------------

  async claim(
    runId: string, agentId: string, surfaces: Surface[], mode: ClaimMode,
    ttlMs: number, block: boolean, timeoutMs: number,
  ): Promise<ClaimResult> {
    const conflicts = this.conflictsFor(runId, surfaces, mode, agentId);

    if (conflicts.length === 0) return this.grant(runId, agentId, surfaces, mode, ttlMs);

    const conflictInfo = conflicts.map((c) => ({ agentId: c.agentId, surface: surfaceToString(c.surface), mode: c.mode }));

    if (!block) {
      this.store.journal(runId, agentId, "claim.denied", null, { conflicts: conflictInfo });
      return { status: "denied", conflicts: conflictInfo };
    }

    // Blocking. First check whether waiting would close a deadlock cycle (ADR 0004).
    const holders = new Set(conflicts.map((c) => c.agentId));
    const cycle = this.detectCycle(agentId, holders);
    if (cycle) {
      this.store.journal(runId, agentId, "claim.deadlock", null, { cycle });
      return { status: "deadlock", conflicts: conflictInfo, cycle };
    }

    // Enqueue a waiter; resolved on release/expiry or timed out as "queued".
    return new Promise<ClaimResult>((resolve) => {
      const w: Waiter = {
        id: `wait_${randomUUID().slice(0, 8)}`, runId, agentId, mode, surfaces, ttlMs, holders, resolve,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x.id !== w.id);
          resolve({ status: "queued", conflicts: conflictInfo });
        }, timeoutMs),
      };
      this.waiters.push(w);
      this.store.journal(runId, agentId, "claim.queued", null, { conflicts: conflictInfo });
    });
  }

  renew(claimId: string, ttlMs: number): boolean {
    const c = this.claims.get(claimId);
    if (!c) return false;
    clearTimeout(c.timer);
    c.ttlMs = ttlMs;
    c.expiresAt = now() + ttlMs;
    c.timer = setTimeout(() => this.expire(claimId), ttlMs);
    this.store.enqueue(() => this.db.prepare(`UPDATE claims SET expires_at = ? WHERE id = ?`).run(c.expiresAt, claimId));
    return true;
  }

  release(claimId: string): boolean {
    return this.remove(claimId, "claim.released");
  }

  /** Reclaim everything a disconnected agent held or was waiting on (ADR 0003). */
  releaseByAgent(agentId: string) {
    for (const [id, c] of this.claims) if (c.agentId === agentId) this.remove(id, "claim.released");
    for (const w of this.waiters.filter((x) => x.agentId === agentId)) {
      clearTimeout(w.timeout);
      w.resolve({ status: "denied", conflicts: [] });
    }
    this.waiters = this.waiters.filter((x) => x.agentId !== agentId);
  }

  /** Release every claim and waiter in a run (used when a Run ends). */
  releaseByRun(runId: string) {
    for (const [id, c] of this.claims) if (c.runId === runId) this.remove(id, "claim.released");
    for (const w of this.waiters.filter((x) => x.runId === runId)) {
      clearTimeout(w.timeout);
      w.resolve({ status: "denied", conflicts: [] });
    }
    this.waiters = this.waiters.filter((x) => x.runId !== runId);
  }

  /** Does `agentId` hold a live exclusive claim covering `cell`? (enforced writes) */
  holdsExclusiveCovering(runId: string, agentId: string, cell: Surface): boolean {
    for (const c of this.claims.values()) {
      if (c.runId !== runId || c.agentId !== agentId || c.mode !== "exclusive") continue;
      if (c.surfaces.some((s) => coversFor(s, cell))) return true;
    }
    return false;
  }

  // ---- viz snapshot -----------------------------------------------------

  snapshot(runId: string) {
    const claims = [...this.claims.values()]
      .filter((c) => c.runId === runId)
      .map((c) => ({ id: c.id, agentId: c.agentId, mode: c.mode, surfaces: c.surfaces.map(surfaceToString), expiresAt: c.expiresAt }));
    const waiters = this.waiters
      .filter((w) => w.runId === runId)
      .map((w) => ({ agentId: w.agentId, mode: w.mode, surfaces: w.surfaces.map(surfaceToString), waitingFor: [...w.holders] }));
    // wait-for edges: requester -> holder
    const edges = this.waiters
      .filter((w) => w.runId === runId)
      .flatMap((w) => [...w.holders].map((h) => ({ from: w.agentId, to: h })));
    return { claims, waiters, edges };
  }

  // ---- internals --------------------------------------------------------

  private grant(runId: string, agentId: string, surfaces: Surface[], mode: ClaimMode, ttlMs: number): ClaimResult {
    const id = `claim_${randomUUID().slice(0, 8)}`;
    const expiresAt = now() + ttlMs;
    const held: HeldClaim = {
      id, runId, agentId, mode, surfaces, ttlMs, expiresAt,
      timer: setTimeout(() => this.expire(id), ttlMs),
    };
    this.claims.set(id, held);
    this.store.enqueue(() => this.db.prepare(
      `INSERT INTO claims (id, run_id, agent_id, mode, surfaces, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'granted', ?)`,
    ).run(id, runId, agentId, mode, JSON.stringify(surfaces.map(surfaceToString)), expiresAt, now()));
    this.store.journal(runId, agentId, "claim.granted", surfaces.map(surfaceToString).join(","), { claimId: id, mode });
    bus.publishState(runId);
    return { status: "granted", claimId: id };
  }

  private expire(claimId: string) {
    this.remove(claimId, "claim.expired");
  }

  private remove(claimId: string, journalType: string): boolean {
    const c = this.claims.get(claimId);
    if (!c) return false;
    clearTimeout(c.timer);
    this.claims.delete(claimId);
    const status = journalType === "claim.expired" ? "expired" : "released";
    this.store.enqueue(() => this.db.prepare(`UPDATE claims SET status = ? WHERE id = ?`).run(status, claimId));
    this.store.journal(c.runId, c.agentId, journalType, null, { claimId });
    bus.publishState(c.runId);
    this.processWaiters();
    return true;
  }

  /** After any release/expiry, try to grant queued waiters FIFO. */
  private processWaiters() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const w of this.waiters) {
        if (this.conflictsFor(w.runId, w.surfaces, w.mode, w.agentId).length > 0) continue;
        clearTimeout(w.timeout);
        this.waiters = this.waiters.filter((x) => x.id !== w.id);
        const res = this.grant(w.runId, w.agentId, w.surfaces, w.mode, w.ttlMs);
        w.resolve(res);
        progressed = true;
        break; // waiters list mutated; restart the scan
      }
    }
  }

  private conflictsFor(runId: string, surfaces: Surface[], mode: ClaimMode, exceptAgent: string): { agentId: string; surface: Surface; mode: ClaimMode }[] {
    const out: { agentId: string; surface: Surface; mode: ClaimMode }[] = [];
    for (const c of this.claims.values()) {
      if (c.runId !== runId || c.agentId === exceptAgent) continue; // an agent never conflicts with itself
      for (const req of surfaces) {
        for (const held of c.surfaces) {
          if (surfacesOverlap(req, held) && !modesCompatible(mode, c.mode)) {
            out.push({ agentId: c.agentId, surface: held, mode: c.mode });
          }
        }
      }
    }
    return out;
  }

  /** Would `agent` waiting on `holders` close a cycle in the wait-for graph? */
  private detectCycle(agent: string, holders: Set<string>): string[] | null {
    const adj = new Map<string, Set<string>>();
    for (const w of this.waiters) {
      if (!adj.has(w.agentId)) adj.set(w.agentId, new Set());
      for (const h of w.holders) adj.get(w.agentId)!.add(h);
    }
    adj.set(agent, new Set([...(adj.get(agent) ?? []), ...holders]));

    // DFS from `agent`; if we return to `agent`, that path is the cycle.
    const path: string[] = [];
    const seen = new Set<string>();
    const dfs = (node: string): string[] | null => {
      path.push(node);
      seen.add(node);
      for (const next of adj.get(node) ?? []) {
        if (next === agent) return [...path, agent];
        if (!seen.has(next)) { const r = dfs(next); if (r) return r; }
      }
      path.pop();
      return null;
    };
    return dfs(agent);
  }
}

function coversFor(holder: Surface, cell: Surface): boolean {
  return surfaceCovers(holder, cell);
}
