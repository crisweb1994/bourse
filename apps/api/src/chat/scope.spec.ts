import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isUnsupportedQuestion,
  isEarningsQuestion,
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

  it('recognizes earnings questions without treating generic research as earnings intent', () => {
    assert.equal(isEarningsQuestion('这季财报里营收为什么变化？'), true);
    assert.equal(isEarningsQuestion('管理层在年报里怎么说？'), true);
    assert.equal(isEarningsQuestion('自由现金流和净利润有什么区别？'), false);
    assert.equal(isEarningsQuestion('公司的护城河是什么？'), false);
  });

  it('meets the earnings-intent eval gate on a balanced phrase set', () => {
    const cases: Array<[string, boolean]> = [
      ['这季财报里营收为什么变化？', true],
      ['最新 10-Q 的现金流情况', true],
      ['8-K 里披露了哪些数字', true],
      ['EPS 和去年同期相比怎样', true],
      ['公司的 FY guidance 是多少', true],
      ['业绩快报中的归母净利润', true],
      ['年报管理层如何解释毛利率', true],
      ['quarterly earnings revenue change', true],
      ['经营现金流与资本开支', false],
      ['利润为什么低于去年', true],
      ['公司的护城河是什么', false],
      ['当前估值贵不贵', false],
      ['最近股价为什么上涨', false],
      ['行业竞争格局如何', false],
      ['管理层治理水平怎么样', false],
      ['技术面是否超买', false],
      ['有哪些重大诉讼风险', false],
      ['和 MSFT 对比一下', false],
      ['今天有什么新闻', false],
      ['帮我整理投资论点', false],
    ];
    const correct = cases.filter(([question, expected]) => isEarningsQuestion(question) === expected).length;
    assert.ok(correct / cases.length >= 0.9, `earnings intent accuracy=${correct}/${cases.length}`);
  });
});
