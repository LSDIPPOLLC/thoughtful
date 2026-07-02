# Design Summary — Shared Agentic Memory

A shared-memory / coordination system that lets parallel agents (a Claude Code
orchestrator + subagents, or an open-source coding agent driving any model)
collaborate without clobbering each other. Exposed as an **MCP server**, backed
by **Turso** (the Rust SQLite rewrite), with an embedded **visualization** layer.

This file is the synthesis. The canonical vocabulary lives in [CONTEXT.md](./CONTEXT.md);
the load-bearing decisions and their trade-offs live in [docs/adr/](./docs/adr/).

---

## 1. What it is (and isn't)

Four kinds of "memory" were considered. Scope:

| Kind          | v1?         | Purpose |
|---------------|-------------|---------|
| **Blackboard**| ✅ core     | Live shared working state agents read/write to coordinate |
| **Journal**   | ✅ core     | Append-only, replayable history of a Run |
| **Fact**      | ⏳ v1.5     | Durable distilled knowledge, relevance-queried (uses Turso vector search) |
| **Artifact**  | ❌ cut      | Blob/file handoff — different storage beast, out of scope |

The novel, hard part is **parallel agents coordinating on shared state without
collision** — that is the spine. Everything else attaches to it.

---

## 2. Coordination model (the spine)

Agents ideally work on **disjoint** pieces, but the system must let an agent learn
it is *about to* touch the same **Surface** as another and resolve it — a
**pre-flight** requirement.

