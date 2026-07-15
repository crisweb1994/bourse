/**
 * Analysis workflow regression baseline.
 *
 * 跑一组 comprehensive scenario，每个产出一份"运行时无关"的 snapshot，与 `__fixtures__/<name>.json`
 * 比对。任何一个改了 SSE 事件序列 / Prisma 写入形状 / Telemetry 字段都会被抓出来。
 *
 * 重新 bless：UPDATE_FIXTURES=1 pnpm -F @bourse/api test
 *
 * 与 analysis-workflow-adapter.spec.ts 的关系：那个 spec 测 adapter 内部
 * 的细粒度行为（事件到 send 的字段映射），本 spec 测"整段 pipeline 的契约面"
 * 是否稳定，互补不重复。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffFixture } from './__testing__/snapshot';
import { runScenario } from './__testing__/scenario-runner';
import { SCENARIOS } from './__testing__/scenarios';

describe('analysis regression baseline', () => {
  for (const scenario of SCENARIOS) {
    it(`scenario: ${scenario.name}`, async () => {
      const snapshot = await runScenario(scenario);
      const result = diffFixture(scenario.name, snapshot);
      assert.ok(result.ok, result.message ?? 'fixture diff failed');
    });
  }
});
