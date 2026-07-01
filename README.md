# thoughtful

Shared agentic memory — an **MCP coordination server over Turso** that lets
parallel agents share live working state without clobbering each other, with an
embedded observability UI.

See [DESIGN.md](./DESIGN.md) for the full design, [CONTEXT.md](./CONTEXT.md) for
the glossary, and [docs/adr/](./docs/adr/) for the load-bearing decisions.

## v1 scope

- **Blackboard** — KV-by-Surface live shared state; writes require a live
  exclusive Claim (enforced).
- **Journal** — append-only, `seq`-ordered, replayable history.
- **Claims** — pre-flight, tiered (shared/exclusive), leased, atomic bundles, with
  an in-memory lock manager, blocking long-poll, and wait-for-graph deadlock
  detection.
- **Viz** — embedded read-only HTTP + SSE UI. Two modes: a one-Run dashboard
  (agents, locks, blackboard, seq journal, wait-for graph) and a Namespace-scoped
  **Facts** view with live semantic search.

Facts / semantic memory are v1.5 (not yet built).

## Run it

```bash
npm install
npm run dev          # tsx watch — MCP at http://localhost:8787/mcp, viz at http://localhost:8787/
```

Env: `PORT` (default 8787), `DB_PATH` (default `thoughtful.db`).

## Architecture in one breath

One Node process (single-threaded event loop = the lock-manager mutex) holds one
connection to one local Turso file. Agents are MCP clients over Streamable HTTP;
**one session = one agent**, and a disconnect reclaims that agent's Claims. All
writes serialize through the single connection — that is the write-integrity
guarantee (no MVCC). See ADRs 0002–0005.

## MCP tools (16 total; 13 in v1)

| Group | Tools |
|-------|-------|
| Run / identity | `create_run` · `join_run` · `list_runs` · `whoami` · `end_run` · `purge_run` |
| Claims | `claim` · `renew` · `release` |
| Blackboard | `bb_read` · `bb_write` |
| Journal | `journal_append` · `journal_read` |
| Facts (v1.5) | `fact_write` · `fact_search` · `list_namespaces` |

### Surfaces

Claim/Blackboard keys are Surface strings:

- `path:repo/src/auth/login.ts` — overlap by hierarchical prefix.
- `entity:user:1234` — overlap by exact match.

A bare string is treated as a path.

### Typical flow

```
create_run                    -> { run_id }
join_run(run_id)              -> { agent_id }        # per agent
claim(["path:repo/src/auth"], mode="exclusive", block=true)
bb_write("path:repo/src/auth/login.ts", { status: "editing" })
journal_append("note", { msg: "refactoring auth" })
release(claim_id)
```

## Project layout

```
src/
  types.ts        domain types
  surface.ts      Surface parsing + overlap math
  db.ts           Turso connection + schema
  bus.ts          in-process event bus (feeds SSE)
  store.ts        Runs/Agents/Journal(seq)/Blackboard over Turso
  lockManager.ts  in-memory claims, leases, wait queues, deadlock detection
  embeddings.ts   pluggable embedding providers (Qwen, MiniMax, local stub)
  factStore.ts    Facts v1.5 — namespaces, dedup, brute-force retrieval
  summarizer.ts   distiller summarizers (heuristic, MiniMax chat)
  distiller.ts    standalone distiller harness (watch + one-shot)
  mcp.ts          the 16 MCP tools
  server.ts       HTTP: MCP session transport + viz API/SSE + static
  index.ts        bootstrap
web/index.html    two-mode viz (Runs dashboard + Facts); Cytoscape wait-for graph
test/             smoke · distiller · qwen · qwen-e2e
```

## Auto-distillation (Facts from finished Runs)

The distiller is a **separate agent-side process** (the server stays
model-agnostic). It watches the global `run.ended` stream, reads a finished Run's
Journal + final Blackboard, summarizes them into Facts, and writes them via
`fact_write` (attributed to the source Run).

```bash
npm run distiller              # watch mode — auto-distills every Run as it ends
npm run distiller <run_id>     # one-shot — distill a single Run
```

Env: `DISTILL_NAMESPACE` (default `distilled`), `SUMMARIZER` (`heuristic`
default, offline; `minimax` for real generative distillation), `MCP_URL`.

## Facts (v1.5) — implemented

- `fact_write` / `fact_search` / `list_namespaces`.
- Namespaces pin one embedding model + dim (guarded against drift).
- Dedup: near-identical text corroborates (`corroboration_count`), an update
  supersedes (kept for history, excluded from search).
- Retrieval: brute-force filtered cosine scan (namespace + active first).
- Embedding provider is pluggable via `EMBED_PROVIDER`:
  - `qwen` **(default)** — real Qwen3-Embedding-0.6B via Transformers.js (ONNX),
    1024-dim, local/offline after first model download.
  - `minimax` — MiniMax `embo-01` API (needs `MINIMAX_API_KEY` + `MINIMAX_GROUP_ID`).
  - `local` — zero-dep lexical stub for offline tests.

```bash
npm test              # core pipeline, offline (local stub)
npm run test:qwen     # real Qwen embedder — downloads model, checks semantics
npm run test:qwen:e2e # real semantic retrieval through the full MCP stack
```

## Status

**Full system verified end-to-end.** `npm test` boots the server and drives live
MCP agent sessions through **20 assertions, all passing**: exclusive grant,
enforced Blackboard writes, overlapping-claim denial + attribution, sibling
non-conflict, shared+shared coexistence, blocking-claim queue→grant, wait-for
deadlock detection + reject, seq-ordered journalling, and the full Fact flow
(write, corroborate, distinct, semantic search, namespace pinning).

```bash
npm run typecheck   # clean
npm test            # ALL PASS
```

See DESIGN.md §10 for implementation notes (async Turso driver, beta-engine
quirks, embedding stub). Next: wire a real Qwen embedder and surface Facts in the
viz.