- **Surface** — the unit of collision, two kinds:
  - *Path* — hierarchical key (`repo/src/auth/login.ts`). Overlap = **prefix**
    relation (ancestor/descendant collide; siblings don't).
  - *Entity* — typed id (`user:1234`). Overlap = **exact** `type:id` match.
  - Cross-kind Surfaces never overlap; overlap is computed only within a kind and
    within a Run.
- **Claim** — an agent's pre-flight declaration of intent over a bundle of
  Surfaces:
  - **Atomic bundle** — all-or-nothing grant (no partial acquire → no self-deadlock).
  - **Mode** — *shared* (read; many holders) / *exclusive* (write; one holder),
    reader/writer-lock semantics.
  - **Lease TTL** — auto-reclaimed on expiry (crash safety); renewed via heartbeat.
  - On overlap the loser is **queued** and woken when the Surface frees.
- **Enforcement** — Claims are *advisory* for planning/negotiation, but
  **mandatory for Blackboard writes**: the server rejects a write to a cell unless
  the caller holds a live *exclusive* Claim on it. "Should not collide" becomes
  "cannot collide." (ADR 0001)

---

## 3. Architecture

**One process, single host.** A single MCP-server process on one host holds one
connection to one local `tursodb` file. Agents are MCP clients and never touch
Turso directly. (ADR 0002)

This single serialization point is doing a lot of work:

- **Correct claim checks** — every overlap check sees latest-committed state; no
  embedded-replica staleness (replicas/Sync/Cloud are excluded from v1).
- **In-memory lock manager** — Claims, Leases, and per-Surface wait queues live in
  process memory (source of truth), **write-through** to Turso for durability +
  viz. A blocking `claim` is a pending Promise woken on `release`/expiry — no
  polling, no pub/sub (which Turso lacks). (ADR 0003)
- **Write integrity for free** — one serialized connection means no concurrent
  writer at the storage layer, so **MVCC / `BEGIN CONCURRENT` was dropped**
  (redundant + beta risk). Plain transactions. (ADR 0001 amendment / ADR 0002)
- **Race-free by runtime** — built in **TypeScript on Node**; the single-threaded
  event loop is an implicit mutex over the lock manager, so it needs no explicit
  locking. (ADR 0005)

**Deadlock.** Atomic bundles stop intra-call deadlock; sequential deadlock
(hold A, claim B while other holds B, claims A) is caught by a **wait-for graph**
(agents = nodes, edge `requester → holder` labelled by Surface). A `claim` that
would close a cycle is rejected immediately with `DEADLOCK`; TTL is the ultimate
backstop. The same graph powers the viz contention view. (ADR 0004)

---

## 4. Data model

- **Run** — top-level grouping. `active | ended`. Scopes Blackboard, Journal,
  Claims. Ends explicitly or when the last agent disconnects (grace period); on
  end, Claims released and Blackboard + Journal **frozen** and retained
  indefinitely (manual `purge_run`).
- **Agent** — `join_run` → server-issued `agent_id`, bound to the MCP session.
  Clean disconnect → grace-period reclaim of its Claims; Lease TTL backstops hard
  crashes.
- **Blackboard cell** — key = a Surface; value = opaque JSON + metadata
  (`author agent_id`, monotonic `version`, `updated_at`). **Latest-only.**
- **Journal entry** — `{run_id, seq, agent_id, ts, type, surface?, payload}`.
  System events (`claim.*`, `blackboard.write`, `agent.joined/left`) + agent-
  authored entries, in one stream.
- **Seq** — per-Run monotonic sequence assigned by the single server; the
  **total order** for replay. Replaying `blackboard.write` in `seq` order
  reconstructs Blackboard evolution — which is why Blackboard is latest-only.

---

## 5. MCP tool surface (16)

**Run / identity:** `create_run` · `join_run` · `list_runs` · `whoami` · `end_run` · `purge_run`
**Claims:** `claim(surfaces[], mode, ttl_ms, block?, timeout_ms?)` · `renew` · `release`
**Blackboard:** `bb_read(surface | prefix)` · `bb_write(surface, value, expected_version?)`
**Journal:** `journal_append` · `journal_read({since_seq?, agent_id?, type?, surface?})`
**Facts (v1.5):** `fact_write(namespace, text, tags?)` · `fact_search(namespace, query, k, filter?)` · `list_namespaces()`

Notes: `claim` returns `granted | queued | denied | deadlock`; `block=true`
long-polls server-side. Tool errors are structured `{ code, message }`
(`NO_CLAIM`, `VERSION_CONFLICT`, `RUN_ENDED`, `RUN_ACTIVE`, `PAYLOAD_TOO_LARGE`,
…). `bb_write` optional `expected_version` → `VERSION_CONFLICT` on mismatch
(catches a claim lost to TTL mid-work). `bb_read` supports path-prefix survey;
entity reads are exact. `release` is the normal path; Leases are the crash net.
`fact_write` auto-fills provenance from the caller's session and auto-creates the
Namespace (pinning the current embed model); `fact_search` filters by Namespace +
active, returns distance + `corroboration_count`.

---

## 6. Visualization (observability-first)

Embedded in the same process: read-only **HTTP + SSE** endpoints + a static SPA
(graph lib left open). One-Run view, four panels + graph:

1. **Agent roster** + liveness
2. **Claim / lock map** — Surfaces held + queued waiters
3. **Blackboard** — current cells + versions
4. **Journal timeline** — `seq`-ordered, with a replay scrubber
5. **Contention graph** — the wait-for graph rendered with **Cytoscape** (served
   locally from `node_modules`, offline): holder vs waiting nodes, directed
   waiter→holder edges, cycle edges flagged red (deadlocks)

Live view streams from in-memory state via SSE (instant, no polling); replay of an
ended Run reads the Journal from Turso by `seq`. **No Vercel/cloud in v1** — a
local file DB + in-process state can't be served from serverless; that changes
only if the system later moves to Turso Cloud.

A second **Facts** view (Namespace-scoped, cross-Run — separate from the one-Run
dashboard via a Runs/Facts toggle) lists a Namespace's active Facts (text, tags,
`corroboration_count`, provenance) and offers a **live semantic search** box that
embeds the query server-side and ranks by cosine distance. Backed by
`/api/namespaces`, `/api/namespaces/:name/facts`, `/api/namespaces/:name/search`.

---

## 7. Facts (v1.5)

Durable, semantically-searchable knowledge that outlives Runs. Orthogonal to the
coordination spine; reuses the same server + Turso file.

- **Scope = Namespace** (flat: `repo:thoughtful`, `domain:payments`), **not**
  Run-scoped. A Fact carries provenance (`source_run_id`, `source_agent_id`,
  `created_at`). *Run = ephemeral-collaboration boundary; Namespace =
  durable-knowledge boundary.*
