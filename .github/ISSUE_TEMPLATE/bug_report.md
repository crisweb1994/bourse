---
name: Bug report
about: Something broken or behaving unexpectedly
title: "[bug] "
labels: bug
---

## What happened

<!-- One paragraph. What did you do, what did you expect, what actually happened? -->

## Reproduction

1.
2.
3.

## Environment

- Bourse version / commit:
- OS:
- Node / pnpm version:
- AI provider (Anthropic / OpenAI / OpenAI-compatible):
- Market analyzed (US / CN / HK):
- Running mode: [ ] local `pnpm dev`  [ ] docker compose  [ ] other

## Logs / screenshots

<!-- Paste relevant logs from api/web terminals. Mask any API keys. -->

## Did this involve LLM output?

- [ ] Yes — please attach the analysis ID or the SSE event sequence if possible
- [ ] No

<!--
Quick checklist before submitting:
- [ ] I searched existing issues for duplicates
- [ ] I'm not pasting any secret (.env, API keys, JWT)
- [ ] If this is about a computed number (PE, RSI, etc.), I checked it's the
      compute layer (packages/analysis/src/compute/) and not the LLM "redoing math"
-->
