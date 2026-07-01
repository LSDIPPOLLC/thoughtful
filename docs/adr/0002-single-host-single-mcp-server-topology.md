# 2. Single-host topology: one MCP server over one local Turso file

Date: 2026-07-01

## Status

Accepted

## Context

ADR 0001 chose advisory, pre-flight Claims over a shared database as the
coordination spine. That mechanism is only correct if **every claim check reads
authoritative, latest-committed state**. If an agent checks "is this Surface
free?" against stale data, two agents can both see a Surface as free, both claim
it, and coordination silently breaks — pushing the failure onto the MVCC
backstop, which only guards row-level write integrity, not coarse Surfaces.

Turso actively promotes topologies that are in tension with this:

- **Embedded replicas** — fast local reads that lag the primary. Excellent for
  read-scaling, poison for a coordination path: a claim check against a replica
  can read a stale (free) Surface that has already been claimed on the primary.
- **Turso Sync** — local read+write with push/pull reconciliation. Same hazard:
  local state diverges until sync.
- **Turso Cloud** — a shared remote DB; correct only if the claim path is forced
  to primary reads and never a replica.

The parallel agents in scope run as processes on a **single host** (e.g.
subagents of one orchestrator on one machine), not spread across machines.

## Decision

For v1, run **one MCP-server process** that holds **one connection to one local
`tursodb` database file**. All Claim, Blackboard, and Journal operations funnel
through this single process. Agents are MCP clients and **never open Turso
connections directly**.

Do not use embedded replicas, Turso Sync, or Turso Cloud in v1. Keep the
coordination path on a single authoritative serialization point.

Design the MCP boundary so that a future distributed deployment (central MCP
server reached over the network, or Turso Cloud with primary-only reads on the
claim path) can slot in without changing the agent-facing tool contract.

## Consequences

- Claim checks always observe the latest committed state — the staleness class of
  bug is eliminated by construction, not mitigated.
- The single MCP process is a natural serialization point and a single point of
  failure; if it dies, all coordination stops. Acceptable for single-host v1.
- No cross-machine agents in v1. Moving there later means reintroducing a network
  hop or Cloud, and explicitly forcing the claim path to primary reads — a change
  isolated to the server, not the agents, thanks to the MCP boundary.
- Embedded replicas / Sync remain available later for read-heavy, non-coordination
  paths (e.g. serving the visualization layer), where staleness is tolerable.
- Local file + single process keeps v1 latency low and setup trivial (no Cloud
  account, no network).
- **A single process holding a single connection serializes every write, which is
  itself the write-integrity guarantee.** This makes the MVCC / `BEGIN CONCURRENT`
  backstop proposed in ADR 0001 redundant for v1 — there is no concurrent writer
  at the storage layer to reconcile. v1 uses plain transactions on the one
  connection; MVCC is dropped (see the amendment in ADR 0001) and returns to scope
  only if this single-connection invariant is broken (connection pool, async
  writes, or distributed topology).