- **Born two ways** (both implemented): explicit `fact_write` by any agent, and
  **auto-distillation** — a standalone **distiller** process (`src/distiller.ts`,
  agent-side, NOT in the server) watches the global `run.ended` event stream,
  reads a finished Run's Journal + final Blackboard over the read API, summarizes
  them into candidate Facts, and writes them via `fact_write` (attributed to the
  source Run). Summarizer is pluggable (`SUMMARIZER`): `heuristic` (default,
  offline — promotes agent-authored Journal entries + final Blackboard state) or
  `minimax` (real generative chat). Also runs one-shot: `npm run distiller <run_id>`.
  The server never runs a model (ADR 0006).
- **Embedding is server-side, pinned per Namespace** (ADR 0006). The server owns
  exactly one embedding model as infra (index function, not reasoning) so all
  vectors in a Namespace share one space. Provider is pluggable with a `doc|query`
  role:
  - **Default: Qwen3-Embedding-0.6B**, local in-process (ONNX/Transformers.js),
    1024-dim — private, offline, no key.
  - **Opt-in: MiniMax `embo-01`** (API, 1536-dim) per Namespace.
  - Changing a Namespace's model invalidates its vectors (re-embed migration).
- **Dedup** (server-side, mechanical, per Namespace): cosine ≥ `T` (~0.95) →
  **supersede** (old kept with `superseded_by`, excluded from search); cosine ≥
  `T2` (~0.98) → **corroborate** (bump `corroboration_count`). No server-side text
  merge — semantic merge is agent-side. (CONTEXT.md)
- **Retrieval** (`fact_search`): **brute-force filtered scan** — filter by
  Namespace + `superseded_by IS NULL` (+ optional tags/min-corroboration) first,
  `ORDER BY vector_distance_cos LIMIT k`. Exact, no ANN post-filter under-return.
  ANN (`vector_top_k`) deferred; scale path = one index per Namespace (the
  `namespace` column is already there). (ADR 0007)
- Turso native vector: `F32_BLOB(dim)`, `vector('[...]')`, `vector_distance_cos()`.

## 8. Scope boundaries

- **v1:** Blackboard + Journal + Claims/Leases + deadlock detection + embedded
  observability viz, single host, local Turso, TS/Node.
- **v1.5:** Fact store — Namespaces, explicit + auto-distilled Facts, server-side
  pinned embeddings (Qwen local default / MiniMax opt-in), supersede+corroborate
  dedup, brute-force semantic retrieval.
- **Deferred / revisit triggers:** connection pool, async writes, worker threads,
  or a distributed/multi-host topology all break the single-process invariant and
  reopen ADRs 0002–0005 (bring back MVCC or a distributed lock manager, distributed
  deadlock detection, and network/Cloud data paths). ANN index reopens at ~10^5+
  Facts per Namespace.
- **Cut:** Artifact/blob storage.

---

## 9. Decision index

- [ADR 0001](./docs/adr/0001-advisory-claims-over-shared-db.md) — advisory pre-flight Claims over a shared DB (MVCC dropped by amendment; enforced Blackboard writes)
- [ADR 0002](./docs/adr/0002-single-host-single-mcp-server-topology.md) — single-host, one MCP server over one local Turso file
- [ADR 0003](./docs/adr/0003-in-memory-lock-manager-blocking-claims.md) — in-memory lock manager, blocking claims, Turso as durable mirror
- [ADR 0004](./docs/adr/0004-deadlock-detection-wait-for-graph.md) — deadlock detection via wait-for graph, reject the requester
- [ADR 0005](./docs/adr/0005-typescript-node-single-threaded-lock-manager.md) — TypeScript/Node; event loop as the lock-manager mutex
- [ADR 0006](./docs/adr/0006-fact-pipeline-agent-distill-server-embed.md) — Fact pipeline: agent-side distillation, server-side pinned embeddings (Qwen local / MiniMax opt-in)
- [ADR 0007](./docs/adr/0007-fact-retrieval-brute-force-filtered-scan.md) — Fact retrieval: brute-force filtered scan, ANN deferred (amended: JSON vectors + JS cosine until the ANN migration)
- [ADR 0008](./docs/adr/0008-run-lifecycle-freeze-and-reclaim.md) — Run lifecycle: grace-period auto-end, enforced freeze on end, restart recovery sweep

