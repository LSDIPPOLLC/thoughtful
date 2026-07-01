# 6. Fact pipeline — distillation is agent-side, embedding is server-side and pinned

Date: 2026-07-01

## Status

Accepted (scopes v1.5)

## Context

The Fact store (v1.5) holds durable, deduplicated, semantically-searchable
knowledge that outlives Runs, scoped by Namespace (see CONTEXT.md). Facts are born
two ways (both in scope): explicit `fact_write` by an agent, and auto-distillation
of a finished Run's Journal. Two questions follow, and they pull in opposite
directions on one principle.

Throughout the design the MCP server has been **pure, model-agnostic
infrastructure** — it never sees which model an agent uses (MCP is model-agnostic;
ADRs 0002–0005). Facts threaten that on two fronts:

1. **Distillation** (read a Journal → summarize → candidate Facts) requires a
   *generative* LLM. If the server does this it becomes model-aware: API keys,
   model config, and coupling the coordination infra to a specific model.

2. **Embedding** (text → vector, for search) requires that *every Fact in a
   Namespace share one embedding space* — different models produce incomparable
   vectors and silently break similarity search. Consistency is a correctness
   property, and only a single authority can guarantee it.

These two look similar ("the server needs a model") but are different in kind: one
is generative reasoning, the other is a fixed index function.

## Decision

Split the pipeline along that line:

- **Distillation is agent-side.** A "distiller" is just another agent role: it
  reads a frozen Journal via the existing `journal_read` and writes Facts via
  `fact_write`. The server provides the *mechanism* (journal read, fact write,
  dedup) but not the *policy* (what/how to distill). "Auto" distillation is a
  convention: the server emits a `run.ended` event (over the existing SSE stream)
  and the orchestrator spawns a distiller; a manual trigger also exists. The
  distiller may use any model (including an open/Chinese model) independent of the
  other agents — the server neither knows nor cares.

- **Embedding is server-side, with one pinned model per Namespace.** The server
  computes embeddings on every `fact_write` and `fact_search` using a single
  configured embedding provider (pluggable at deploy time: a local open model such
  as bge/e5/gte by default — small, private, no API key — or an API). The chosen
  `embed_model` and its `dim` are **stored on the Namespace**. The server rejects
  a write or search whose configured model does not match the Namespace's pinned
  model until a re-embed migration is run.

This refines, rather than breaks, the model-agnostic principle: **the server is
agnostic to the reasoning/chat model (the agents' concern) but owns exactly one
embedding model as infrastructure**, because vector-space consistency is a
correctness guarantee only the server can provide. Embedding is an index function
like a hash, not generative reasoning.

## Consequences

- The server stays free of any generative/chat LLM and remains testable without a
  model. The one dependency it gains is a deterministic embedding function.
- "Auto" distillation is flexible: prompt and model are the distiller agent's
  concern and can change without touching the server. Distiller runs are
  themselves ordinary agents, so their Fact writes carry normal provenance.
- Distillation quality (hallucinated or noisy Facts) is an agent/prompt problem,
  isolated from the storage layer, and gated by the same dedup path as explicit
  Facts.
- The embedding model is **hard to change**: switching it invalidates every stored
  vector in a Namespace and forces a re-embed migration. Pinning `embed_model` +
  `dim` on the Namespace makes this explicit and prevents silently mixing spaces.
- Namespaces can use different embedding models from each other (each pins its
  own), but never mix within one.
- Adds an embedding provider abstraction and a per-Namespace model guard to the
  server; the local-model default keeps v1.5 self-contained and private.

## Embedding providers (resolved)

- **Default: Qwen3-Embedding-0.6B**, local, run **in-process** (ONNX /
  Transformers.js). 1024-dim (Matryoshka-truncatable). Private, offline, no key —
  keeps v1.5 self-contained per the design's single-host ethos.
- **Opt-in: MiniMax `embo-01`** (API, 1536-dim). A first-class provider for
  Namespaces where convenience outweighs sending Fact text off-host.
- The provider interface takes a **role** (`doc` | `query`) so asymmetric models
  work: Qwen3 uses an instruction prefix for queries; MiniMax uses its `db` vs
  `query` embedding types. `fact_write` embeds as `doc`, `fact_search` as `query`.
- Per-Namespace pinning (above) means both can coexist — e.g. local for sensitive
  Namespaces, MiniMax for others.

## Open

- Dedup threshold and merge policy on `fact_write` — resolved in ADR 0007 context
  / CONTEXT.md (supersede at cosine ≥ T, corroborate at ≥ T2, no server merge).
