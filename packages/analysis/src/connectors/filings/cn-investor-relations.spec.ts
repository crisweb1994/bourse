import { describe, expect, it } from 'vitest';
import { classifyFilingTitle } from './cn';

describe('CN investor relations filing classification', () => {
  it('routes investor relations records before generic extraordinary notices', () => {
    expect(classifyFilingTitle('2026年7月投资者关系活动记录表')).toBe('investor_relations');
    expect(classifyFilingTitle('关于机构调研活动的公告')).toBe('investor_relations');
    expect(classifyFilingTitle('2026年第一季度报告')).toBe('quarterly');
  });
});
