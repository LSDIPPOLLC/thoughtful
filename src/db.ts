import { connect } from "@tursodatabase/database";

// One process, one connection to one local Turso file (ADR 0002). The
// @tursodatabase/database driver is async (run/get/all return Promises), so all
// access is serialized through a single write queue (see store.ts) to keep
// single-flight ordering on the one connection — which is also the
// write-integrity guarantee (no MVCC; ADR 0001 amendment).
export type DB = Awaited<ReturnType<typeof connect>>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY, label TEXT, status TEXT NOT NULL DEFAULT 'active',
     created_at INTEGER NOT NULL, ended_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS agents (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL, label TEXT, session_id TEXT NOT NULL,
     joined_at INTEGER NOT NULL, left_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS journal (
     run_id TEXT NOT NULL, seq INTEGER NOT NULL, agent_id TEXT, ts INTEGER NOT NULL,
     type TEXT NOT NULL, surface TEXT, payload TEXT, PRIMARY KEY (run_id, seq))`,
  `CREATE TABLE IF NOT EXISTS blackboard (
     run_id TEXT NOT NULL, surface TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL,
     author TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (run_id, surface))`,
  // Durable mirror of the in-memory lock manager (ADR 0003).
  `CREATE TABLE IF NOT EXISTS claims (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL,
     surfaces TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // ---- Facts (v1.5) ----
  // A Namespace pins its embedding model + dim (ADR 0006). embedding stored as a
  // JSON array; retrieval is a brute-force filtered cosine scan (ADR 0007).
  `CREATE TABLE IF NOT EXISTS namespaces (
     name TEXT PRIMARY KEY, embed_model TEXT NOT NULL, dim INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS facts (
     id TEXT PRIMARY KEY, namespace TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL,
     tags TEXT, corroboration_count INTEGER NOT NULL DEFAULT 1, superseded_by TEXT,
     source_run_id TEXT, source_agent_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS facts_ns ON facts(namespace)`,
];

export async function openDb(path: string): Promise<DB> {
  const db = await connect(path);
  for (const stmt of SCHEMA) await db.prepare(stmt).run();
  return db;
}

/**
 * Serializes every DB operation (read and write) into one promise chain, so the
 * single async connection is never used concurrently and ordering is preserved.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Enqueue an op; returns a promise for its result. Failures are isolated. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Fire-and-forget enqueue (for durable-mirror writes we don't await). */
  fire(fn: () => Promise<unknown>): void {
    void this.run(fn).catch((err) => console.error("[db] write failed:", err));
  }
}
