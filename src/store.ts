import { randomUUID } from "node:crypto";
import { WriteQueue, type DB } from "./db.js";
import { bus } from "./bus.js";
import type { BlackboardCell, JournalEntry, RunRow, AgentRow } from "./types.js";

const now = () => Date.now();
const shortId = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

/**
 * Durable state (Blackboard + Journal) + Run/Agent registry over the single
 * async Turso connection, serialized through a WriteQueue. Owns the per-Run
 * monotonic `seq` (total order), which is assigned in-memory so `journal()` can
 * return synchronously and the lock manager stays synchronous.
 */
export class Store {
  private q = new WriteQueue();
  private seqByRun = new Map<string, number>();
  /**
   * Count of journal INSERTs that failed after their seq was already assigned
   * and published to SSE (fire-and-forget durability hole — a failure here is a
   * permanent seq gap in the durable Journal). Surfaced via /api/health; a full
   * fix (awaiting the INSERT) would break the lock manager's synchronous
   * mutation guarantee (ADR 0005), so v1 detects rather than prevents.
   */
  journalWriteFailures = 0;

  private constructor(private db: DB) {}

  static async create(db: DB): Promise<Store> {
    const s = new Store(db);
    const rows = (await db.prepare(`SELECT run_id, MAX(seq) AS m FROM journal GROUP BY run_id`).all()) as any[];
    for (const r of rows) s.seqByRun.set(r.run_id, Number(r.m));
    return s;
  }

  /** Expose the serialized queue so other stores share the one connection in-order. */
  enqueue(fn: () => Promise<unknown>) { this.q.fire(fn); }
  query<T>(fn: () => Promise<T>): Promise<T> { return this.q.run(fn); }
  private read<T>(fn: () => Promise<T>): Promise<T> { return this.q.run(fn); }

  // ---- Runs -------------------------------------------------------------
  createRun(label?: string): RunRow {
    const row: RunRow = { id: shortId("run"), label: label ?? null, status: "active", created_at: now(), ended_at: null };
    this.q.fire(() => this.db.prepare(`INSERT INTO runs (id, label, status, created_at) VALUES (?, ?, 'active', ?)`).run(row.id, row.label, row.created_at));
    return row;
  }

