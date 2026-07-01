import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { Store } from "./store.js";
import { cosine, type EmbeddingProvider } from "./embeddings.js";

const now = () => Date.now();
const shortId = () => `fact_${randomUUID().slice(0, 10)}`;

// Dedup thresholds (CONTEXT.md): >= T supersedes; >= T2 corroborates.
const T = 0.95;
const T2 = 0.98;

export interface FactRow {
  id: string;
  namespace: string;
  text: string;
  embedding: number[];
  tags: string[];
  corroboration_count: number;
  superseded_by: string | null;
  source_run_id: string | null;
  source_agent_id: string | null;
  created_at: number;
}

export interface WriteResult {
  fact_id: string;
  superseded_id?: string;
  corroborated?: boolean;
  corroboration_count?: number;
}

export interface SearchHit {
  id: string;
  text: string;
  distance: number;         // cosine distance (1 - similarity)
  corroboration_count: number;
  tags: string[];
  provenance: { source_run_id: string | null; source_agent_id: string | null; created_at: number };
}

/**
 * Fact store (v1.5). Namespace pins one embedding model (ADR 0006). Retrieval is
 * a brute-force filtered cosine scan — filter by namespace + active first, then
 * rank (ADR 0007). Dedup is mechanical: supersede at >= T, corroborate at >= T2.
 */
export class FactStore {
  constructor(private db: DB, private store: Store, private embed: EmbeddingProvider) {}

  /** Create-and-pin on first use; guard against embedding-model drift (ADR 0006). */
  private async ensureNamespace(name: string): Promise<void> {
    const row = (await this.store.query(() =>
      this.db.prepare(`SELECT embed_model, dim FROM namespaces WHERE name = ?`).get(name))) as any;
    if (!row) {
      await this.store.query(() => this.db.prepare(
        `INSERT INTO namespaces (name, embed_model, dim, created_at) VALUES (?, ?, ?, ?)`,
      ).run(name, this.embed.name, this.embed.dim, now()));
      return;
    }
    if (row.embed_model !== this.embed.name) {
      throw new Error(
        `namespace '${name}' is pinned to embed model '${row.embed_model}' but server is configured with ` +
        `'${this.embed.name}' — a re-embed migration is required to change it (ADR 0006)`);
    }
  }

  private async activeFacts(namespace: string): Promise<FactRow[]> {
    const rows = (await this.store.query(() =>
      this.db.prepare(`SELECT * FROM facts WHERE namespace = ? AND superseded_by IS NULL`).all(namespace))) as any[];
    return rows.map(hydrate);
  }

  /** Lean fact list for the viz (no embeddings). Active only unless asked. */
  async listFacts(namespace: string, includeSuperseded = false): Promise<{
    id: string; text: string; tags: string[]; corroboration_count: number; superseded: boolean;
    source_run_id: string | null; source_agent_id: string | null; created_at: number;
  }[]> {
    const sql = `SELECT id, text, tags, corroboration_count, superseded_by, source_run_id, source_agent_id, created_at
                 FROM facts WHERE namespace = ?${includeSuperseded ? "" : " AND superseded_by IS NULL"}
                 ORDER BY created_at DESC`;
    const rows = (await this.store.query(() => this.db.prepare(sql).all(namespace))) as any[];
    return rows.map((r) => ({
      id: r.id, text: r.text, tags: r.tags ? JSON.parse(r.tags) : [],
      corroboration_count: Number(r.corroboration_count), superseded: !!r.superseded_by,
      source_run_id: r.source_run_id, source_agent_id: r.source_agent_id, created_at: Number(r.created_at),
    }));
  }

  async listNamespaces(): Promise<{ name: string; embed_model: string; dim: number; fact_count: number }[]> {
    // Two flat queries + merge — the beta engine does not yet support the
    // correlated subquery this would otherwise use.
    const ns = (await this.store.query(() =>
      this.db.prepare(`SELECT name, embed_model, dim FROM namespaces ORDER BY name`).all())) as any[];
    const counts = (await this.store.query(() =>
      this.db.prepare(`SELECT namespace, COUNT(*) AS c FROM facts WHERE superseded_by IS NULL GROUP BY namespace`).all())) as any[];
    const byNs = new Map(counts.map((r) => [r.namespace, Number(r.c)]));
    return ns.map((r) => ({ name: r.name, embed_model: r.embed_model, dim: Number(r.dim), fact_count: byNs.get(r.name) ?? 0 }));
  }

  async write(namespace: string, text: string, tags: string[], sourceRunId: string | null, sourceAgentId: string | null): Promise<WriteResult> {
    await this.ensureNamespace(namespace);
    const vec = await this.embed.embed(text, "doc");

    // Dedup: find nearest active fact in the namespace.
    let best: { row: FactRow; sim: number } | null = null;
    for (const row of await this.activeFacts(namespace)) {
      const sim = cosine(vec, row.embedding);
      if (!best || sim > best.sim) best = { row, sim };
    }

    if (best && best.sim >= T2) {
      // Near-identical: corroborate rather than store a duplicate.
      const count = best.row.corroboration_count + 1;
      await this.store.query(() => this.db.prepare(
        `UPDATE facts SET corroboration_count = ?, created_at = created_at WHERE id = ?`).run(count, best!.row.id));
      return { fact_id: best.row.id, corroborated: true, corroboration_count: count };
    }

    const id = shortId();
    await this.store.query(() => this.db.prepare(
      `INSERT INTO facts (id, namespace, text, embedding, tags, corroboration_count, superseded_by, source_run_id, source_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
    ).run(id, namespace, text, JSON.stringify(vec), JSON.stringify(tags), sourceRunId, sourceAgentId, now()));

    if (best && best.sim >= T) {
      // Update of existing knowledge: supersede the old, keep it for history.
      await this.store.query(() => this.db.prepare(`UPDATE facts SET superseded_by = ? WHERE id = ?`).run(id, best!.row.id));
      return { fact_id: id, superseded_id: best.row.id };
    }
    return { fact_id: id };
  }

  async search(namespace: string, query: string, k: number, filter?: { tags?: string[]; minCorroboration?: number }): Promise<SearchHit[]> {
    const nsRow = (await this.store.query(() => this.db.prepare(`SELECT name FROM namespaces WHERE name = ?`).get(namespace))) as any;
    if (!nsRow) return [];
    await this.ensureNamespace(namespace); // also enforces model-match guard
    const qvec = await this.embed.embed(query, "query");

    let facts = await this.activeFacts(namespace);
    if (filter?.tags?.length) facts = facts.filter((f) => filter.tags!.every((t) => f.tags.includes(t)));
    if (filter?.minCorroboration != null) facts = facts.filter((f) => f.corroboration_count >= filter.minCorroboration!);

    return facts
      .map((f) => ({ f, sim: cosine(qvec, f.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k)
      .map(({ f, sim }) => ({
        id: f.id, text: f.text, distance: 1 - sim, corroboration_count: f.corroboration_count, tags: f.tags,
        provenance: { source_run_id: f.source_run_id, source_agent_id: f.source_agent_id, created_at: f.created_at },
      }));
  }
}

function hydrate(r: any): FactRow {
  return {
    id: r.id, namespace: r.namespace, text: r.text,
    embedding: JSON.parse(r.embedding), tags: r.tags ? JSON.parse(r.tags) : [],
    corroboration_count: Number(r.corroboration_count), superseded_by: r.superseded_by,
    source_run_id: r.source_run_id, source_agent_id: r.source_agent_id, created_at: Number(r.created_at),
  };
}
