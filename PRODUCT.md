# Product

## Register

product

> Per-task override: the GitHub Pages site (`docs/index.html`) is a **brand** surface — treat work on it in the brand register.

## Users

Engineers running fleets of parallel AI agents (Claude Code orchestrators, open-source coding agents) who need those agents to share live state without collisions. Secondary: the same engineers as *operators*, watching a run through the embedded viz to debug contention, deadlocks, and memory. Technical, terminal-native, skeptical of magic — they read ADRs.

## Product Purpose

thoughtful is an MCP coordination server over Turso: pre-flight claims, enforced blackboard writes, seq-ordered journal, deadlock detection, and durable semantic memory (Facts). Success = an agent fleet that provably cannot clobber itself, plus an observability UI that makes a parallel run legible at a glance. The docs site's job is to make a systems-minded visitor think "this is rigorously designed" and reach the quickstart.

## Brand Personality

Precise, engineered, calm. Systems-paper energy: invariants, named trade-offs, "one decision cascades." Confidence through rigor, not flash. Copy states guarantees plainly ("cannot collide", "rejected before the work") and never hypes.

## Anti-references

- Generic AI-SaaS landing slop: gradient-text heroes, hero-metric templates, glassmorphism cards.
- Breathless dev-tool marketing ("10x your agents!", rocket emoji energy).
- Enterprise-brochure vagueness — every claim on the site must map to a real mechanism in the code.

## Design Principles

1. **Show the mechanism.** Diagrams and demos depict the actual protocol (claims, denials, wait-for graphs), never abstract decoration.
2. **Guarantees, stated flatly.** The voice earns trust by being checkable — if the site says it, an ADR or test proves it.
3. **The viz is the brand.** Live contention made legible is the product's most distinctive artifact; lean on it.
4. **Small, precise vocabulary.** Run, Surface, Claim, Blackboard, Journal, Fact — the site teaches the glossary, it doesn't invent synonyms.
5. **Dark, engineered materiality.** Terminal-adjacent surfaces (mono labels, grid lines, measured glow) — not costume, the actual working environment of the audience.

## Accessibility & Inclusion

Best-effort: fix obvious contrast and keyboard issues, honor `prefers-reduced-motion`, don't chase full WCAG AA conformance.
