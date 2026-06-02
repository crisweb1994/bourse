---
name: Feature request
about: Propose a new capability or improvement
title: "[feat] "
labels: enhancement
---

## What problem are you trying to solve

<!-- Describe the user-facing pain. Not "I want feature X" but "today I can't do Y because..." -->

## Proposed solution

<!-- What would the API / UI / behavior look like? Sketches welcome. -->

## Alternatives considered

<!-- Any existing workaround? Why is it not enough? -->

## Does this touch a hard invariant?

The project's 6 hard invariants cannot be relaxed without an RFC:

1. Code computes, LLM judges (no LLM-recomputed numbers)
2. fetchSnapshot once per analysis
3. Snapshot is a value (no intermediate persistence)
4. Schema-first (zod → `z.infer`)
5. Provenance mandatory (`retrievedAt` on every citation)
6. Auth + CSRF on mutating endpoints

- [ ] My request respects all six
- [ ] My request needs an RFC discussion first

## Scope

- [ ] Frontend only (`apps/web`)
- [ ] Backend only (`apps/api`)
- [ ] Analysis core (`packages/analysis`)
- [ ] New connector / data source
- [ ] New persona
- [ ] New compute metric
- [ ] MCP server
- [ ] Docs / DX only
