---
name: New data connector
about: Propose or contribute a new market data / filings / macro / search source
title: "[connector] "
labels: connector, good first issue
---

## Source name

<!-- e.g. Polygon / Alpha Vantage / Tiingo / Futu / Tushare / FRED-extension / ... -->

## What does it cover

- Markets: [ ] US  [ ] CN  [ ] HK  [ ] JP  [ ] UK  [ ] Other:
- Data kind:
  - [ ] Quote / OHLCV
  - [ ] Financial statements (income / balance / cash flow)
  - [ ] Filings (10-K, 10-Q, equivalents)
  - [ ] Insider / institutional / fund flow
  - [ ] Macro indicators
  - [ ] News / web search
  - [ ] Other:

## Auth model

- [ ] Public, no key
- [ ] API key (free tier exists)
- [ ] API key (paid only)
- [ ] OAuth
- [ ] Other:

## Terms of service

- Link to ToS:
- Allowed use: [ ] research / educational  [ ] commercial OK  [ ] unclear
- Rate limits:

## Existing connector this would replace or complement

<!-- See packages/analysis/src/connectors/ — list any overlap -->

## Are you planning to contribute the implementation?

- [ ] Yes — I'll send a PR
- [ ] No, just proposing

<!--
Implementation checklist for PR authors:
- [ ] Implements the Port interface in packages/analysis/src/ports/
- [ ] Returns data normalized to existing schemas (zod)
- [ ] Every record has retrievedAt for provenance
- [ ] Has unit tests with recorded fixtures (no live network in CI)
-->
