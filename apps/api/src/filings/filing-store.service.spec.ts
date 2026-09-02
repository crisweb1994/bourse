import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilingStoreError, FilingStoreService } from './filing-store.service';

/**
 * Direct coverage for the filing immutability contract (KISS review A6):
 * the same source document must never be re-persisted with different
 * content, and identical content must be idempotent.
 */

const stock = { id: 'stock-1' } as any;

const summary = {
  provider: 'SEC',
  sourceGroupId: 'group-1',
  formType: '10-Q',
  title: 'Q2 Report',
  filingDate: '2026-06-30',
  language: 'en',
} as any;

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    text: 'Item 1. Financial Statements ...',
    contentHash: 'hash-AAA',
    provider: 'SEC',
    sourceDocumentId: 'doc-1',
    filingUrl: 'https://example.com/filing',
    retrievedAt: null,
    mimeType: 'text/plain',
    language: 'en',
    ...overrides,
  } as any;
}

function makeFiling(contentHash: string) {
  return {
    id: 'filing-1',
    contentHash,
    stockId: stock.id,
  } as any;
}

function makePrisma(existing: any, calls: { create: number; upsert: number }) {
  return {
    filing: {
      findUnique: async () => existing,
      create: async () => {
        calls.create += 1;
        return makeFiling('hash-AAA');
      },
    },
    filingDerivation: {
      upsert: async (args: any) => {
        calls.upsert += 1;
        assert.deepEqual(args.update, {});
        return { id: 'derivation-1' };
      },
    },
  } as any;
}

describe('FilingStoreService · immutability guard', () => {
  it('throws FILING_CONTENT_CHANGED when the same document returns with a different content hash', async () => {
    const svc = new FilingStoreService(makePrisma(makeFiling('hash-BBB'), { create: 0, upsert: 0 }));
    await assert.rejects(
      () => svc.persist(stock, summary, makeDocument()),
      (err: unknown) =>
        err instanceof FilingStoreError && err.code === 'FILING_CONTENT_CHANGED',
    );
  });

  it('is idempotent when content hash matches: no re-create, derivation upsert is a no-op update', async () => {
    const calls = { create: 0, upsert: 0 };
    const svc = new FilingStoreService(makePrisma(makeFiling('hash-AAA'), calls));
    const result = await svc.persist(stock, summary, makeDocument());
    assert.equal(calls.create, 0);
    assert.equal(calls.upsert, 1);
    assert.equal(result.filing.id, 'filing-1');
  });

  it('throws BODY_UNREADABLE when the document has no text or content hash', async () => {
    const svc = new FilingStoreService(makePrisma(null, { create: 0, upsert: 0 }));
    await assert.rejects(
      () => svc.persist(stock, summary, makeDocument({ text: '' })),
      (err: unknown) => err instanceof FilingStoreError && err.code === 'BODY_UNREADABLE',
    );
    await assert.rejects(
      () => svc.persist(stock, summary, makeDocument({ contentHash: '' })),
      (err: unknown) => err instanceof FilingStoreError && err.code === 'BODY_UNREADABLE',
    );
  });

  it('creates the filing and derivation on first sight of the document', async () => {
    const calls = { create: 0, upsert: 0 };
    const captured: { create?: any; upsert?: any } = {};
    const prisma = {
      filing: {
        findUnique: async () => null,
        create: async (args: any) => {
          calls.create += 1;
          captured.create = args.data;
          return makeFiling('hash-AAA');
        },
      },
      filingDerivation: {
        upsert: async (args: any) => {
          calls.upsert += 1;
          captured.upsert = args;
          return { id: 'derivation-1' };
        },
      },
    } as any;
    const svc = new FilingStoreService(prisma);
    await svc.persist(stock, summary, makeDocument());
    assert.equal(calls.create, 1);
    assert.equal(calls.upsert, 1);
    assert.equal(captured.create.sourceDocumentId, 'doc-1');
    assert.ok(Array.isArray(captured.upsert.create.sections));
    assert.ok(captured.upsert.create.sections.length > 0);
  });
});
