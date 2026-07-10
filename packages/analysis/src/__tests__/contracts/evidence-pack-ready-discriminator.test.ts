/**
 * v0.6 PRD §11.1 — `evidence_pack_ready` discriminator regression.
 *
 * Goals:
 *  - v1 pack payloads decode unchanged.
 *  - v2 pack payloads (v0.6 snapshot-backed wrapper) decode and surface
 *    optional `systemContext` + `planId / snapshotId / originCounts`.
 *  - Packs missing `schemaVersion` fall through to v1 decode (v1 carries
 *    `schemaVersion: 'evidence-pack-v1'` so this is a strict-failure case).
 */
import { describe, expect, it } from 'vitest';

import { EvidencePackReadyEvent } from '../../contracts/sse-events';

const baseEvent = { runId: 'run_test', seq: 0, type: 'evidence_pack_ready' as const };

const v1Pack = {
  schemaVersion: 'evidence-pack-v1' as const,
  symbol: 'AAPL',
  market: 'US',
  capturedAt: '2026-05-22T00:00:00.000Z',
  financialSnapshot: { price: 100 },
  news: [],
  valuation: {},
  riskFacts: ['regulatory risk'],
  allowedUrls: ['https://example.com/a'],
};

const v2Pack = {
  schemaVersion: 'evidence-pack-v2' as const,
  symbol: 'AAPL',
  market: 'US' as const,
  capturedAt: '2026-05-22T00:00:00.000Z',
  facts: {},
  dataAvailability: { complete: [], missing: [], fallbacks: [] },
  citations: [],
  trace: { toolCalls: 0, durationMs: 0, costUsd: 0 },
};

describe('EvidencePackReadyEvent — schemaVersion discriminator', () => {
  it('decodes legacy v1 pack payload unchanged', () => {
    const evt = { ...baseEvent, pack: v1Pack };
    const parsed = EvidencePackReadyEvent.parse(evt);
    expect(parsed.pack.schemaVersion).toBe('evidence-pack-v1');
    // v0.6 envelope optional fields stay undefined.
    expect(parsed.planId).toBeUndefined();
    expect(parsed.snapshotId).toBeUndefined();
    expect(parsed.originCounts).toBeUndefined();
  });

  it('decodes v2 pack with optional systemContext + envelope fields', () => {
    const evt = {
      ...baseEvent,
      planId: 'plan_abc',
      snapshotId: 'snap_xyz',
      originCounts: { fromSnapshot: 4, providerNative: 1 },
      pack: {
        ...v2Pack,
        systemContext: {
          planId: 'plan_abc',
          snapshotId: 'snap_xyz',
          confidenceCap: 'MEDIUM' as const,
          minimumViable: true,
          planDisclaimer: ['cap=MEDIUM'],
          blockedClaims: [],
          degradedReasons: [],
          skippedSlots: [],
        },
      },
    };
    const parsed = EvidencePackReadyEvent.parse(evt);
    expect(parsed.pack.schemaVersion).toBe('evidence-pack-v2');
    expect(parsed.planId).toBe('plan_abc');
    expect(parsed.snapshotId).toBe('snap_xyz');
    expect(parsed.originCounts?.fromSnapshot).toBe(4);
  });

  it('decodes v2 pack without systemContext (additive optional)', () => {
    const parsed = EvidencePackReadyEvent.parse({ ...baseEvent, pack: v2Pack });
    expect(parsed.pack.schemaVersion).toBe('evidence-pack-v2');
    // optional systemContext stays unset; v1-only consumers see nothing new.
    expect((parsed.pack as { systemContext?: unknown }).systemContext).toBeUndefined();
  });

  it('decodes v2 pack with market=CN (legacy CN tool-driven path still valid)', () => {
    const cnPack = { ...v2Pack, market: 'CN' as const };
    const parsed = EvidencePackReadyEvent.parse({ ...baseEvent, pack: cnPack });
    expect((parsed.pack as { market: string }).market).toBe('CN');
  });

  it('rejects a payload whose pack lacks schemaVersion (catchall guard)', () => {
    const evt = {
      ...baseEvent,
      pack: { ...v2Pack, schemaVersion: undefined },
    } as unknown;
    expect(() => EvidencePackReadyEvent.parse(evt)).toThrow();
  });
});
