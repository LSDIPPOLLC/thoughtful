# 1. Advisory claims over a shared DB for agent coordination

Date: 2026-07-01

## Status

Accepted

## Context

The system lets multiple agents run in parallel and share memory (Blackboard,
Journal; Fact deferred) through an MCP server backed by Turso. Agents ideally
work on disjoint pieces, but a first-class requirement is that an agent can
understand it is *about to start* touching the same Surface as another agent, and
resolve the conflict.

The phrase "about to start" makes this a **pre-flight** requirement: a conflict
must be detectable *before* an agent does expensive work, so it can back off,
wait, or negotiate.

Turso's recent Rust rewrite offers two native mechanisms that are tempting to
lean on, but neither satisfies the requirement on its own:

- **MVCC / `BEGIN CONCURRENT`** — multiple writers, snapshot-per-transaction.
  If two transactions touch the same rows, one receives a conflict error and
  must roll back and retry (no automatic retry; the client detects the error and
  retries). This is **write-integrity** protection at *commit* time — it is
  post-hoc and row-grained. It does not tell an agent, before it starts, that a
  coarser Surface is already being worked.
- **AgentFS** — a SQLite-backed, copy-on-write **isolation** layer: each agent
  gets its own sandboxed view and changes are reconciled at merge. AgentFS is
  isolation-first, which is the opposite of a shared Blackboard, and its conflict
  surfacing is also post-hoc (at merge).

Two coordination models follow from these:

- **Model A — Advisory Claims (pre-flight).** A single shared database. Before
  working, an agent declares intent on a Surface (a Claim). The system checks for
  overlap with existing Claims and grants, denies, or warns. Conflicts are caught
  *before* the work.
- **Model B — Optimistic Merge (post-hoc).** Each agent works in isolation (an
  MVCC transaction or an AgentFS branch); conflicts surface at commit/merge and
  the loser retries or redoes the work.

Model B is what Turso gives natively and requires less bespoke code, but it
detects conflicts only after work is done — wasting agent effort and tokens — and
in the AgentFS case actively hides shared state, defeating the Blackboard.

## Decision

Use **Model A**: a single shared Turso database with an explicit **Claim** layer
that agents must consult before touching a Surface. Claims are advisory and
pre-flight — the coordination spine of the system.

Underneath, use MVCC `BEGIN CONCURRENT` as a **write-integrity backstop** so that
any race that slips past the advisory layer cannot corrupt data (the loser gets a
conflict error and retries). Advisory claims lead; MVCC only backstops.

> **Amendment (2026-07-01, superseded by ADR 0002/0003 reasoning): MVCC dropped
> from v1.** Once ADR 0002 funnels every write through a single process holding a
> single Turso connection, all writes are already serialized at the storage layer
> — there is no second concurrent writer for MVCC to reconcile. The logical
> concurrency is resolved above the DB by the in-memory lock manager (ADR 0003).
> The MVCC "backstop" therefore guards a race that cannot occur in v1, while
> adding a beta/experimental dependency detected via error-string matching. v1
> uses **plain transactions on the single serialized connection**; the
> single-process design *is* the write-integrity guarantee. MVCC returns to scope
> only if v1 adopts a connection pool, async writes, or a distributed topology —
> the same conditions ADRs 0002/0003 already flag for revisiting. Read the
> paragraph above and the two MVCC mentions below as historical.

**Advisory vs enforced (amended).** "Advisory" applies to *planning and
negotiation*: an agent may declare intent on arbitrary Surfaces to coordinate,
and overlap there is surfaced as grant/deny/warn without the system policing what
the agent then does off-Blackboard. But for **Blackboard mutation the Claim is
mandatory**: the server **rejects** a write to a Blackboard cell unless the caller
holds a live *exclusive* Claim covering that cell's Surface. So Claims are
advisory at the coordination layer and enforced at the write boundary. This is
not a contradiction — it is the point at which "should not collide" becomes
"cannot collide," giving the coordination requirement real teeth while keeping
negotiation lightweight. MVCC remains the final backstop beneath even enforced
writes.

Do **not** build the memory core on AgentFS. Its KV store, change-audit log, and
MCP-server mode may be reused as components, and its branch/snapshot model may
inform the visualization layer, but AgentFS is not the coordination substrate.

## Consequences

- We own a Claim protocol (declare intent, overlap check, grant/deny/warn,
  release, expiry/lease) — this is bespoke code, not something Turso provides.
- Conflicts are caught before expensive work, preserving agent effort and tokens.
- Agents must cooperate: coordination only works if every agent declares intent
  before touching a Surface. A misbehaving agent that skips claiming is caught
  only by the MVCC backstop, and only at row granularity.
- MVCC is currently beta/experimental in Turso, and conflict detection is exposed
  via error-string matching rather than a typed error. We depend on it only as a
  secondary safety net, which bounds that risk.
- The definition and granularity of a **Surface** becomes the next critical
  design decision, since Claims are expressed in terms of Surfaces.
- There is no native pub/sub in Turso, so *notifying* a waiting agent that a
  Claim was released will require polling or an application-level mechanism — a
  decision still to be made.
