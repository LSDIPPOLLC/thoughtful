# 5. TypeScript on Node — single-threaded event loop as the lock-manager mutex

Date: 2026-07-01

## Status

Accepted

## Context

A single process (ADR 0002) hosts the MCP tool server, the in-memory lock manager
with blocking claims and per-Surface wait queues (ADR 0003), the wait-for graph
for deadlock detection (ADR 0004), a read-only HTTP + SSE endpoint, and the static
visualization SPA. The runtime/language for that process is still open.

The in-memory lock manager is the correctness-critical piece: overlap checks,
grant/queue decisions, wait-queue mutation, lease bookkeeping, and wait-for-graph
cycle checks must all be race-free. In a multi-threaded runtime this requires
explicit synchronization (mutexes/channels) around shared lock state, which is
easy to get subtly wrong.

Candidates:

- **TypeScript / Node (or Bun)** — reference-grade MCP SDK, Turso JS SDK, trivial
  HTTP/SSE and static serving. Single-threaded event loop.
- **Rust** — native `tursodb`, best raw performance and concurrency, cleanest path
  to a future distributed deployment; but requires explicit synchronization for
  the lock manager, has a less mature MCP SDK, and slower iteration.
- **Python** — solid MCP SDK and asyncio, but the weakest single-process story for
  SSE plus serving the SPA.

## Decision

Build the server in **TypeScript on Node**.

The deciding factor is that Node's **single-threaded event loop acts as an
implicit mutex** over the entire in-memory lock manager. Any synchronous run of
JavaScript executes to completion without preemption, so an overlap check plus the
grant/queue mutation it implies is atomic *by construction* — no locks, no
critical sections to reason about. This maps directly onto ADR 0003:

- a blocking `claim` is simply a **pending Promise** parked in a per-Surface
  queue, resolved when `release`/expiry frees the Surface;
- wait queues and the wait-for graph are **plain in-memory data structures**
  mutated only from event-loop turns, so they are never observed half-updated;
- SSE, static SPA serving, and the MCP SDK are all first-class in one process.

This is a v1/beta exploration where iteration speed matters, which also favors TS.

Bun is an acceptable drop-in if its speed and built-in serving are wanted; Node is
the default for MCP-SDK maturity. This choice is reversible relative to the
harder-to-reverse ADRs.

## Consequences

- The lock manager is race-free without any explicit locking — a large reduction
  in the concurrency-correctness surface, directly enabled by the runtime choice.
- CPU-bound work would block the event loop and stall all agents; the workload
  here (lock bookkeeping, small JSON, SQLite calls) is I/O-bound and fine, but any
  future CPU-heavy feature must move to a worker and re-examine atomicity
  assumptions.
- Ties the lock manager's correctness argument to the single-threaded model. If
  the server ever adopts worker threads, a cluster, or a distributed topology, the
  implicit-mutex guarantee is lost and ADRs 0003/0004 must be revisited alongside
  this one.
- Uses the Turso JS SDK rather than native Rust bindings; acceptable for an
  I/O-bound single-host workload, and it keeps the whole system in one language
  (server + SPA).
