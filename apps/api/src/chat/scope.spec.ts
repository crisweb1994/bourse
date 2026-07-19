import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isUnsupportedQuestion,
  parseStockScope,
  requiresFreshAnalysis,
} from './scope';

const current = { stockId: 'stock-aapl', symbol: 'AAPL' };

describe('Chat Phase 1 deterministic scope guard', () => {
  it('does not treat financial abbreviations as ticker switches', () => {
    for (const question of [
      'ROE 下降但 FCF 上升意味着什么？',
      'TTM PE 和 PB 应该怎么理解？',
      'MA 金叉后 RSI 过热了吗？',
      'HK 和 SS 后缀有什么区别？',
      'CEO 最近有什么动作？',
      'EPS 怎么看？',
      'I think margins are improving',
      'CEO 最近有哪些动作？EPS 应该如何结合这份分析理解？',
    ]) {
      assert.equal(parseStockScope(question, current).action, 'MAINTAIN');
    }
  });

  it('recognizes an explicit switch without expanding the allowlist', () => {
    const decision = parseStockScope('改看 MSFT', current);
    assert.equal(decision.action, 'SWITCH');
    assert.deepEqual(decision.mentionedSymbols, ['MSFT']);
    assert.deepEqual(decision.allowedStockIds, ['stock-aapl']);
  });

  it('recognizes lowercase ticker only beside a strong scope verb', () => {
    assert.equal(parseStockScope('switch to msft', current).action, 'SWITCH');
    assert.equal(parseStockScope('msft 最近怎么样', current).action, 'MAINTAIN');
  });

  it('recognizes compare but does not authorize another stock', () => {
    const decision = parseStockScope('AAPL 和 MSFT 对比', current);
    assert.equal(decision.action, 'COMPARE');
    assert.deepEqual(decision.allowedStockIds, ['stock-aapl']);
  });

  it('routes freshness and personalized trading requests deterministically', () => {
    assert.equal(requiresFreshAnalysis('最新财报发布后结论变了吗？'), true);
    assert.equal(isUnsupportedQuestion('替我买入 30% 仓位'), true);
    assert.equal(isUnsupportedQuestion('报告里的“买入”是什么意思？'), false);
  });
});
