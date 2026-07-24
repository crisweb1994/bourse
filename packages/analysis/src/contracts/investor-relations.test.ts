import { describe, expect, it } from 'vitest';
import { InvestorRelationsExtractionSchema } from './investor-relations';

describe('InvestorRelationsExtractionSchema', () => {
  it('keeps extraction usable when a participant role was not disclosed', () => {
    const result = InvestorRelationsExtractionSchema.parse({
      occurredAt: '2026-06-26',
      activityType: 'INSTITUTIONAL_RESEARCH',
      companyParticipants: [{ name: '董事会办公室人员' }],
      institutions: [],
      topics: [{
        text: '公司持续推进渠道库存优化。',
        sourceQuote: '持续推进渠道库存优化',
        sourcePage: 3,
      }],
      managementClaims: [],
    });

    expect(result.companyParticipants).toEqual([{ name: '董事会办公室人员' }]);
    expect(result.topics[0]?.title).toBeUndefined();
  });
});
