# 4. Deadlock detection via a wait-for graph; reject the requester

Date: 2026-07-01

## Status

Accepted

## Context

Claims are atomic bundles (ADR 0001) and can block server-side on an in-memory
wait queue (ADR 0003). Atomicity prevents deadlock *within a single `claim`
call — all Surfaces in a bundle are acquired together or not at all. It does not
prevent **sequential deadlock across calls**:

    agent1 holds Claim on A, then blocking-claims B
    agent2 holds Claim on B, then blocking-claims A
    → both wait forever, until their Leases expire

Incremental claiming (hold some Surfaces, discover you need more, claim again) is
a legitimate agent pattern, so we do not want to forbid holding a Claim while
acquiring another. That leaves a real deadlock hole to close.

Separately, the visualization layer needs a **contention graph**: a wait-for
graph where agents are nodes and a directed edge `B → A` means "B is queued on a
Surface that A holds," labelled with the contended Surface. This is exactly the
structure needed to detect a deadlock — a cycle in the wait-for graph *is* a
deadlock.

## Decision

Maintain a **wait-for graph** in the in-memory lock manager. Nodes are agents;
add a directed edge `requester → holder` for each Surface a blocking `claim`
is queued on. When a `claim` would introduce an edge that **closes a cycle**,
do not enqueue it — **reject it immediately with a `DEADLOCK` error**, naming the
requester as the victim and reporting the cycle.

The rejected agent handles the error explicitly (release what it holds and retry,
back off, or restructure into a single atomic bundle).

Lease TTL (ADR 0001) remains the ultimate backstop for any stall that escapes
detection.

Do **not** adopt the stricter alternative of allowing only one held Claim bundle
per agent (prevention by restriction) — it would forbid legitimate incremental
claiming.

## Consequences

- Deadlocks are caught at the moment they would form, not after a full TTL of two
  stalled agents. Failure is a clean, immediate, actionable error rather than a
  silent hang.
- Detection is nearly free: the wait-for graph is already built for the
  visualization layer, so it does double duty (debugging view + deadlock
  prevention). Cycle-closing is checked incrementally on each blocking `claim`.
- The victim is always the requester whose claim would close the cycle — simple,
  predictable, and it never revokes a Claim an agent already holds (no rollback of
  in-progress work).
- Agents must handle a `DEADLOCK` response, distinct from `denied`/`queued`. This
  is part of the tool contract.
- Correctness relies on the single in-memory lock manager (ADR 0002/0003) seeing
  all Claims and waits. A future distributed deployment would need a distributed
  deadlock-detection scheme and must revisit this.
- Only true cycles are rejected; ordinary contention still queues and waits
  normally, so incremental claiming remains available up to the point it would
  actually deadlock.
