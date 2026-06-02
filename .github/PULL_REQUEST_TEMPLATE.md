<!-- Thanks for the PR! Please fill the sections that apply. -->

## What & why

<!-- 1–3 sentences. The "why" matters more than the "what" — the diff shows the what. -->

## How to test

<!-- Commands to run / pages to open / fixtures to load -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Docs / DX
- [ ] Test only
- [ ] New connector
- [ ] New persona
- [ ] New compute metric

## Hard-invariant checklist

The project's six hard invariants cannot be relaxed without an RFC. Confirm none of them are violated:

- [ ] Code computes, LLM judges — no new LLM-derived numbers
- [ ] `fetchSnapshot` is called at most once per analysis
- [ ] No new intermediate-state persistence
- [ ] All new public types are zod-schema-first
- [ ] Every new citation surface carries `retrievedAt`
- [ ] All new mutating endpoints require CSRF + JWT

## Screenshots / SSE traces (if UI- or stream-touching)

<!-- Drag images, paste SSE event sequence, or link an analysis ID. -->

## Linked issues

Closes #
