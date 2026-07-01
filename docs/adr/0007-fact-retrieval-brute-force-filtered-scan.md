# 7. Fact retrieval — brute-force filtered scan, ANN index deferred

Date: 2026-07-01

## Status

Accepted (scopes v1.5)

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
