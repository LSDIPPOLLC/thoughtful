# 7. Fact retrieval — brute-force filtered scan, ANN index deferred

Date: 2026-07-01

## Status

Accepted (scopes v1.5) — amended 2026-07-02 (implementation mechanism; see Amendment)

## Context

Fact retrieval (`fact_search`) must return the true top-k most semantically
similar **active** Facts **within a Namespace**. Both filters are mandatory:
Namespace isolation is a correctness requirement (ADR 0006 — payments knowledge
must never surface in an auth query), and superseded Facts (ADR 0006 dedup) must
be excluded.

Turso's Rust engine provides native vector search (verified against current docs):

- `F32_BLOB(<dim>)` columns, `vector('[...]')` to encode, `vector_distance_cos()`
  for cosine distance.
- An optional ANN index: `CREATE INDEX idx ON facts(libsql_vector_idx(embedding,
  'metric=cosine'))`, queried via `vector_top_k('idx', vector('[...]'), k)`.

The ANN path has a decisive flaw for our filters: **`vector_top_k` selects the k
nearest across the whole indexed table *before* any `WHERE` clause runs.** Applying
`namespace` and `superseded_by IS NULL` afterwards can leave **fewer than k**
results — silent under-return of a coordination-critical query. Workarounds
(over-fetch a large k' and hope, or one index per Namespace) add complexity or
their own partitioning.

The brute-force alternative filters first and is exact:

```sql
SELECT id, text, corroboration_count, source_run_id, source_agent_id,
       vector_distance_cos(embedding, vector(:q)) AS distance
FROM facts
WHERE namespace = :ns
  AND superseded_by IS NULL
  -- optional: AND tags LIKE ... , AND corroboration_count >= :min
ORDER BY distance
LIMIT :k;
```

Its cost is an O(n) cosine scan of the Namespace's Facts per query. At the
expected single-host scale (hundreds-to-thousands of Facts per Namespace) this is
sub-millisecond; ANN only pays off at ~10^5+ rows.

## Decision

For v1.5, implement `fact_search` as a **brute-force filtered scan**: filter by
Namespace and `superseded_by IS NULL` (plus optional `tags` / `min_corroboration`)
first, order by `vector_distance_cos`, limit k. Do **not** use the `vector_top_k`
ANN index in v1.5.

Keep `namespace` as a column on the Facts table so the eventual scale path — **one
ANN index per Namespace**, which restores filter-first correctness by
partitioning — is a non-migration.

`fact_search` returns each Fact with its cosine distance, provenance, and
`corroboration_count` (available for re-ranking).

## Consequences

- Retrieval always returns the true in-Namespace, active top-k — no silent
  under-return. Correctness before speed.
- Linear scan is trivially fast at v1.5 scale and keeps the query a single, simple
  SQL statement with ordinary `WHERE` filtering (tags, corroboration, etc. compose
  freely — something the ANN path cannot do cleanly).
- At large scale (~10^5+ Facts in one Namespace) latency grows linearly; the
  mitigation is per-Namespace ANN indexes, enabled by the `namespace` column
  already in the schema. Revisit when a Namespace actually approaches that size.
- The embedding dimension is fixed per Namespace (ADR 0006), so the `F32_BLOB(dim)`
  column and any future per-Namespace index are well-defined.

## Amendment (2026-07-02): vectors stored as JSON, cosine computed in JS

The **decision holds** (brute-force filtered scan, filter-first, ANN deferred),
but the storage/execution mechanism shipped differently from the SQL sketched
above: embeddings are stored as **JSON arrays in a TEXT column** and cosine
similarity is computed **in JavaScript** after a plain
`WHERE namespace = ? AND superseded_by IS NULL` scan (`src/factStore.ts`), not
via `F32_BLOB` + `vector_distance_cos()` in SQL.

Why (see also DESIGN.md §10):

- The beta `@tursodatabase/database` driver had vector-encoding quirks, and
  hitting unimplemented engine paths can panic the whole process (as correlated
  subqueries already did).
- JSON storage is provider-agnostic across differing dims (Qwen 1024 / MiniMax
  1536 / stub 256) with zero encoding ceremony.

Same complexity class (O(n) per query, n = active Facts in the Namespace); the
JS hop matters only at scales where ANN would be the answer anyway. **Switch to
`F32_BLOB` + native `vector_distance_cos` when adding the per-Namespace ANN
index** — that migration re-encodes the same numbers, no semantic change.