  getRun(id: string): Promise<RunRow | undefined> {
    return this.read(() => this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id)) as Promise<RunRow | undefined>;
  }

  listRuns(): Promise<RunRow[]> {
    return this.read(() => this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all()) as Promise<RunRow[]>;
  }

  endRun(id: string) {
    this.q.fire(() => this.db.prepare(`UPDATE runs SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'`).run(now(), id));
  }

  purgeRun(id: string) {
    for (const t of ["journal", "blackboard", "claims", "agents"]) this.q.fire(() => this.db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(id));
    this.q.fire(() => this.db.prepare(`DELETE FROM runs WHERE id = ?`).run(id));
    this.seqByRun.delete(id);
  }

  // ---- Agents -----------------------------------------------------------
  joinRun(runId: string, sessionId: string, label?: string): AgentRow {
    const row: AgentRow = { id: shortId("agent"), run_id: runId, label: label ?? null, session_id: sessionId, joined_at: now(), left_at: null };
    this.q.fire(() => this.db.prepare(`INSERT INTO agents (id, run_id, label, session_id, joined_at) VALUES (?, ?, ?, ?, ?)`).run(row.id, row.run_id, row.label, row.session_id, row.joined_at));
    this.journal(runId, row.id, "agent.joined", null, { label: row.label });
    return row;
  }

  leaveAgent(runId: string, agentId: string) {
    this.q.fire(() => this.db.prepare(`UPDATE agents SET left_at = ? WHERE id = ?`).run(now(), agentId));
    this.journal(runId, agentId, "agent.left", null, {});
  }

  listAgents(runId: string): Promise<AgentRow[]> {
    return this.read(() => this.db.prepare(`SELECT * FROM agents WHERE run_id = ? ORDER BY joined_at`).all(runId)) as Promise<AgentRow[]>;
  }

  async activeAgentCount(runId: string): Promise<number> {
    const r = (await this.read(() => this.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE run_id = ? AND left_at IS NULL`).get(runId))) as any;
    return Number(r.n);
  }

  // ---- Journal (seq assigned in-memory; INSERT enqueued) ----------------
  private nextSeq(runId: string): number {
    const next = (this.seqByRun.get(runId) ?? 0) + 1;
    this.seqByRun.set(runId, next);
    return next;
  }

  journal(runId: string, agentId: string | null, type: string, surface: string | null, payload: unknown): JournalEntry {
    const entry: JournalEntry = { run_id: runId, seq: this.nextSeq(runId), agent_id: agentId, ts: now(), type, surface, payload };
    let json: string;
    try { json = JSON.stringify(payload); } catch { json = JSON.stringify({ _unserializable: true }); }
    void this.q.run(() => this.db.prepare(`INSERT INTO journal (run_id, seq, agent_id, ts, type, surface, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.run_id, entry.seq, entry.agent_id, entry.ts, entry.type, entry.surface, json))
      .catch((e) => {
        this.journalWriteFailures++;
        console.error(`[journal] DURABILITY: INSERT failed for run=${runId} seq=${entry.seq} type=${type} — permanent seq gap:`, e);
      });
    bus.publishJournal(entry); // instant SSE — does not wait on the DB
    return entry;
  }

  async readJournal(runId: string, opts: { sinceSeq?: number; agentId?: string; type?: string; surface?: string } = {}): Promise<JournalEntry[]> {
    const where = ["run_id = ?"]; const args: any[] = [runId];
    if (opts.sinceSeq != null) { where.push("seq > ?"); args.push(opts.sinceSeq); }
    if (opts.agentId) { where.push("agent_id = ?"); args.push(opts.agentId); }
    if (opts.type) { where.push("type = ?"); args.push(opts.type); }
    if (opts.surface) { where.push("surface = ?"); args.push(opts.surface); }
    const rows = (await this.read(() => this.db.prepare(`SELECT * FROM journal WHERE ${where.join(" AND ")} ORDER BY seq`).all(...args))) as any[];
    return rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) as JournalEntry[];
  }

  // ---- Blackboard -------------------------------------------------------
  async bbRead(runId: string, exact?: string, prefix?: string): Promise<BlackboardCell[]> {
    let rows: any[];
    if (exact) {
      rows = (await this.read(() => this.db.prepare(`SELECT * FROM blackboard WHERE run_id = ? AND surface = ?`).all(runId, exact))) as any[];
    } else if (prefix) {
      rows = (await this.read(() => this.db.prepare(`SELECT * FROM blackboard WHERE run_id = ? AND (surface = ? OR surface LIKE ?)`).all(runId, prefix, `${prefix}/%`))) as any[];
    } else {
      rows = (await this.read(() => this.db.prepare(`SELECT * FROM blackboard WHERE run_id = ?`).all(runId))) as any[];
    }
    return rows.map((r) => ({ ...r, value: JSON.parse(r.value) })) as BlackboardCell[];
  }

  async bbCurrentVersion(runId: string, surface: string): Promise<number> {
    const r = (await this.read(() => this.db.prepare(`SELECT version FROM blackboard WHERE run_id = ? AND surface = ?`).get(runId, surface))) as any;
    return r ? Number(r.version) : 0;
  }

  async bbWrite(runId: string, surface: string, value: unknown, author: string): Promise<number> {
    const version = (await this.bbCurrentVersion(runId, surface)) + 1;
    await this.read(() => this.db.prepare(
      `INSERT INTO blackboard (run_id, surface, value, version, author, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, surface) DO UPDATE SET value = excluded.value, version = excluded.version, author = excluded.author, updated_at = excluded.updated_at`,
    ).run(runId, surface, JSON.stringify(value), version, author, now()));
    // The journaled write carries the VALUE so replaying blackboard.write in seq
    // order really does reconstruct Blackboard evolution (CONTEXT.md §Seq) —
    // that invariant is what lets the Blackboard itself stay latest-only.
    this.journal(runId, author, "blackboard.write", surface, { version, value });
    return version;
  }
}
