import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { cleanAnalysisMarkdown } from './analysis-markdown';

describe('cleanAnalysisMarkdown', () => {
  it('removes schema headings and keeps a readable valuation report', () => {
    const result = cleanAnalysisMarkdown(`## 招商银行估值研究

### assessment
**FAIR**

### methods
- **相对估值**

### inputs
- **股价：38.46 元**（来源：行情）
- **P/B：0.7515622760221139**（来源：事实）
- **ROE：0.11680516974860237**（来源：事实）
- **一致预期 EPS：2026 年 5.993636363636、2027 年 6.255454545455**

### findings
1. 估值处于低位。

### limitations
- 数据有限。

**assessment：FAIR**`, 'VALUATION_SCENARIOS');

    assert.equal(result.includes('assessment'), false);
    assert.equal(result.includes('methods'), false);
    assert.equal(result.includes('inputs'), false);
    assert.match(result, /估值方法/);
    assert.match(result, /估值依据/);
    assert.match(result, /当前股价：38\.46 元/);
    assert.match(result, /P\/B：0\.75 倍/);
    assert.match(result, /ROE：11\.68%/);
    assert.match(result, /2026 年 5\.99、2027 年 6\.26/);
    assert.match(result, /关键发现/);
    assert.match(result, /限制与缺口/);
  });

  it('removes internal metadata without changing normal module prose', () => {
    const result = cleanAnalysisMarkdown(`## 公司质量研究

**assessment：STRONG**

### 核心发现
公司质量较强。

**basedOnIncompleteSections：** RISK_REGISTER`, 'COMPANY_QUALITY');

    assert.equal(result.includes('assessment'), false);
    assert.equal(result.includes('basedOnIncompleteSections'), false);
    assert.match(result, /核心发现/);
    assert.match(result, /公司质量较强/);
  });
});
