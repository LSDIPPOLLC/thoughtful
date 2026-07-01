# Context Glossary

The ubiquitous language for this project: an agentic memory system that lets
parallel agents share memory/context, exposed over MCP, backed by Turso, with a
visualization layer.

## Terms

### Memory (umbrella)
Overloaded on its own — always qualify as one of the four kinds below. Never use
"memory" bare in design discussion.

### Fact  (v1.5)
Durable, distilled unit of knowledge (e.g. "user prefers X", "endpoint Y returns
Z"). Deduplicated. Queried by relevance (semantic search). Survives across
sessions and Runs. Unlike Blackboard/Journal, a Fact is **not Run-scoped** — it
outlives the Run that produced it. A Fact belongs to a Namespace and carries
provenance (`source_run_id`, `source_agent_id`, `created_at`).

Dedup (server-side, mechanical, within a Namespace): on write the server embeds
the text and compares to active Facts. If cosine ≥ `T` (configurable, ~0.95) the
new Fact is inserted active and the old is marked `superseded_by` — kept for
history/provenance but excluded from retrieval (last-write-wins with audit
trail). If cosine ≥ a higher `T2` (~0.98, near-identical) the server instead bumps
a `corroboration_count` on the existing Fact ("confirmed again") rather than
superseding. The server never merges text — semantic merge, if wanted, is an
agent reading both and writing a combined Fact (see ADR 0006).

### Namespace
The durable-knowledge boundary: a flat named scope for Facts (e.g.
`repo:thoughtful`, `domain:payments`). Fact retrieval always filters by
Namespace, so unrelated domains never pollute each other's search results. A Run
*references* a Namespace but does not own it.

Note the split: **Run is the ephemeral-collaboration boundary; Namespace is the
durable-knowledge boundary.** They cross-reference (a Fact remembers its source
Run) but neither owns the other.

### Journal
Append-only episodic record for a Run — the replayable history. One stream from
two sources:

- **System events** — the MCP server auto-emits `claim.granted`,
  `claim.denied`, `claim.released`, `claim.expired`, `blackboard.write`,
  `agent.joined`, `agent.left`. Every Blackboard write auto-emits a
  `blackboard.write` event.
- **Agent entries** — free-text/JSON an agent posts (reasoning, observations).

Entry shape: `{run_id, seq, agent_id, ts, type, surface?, payload}`.

### Seq
A per-Run monotonic sequence number stamped on every Journal entry, assigned by
the single MCP server process (see ADR 0002). It defines a deterministic **total
order** for the Run — replay and the viz timeline order by `seq`, not wall-clock
`ts` (which can tie or skew). Because Blackboard writes are journaled, replaying
`blackboard.write` events in `seq` order reconstructs Blackboard evolution — this
is why the Blackboard itself can be latest-only.

### Blackboard
Live shared working state that multiple agents read and write *during* a task to
coordinate. A key/value store scoped to a Run:

- **Key = a Surface** (path or entity) — the same keyspace as Claims. The thing
  you claim is the thing you write.
- **Value = opaque JSON blob + metadata**: author `agent_id`, monotonic
  `version`, `updated_at`. The server does not interpret the blob.
- **Latest-only** — the Blackboard holds current state ("what is true now").
  History/evolution lives in the Journal, not here.
- **Enforced writes** — the server rejects a write to a cell unless the caller
  holds a live *exclusive* Claim covering that cell's Surface (see ADR 0001,
  advisory-vs-enforced amendment). Reads require at most a shared Claim.

### Agent
An independent unit of execution. Multiple agents run in parallel and share the
memory kinds above through the MCP server. An agent calls `register` to obtain a
server-issued `agent_id`, which is bound to its MCP session. Liveness: a clean
session disconnect triggers grace-period reclaim of the agent's Claims; the Lease
TTL is the backstop for hard crashes where the session lingers. Every Claim and
Journal entry is attributed to an `agent_id`.

### Run
The top-level grouping: a single collaborative execution that a set of agents
join. Blackboard state, Journal entries, and Claims are all scoped to a Run — so
Surface overlap is only ever computed *within* a Run (two agents in different
Runs claiming the same path do not conflict). The visualization layer shows one
Run at a time.

A Run is `active` or `ended`. It ends explicitly (`end_run`) or automatically
when the last agent disconnects after a grace period. On end, all Claims are
released and the Blackboard + Journal are **frozen** (immutable) but fully
retained and queryable for replay. Ended Runs are kept indefinitely in v1 and
removed only by an explicit `purge_run`.

### Surface
The unit two agents can collide on; what a Claim is expressed over. A Surface has
a *kind*, and overlap is only ever computed between Surfaces of the same kind
(cross-kind Surfaces never conflict). Two kinds:

- **Path surface** — a hierarchical string key (`repo/src/auth/login.ts`,
  `design/payment-schema`, `db/migration/007`). Overlap = prefix relation: an
  ancestor and a descendant collide (`repo/src/auth` vs `repo/src/auth/login.ts`);
  siblings do not (`repo/src/auth` vs `repo/src/db`).
- **Entity surface** — a typed identifier, `type:id` (`user:1234`, `order:987`).
  Overlap = exact match on the `type:id` pair. No prefix logic (`user:12` does
  not collide with `user:1234`).

Choosing a Surface's grain is the claiming agent's judgment: too coarse yields
false conflicts, too fine misses real ones.

### Claim
An agent's pre-flight declaration of intent to work on one or more Surfaces
(pre-flight, per ADR 0001). Properties:

- **Bundle** — one Claim can cover multiple Surfaces of mixed kinds. Granted
  atomically, all-or-nothing (no partial acquisition — avoids mutual deadlock).
- **Mode** — *shared* (read intent; many holders allowed) or *exclusive* (write
  intent; single holder). Overlap resolution follows reader/writer-lock rules:
  shared+shared both granted; exclusive vs anything overlapping → denied/queued.
- **Lease** — every Claim carries a TTL. On expiry it is auto-reclaimed (covers
  crashed agents, no permanent deadlock). A long-held Claim must be renewed
  (heartbeat) or it is lost mid-work.

On overlap the loser is denied and queued until release/expiry. (Queuing needs a
wait/notify mechanism; Turso has no native pub/sub, so poll vs. app-level signal
is still TBD.)

### Lease
The TTL on a Claim. Ties a Claim's validity to agent liveness via renewal
(heartbeat). Expiry releases the Claim automatically.

## Coordination requirement

Agents ideally work on disjoint pieces, but the system MUST let an agent detect
when it is about to touch the same *Surface* as another agent, and resolve the
conflict. Conflict handling is a first-class feature, not an afterthought.

Consequence: agents must *declare intent* before working; the system cannot
infer what an agent will touch. This declaration is a Claim (see below, TBD).

(Artifact storage — produced output/blob handoff — was considered and cut from
scope.)
