# 3. In-memory lock manager with blocking claims; Turso as durable mirror

Date: 2026-07-01

## Status

Accepted

## Context

Claims can be denied and queued (ADR 0001): a shared/exclusive, leased, atomic
bundle is refused when it overlaps an active Claim, and the loser waits until the
Surface is released or the Lease expires. This raises two coupled questions:

1. **How does a queued agent learn its Surface became free?** Turso has no native
   pub/sub, LISTEN/NOTIFY, or live-query. The naive answer is client polling —
   each waiting agent re-tries `claim` on a backoff — which wastes calls and adds
   latency equal to the poll interval.

2. **Where does Claim/Lease state actually live?** It could be rows in Turso read
   back on every check, or in-process state.

ADR 0002 already funnels every operation through a **single MCP-server process**
over one local database. That process is a natural, consistent serialization
point — which makes an in-process lock manager both possible and cheap, and makes
DB-round-tripping every lock check redundant.

## Decision

Implement the Claim/Lease system as an **in-memory lock manager inside the single
MCP-server process**:

- **In-memory-authoritative.** The process's memory is the source of truth for
  active Claims, Leases, and per-Surface wait queues. Overlap checks run against
  memory, not a DB read.
- **Blocking `claim` (server-side long-poll).** A `claim` that cannot be granted
  immediately blocks server-side on an in-memory per-Surface wait queue until it
  is granted or a timeout elapses. `release` and Lease expiry wake queued waiters
  directly via in-process signaling — instant, no polling, no Turso pub/sub. On
  timeout the call returns "still queued" and the agent decides to re-wait or give
  up.
- **Write-through to Turso for durability.** Claim grants/releases/expiries are
  mirrored to Turso for crash recovery and to feed the visualization layer, but
  Turso is not consulted on the hot path of an overlap check.

Turso remains the **system of record for Blackboard and Journal**. For Claims it
is a **durable mirror** of in-memory truth, not the primary.

## Consequences

- Queued agents are woken the instant a Surface frees; no poll-interval latency,
  no wasted retries, no dependency on a pub/sub feature Turso lacks.
- Lock checks are memory-fast and never race against replica staleness (already
  excluded by ADR 0002).
- The in-memory manager is a single point of failure: if the process dies,
  in-flight blocking `claim` calls drop and active (non-expired) Claims are gone
  from memory. The write-through mirror in Turso allows reconstructing which
  Claims/Leases were live at crash time; on restart the manager rehydrates from
  the mirror and lets Leases expire naturally. Blackboard and Journal are
  unaffected (Turso is their system of record).
- Blocking calls hold a server request open per waiting agent. On a single host
  with a bounded agent count this is fine; a future distributed deployment would
  need to revisit this (e.g. bounded wait pool, or MCP notifications instead of
  long-poll).
- Correctness depends on the single-process invariant from ADR 0002. If that ever
  changes (multiple server processes), the in-memory lock manager is no longer
  authoritative and this decision must be revisited (distributed lock manager, or
  move authority into Turso transactions).
