# 8. Run lifecycle — grace-period auto-end, freeze on end, restart recovery

Date: 2026-07-02

## Status

Accepted

## Context

`src/server.ts` referenced an "ADR: Run lifecycle" that was never written; the
behavior existed in code (and CONTEXT.md prose) without a recorded decision.
This ADR records it, including the enforcement added in the 2026-07-02 hardening
pass.

A Run groups the agents, Blackboard, Journal, and Claims of one collaborative
execution. Its lifecycle needs three answers: when does a Run end, what does
"ended" mean for its data, and what happens to Runs orphaned by a server crash?

## Decision

**Ending.** A Run ends explicitly (`end_run`) or automatically: when an agent's
MCP session terminates, its Claims are reclaimed immediately and, if it was the
Run's last active agent, the Run is ended after a grace period (`GRACE_MS`, env,
default 10s) — the grace lets an agent reconnect or a successor join without
tearing the Run down. Note the trigger is a *clean* session termination (HTTP
DELETE); a hard-crashed client's Claims are reclaimed by lease TTL, but its
session lingers and cannot trigger auto-end (see Consequences).

**Freeze.** An ended Run is **frozen**: all its Claims are released, and the
server *enforces* immutability — `claim`, `bb_write`, and `journal_append`
against an ended Run are rejected with `RUN_ENDED`. Reads (`bb_read`,
`journal_read`, the viz APIs) remain available indefinitely for replay.
`purge_run` is the only deletion path and refuses active Runs unless passed
`force=true`.

**Restart recovery.** MCP sessions and the lock manager are in-memory (ADR
0003), so nothing of a live Run's coordination survives a server restart. On
boot the server sweeps: stale `granted` claim rows are marked `expired`,
lingering agents are marked left, and every still-`active` Run is ended with a
journaled `run.ended {reason: "server restarted"}` — otherwise such Runs would
stay active forever, since the disconnect events that drive auto-end can never
fire for them.

## Consequences

- "Frozen" is a server guarantee, not a convention — replay tooling and the
  distiller can trust that an ended Run's Journal and Blackboard never change.
- The `run.ended` journal entry doubles as the distiller's trigger (live SSE)
  and its catch-up marker (a restart-ended Run still gets distilled).
- A client that vanishes without a clean session termination leaves its session
  entry behind: lease TTL frees its Claims, but a Run whose only agents hard-
  crashed stays active until a server restart. A session idle-reaper would close
  this; deferred (v1 is single-host, low session counts).
- `GRACE_MS` is env-tunable, which the test suite uses to exercise auto-end
  quickly.