## 10. Implementation notes (from building against the beta engine)

- **Turso driver is async.** `@tursodatabase/database` returns Promises from
  `run/get/all` (the sync compat wrapper is broken in this build). ADR-0005's
  atomicity is preserved by keeping in-memory lock mutations synchronous and
  routing DB persistence through a serialized `WriteQueue` (single-flight on the
  one connection). `journal()` assigns `seq` and publishes to the SSE bus
  synchronously; only the INSERT is enqueued.
- **Beta-engine gaps hit so far:** correlated subqueries are "not yet
  implemented" (panics the process) — `list_namespaces` uses two flat queries
  merged in JS instead. Watch for more of these.
- **Fact vectors are stored as JSON + cosine computed in JS**, not `F32_BLOB` +
  `vector_distance_cos`. This keeps the brute-force filtered scan (ADR 0007)
  provider-agnostic across differing dims and sidesteps vector-encoding quirks in
  the beta driver. Switch to native vectors when adding the per-Namespace ANN
  index at scale.
- **Embedding providers (`EMBED_PROVIDER`):** `qwen` (default) — real
  Qwen3-Embedding-0.6B via `@huggingface/transformers` (ONNX), 1024-dim,
  last-token pooling, instruction-prefixed queries, model cached locally after
  first download; `minimax` — MiniMax `embo-01` API (1536-dim); `local` — a
  zero-dep lexical stub for offline tests/CI. All share the identical pipeline
  (pinning, dedup, brute-force retrieval). Verified end-to-end: a paraphrase
  query with no keyword overlap retrieves the semantically-matching Fact first
  (`npm run test:qwen`, `npm run test:qwen:e2e`).

## 11. Known open items

Closed by the 2026-07-02 hardening pass (kept here for the record):

- ~~Blackboard value size caps~~ — 256KB serialized cap on Blackboard values and
  Journal payloads, `PAYLOAD_TOO_LARGE`.
- ~~Distiller missed-event hole~~ — the distiller now runs a catch-up scan on
  connect (any ended Run with no fact attributed to it gets distilled); repeat
  distillation stays deduped server-side.
- ~~Replay~~ — the viz has a replay scrubber for ended Runs; journaled
  `blackboard.write` entries now carry `{version, value}` so replay truly
  reconstructs Blackboard evolution (the §4 Seq invariant, now real).
- ~~Frozen-run enforcement~~ — `claim`/`bb_write`/`journal_append` on an ended
  Run are rejected (`RUN_ENDED`); `purge_run` refuses active Runs sans `force`.
- ~~Structured errors~~ — tools return `{ code, message }` instead of bare text.
- ~~renew/release ownership~~ — only the holding agent may renew or release.

Still open:

- **Dedup nuance**: a write ≥ T2-similar to an existing Fact corroborates and
  **discards the new wording** — a genuine update phrased near-identically loses
  its text. Defensible (the knowledge is "the same"), but an agent wanting the
  new wording must phrase it distinctly enough to supersede instead.
- **Journal durability counter**: a journal INSERT that fails after seq
  assignment is a permanent gap (SSE already published it). Detected and
  surfaced via `/api/health` (`journal_write_failures`); prevention would break
  the lock manager's synchronous-mutation guarantee (ADR 0005).
- **Deadlock edge staleness**: a waiter's blocked-behind set is snapshotted at
  enqueue; a cycle formed later (holder becomes waiter behind a new holder) is
  only broken by lease TTL.
- **Session idle-reaping**: a hard-crashed client's session lingers (lease TTL
  frees its Claims, but a Run whose only agents hard-crashed stays active until
  a restart) — see ADR 0008.
- Distiller Namespace routing is a single `DISTILL_NAMESPACE` (default
  `distilled`); no per-Run/per-domain mapping yet.
- Namespace re-embed migration (change of pinned model) has no tool; the pin
  guard throws, migration is manual.
- Long-Run file growth / retention cap (deferred).
- Auth: none in v1 (single-host, local); revisit if exposed over a network.
