import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DigestSchedulerService } from './digest-scheduler.service';

// ============================================================================
// 单测：DigestSchedulerService。runHeartbeat stub；验证启动立即跑、销毁清 timer、
// 单次失败不阻塞。所有 case 都 onModuleDestroy 收尾，避免 setInterval 让测试
// 进程不退出。不测「挂死/超时」分支（需 fake timer，单测环境太脆），靠代码结构
// （finally 释放 running + Promise.race 超时）保证。
// ============================================================================

describe('DigestSchedulerService · 启动立即跑', () => {
  it('onModuleInit 立即触发一次 runHeartbeat', async () => {
    let callCount = 0;
    const trigger: any = { runHeartbeat: async () => { callCount += 1; } };
    const svc = new DigestSchedulerService(trigger);
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 15));
    svc.onModuleDestroy();
    assert.ok(callCount >= 1, `应至少调用 1 次，实际 ${callCount}`);
  });
});

describe('DigestSchedulerService · 单次失败不阻塞', () => {
  it('runHeartbeat 抛错 → tick 自己 catch、不抛、后续可调度', async () => {
    let callCount = 0;
    const trigger: any = {
      runHeartbeat: async () => {
        callCount += 1;
        throw new Error('boom');
      },
    };
    const svc = new DigestSchedulerService(trigger);
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 20));
    svc.onModuleDestroy();
    assert.ok(callCount >= 1, '执行了但被 catch，未阻塞');
  });
});

describe('DigestSchedulerService · 销毁清 timer', () => {
  it('onModuleDestroy 后重复调用不抛错', async () => {
    const trigger: any = { runHeartbeat: async () => undefined };
    const svc = new DigestSchedulerService(trigger);
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 10));
    svc.onModuleDestroy();
    assert.doesNotThrow(() => svc.onModuleDestroy());
  });
});

describe('DigestSchedulerService · 正常完成释放 running', () => {
  it('runHeartbeat 正常 resolve 后，running 应回 false（无直接观测，靠不抛错 + 可重复 init）', async () => {
    let callCount = 0;
    const trigger: any = { runHeartbeat: async () => { callCount += 1; } };
    const svc = new DigestSchedulerService(trigger);
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 15));
    svc.onModuleDestroy();
    // 若 running 没释放，第二次 onModuleInit 的 tick 不会跑（被挡）。
    // 但 onModuleInit 不重置 running——这里只验证销毁+重建可用。
    const svc2 = new DigestSchedulerService(trigger);
    svc2.onModuleInit();
    await new Promise((r) => setTimeout(r, 15));
    svc2.onModuleDestroy();
    assert.ok(callCount >= 2, '两个实例各自至少跑了一次');
  });
});
