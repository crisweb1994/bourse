#!/usr/bin/env tsx
/**
 * v0.3 后遗留 ③ — ResearchJob / ResearchSnapshot 夜间 GC 入口。
 *
 * 用法：
 *   pnpm -F @bourse/api gc:nightly                   # 真删
 *   pnpm -F @bourse/api gc:nightly -- --dry-run      # 只统计
 *
 * 部署：
 *   # 系统 cron (每天 03:00 UTC)
 *   0 3 * * * cd /app && pnpm -F @bourse/api gc:nightly >> /var/log/research-gc.log 2>&1
 *
 *   # Dokploy / k8s CronJob 同理：调用同一条命令。
 *
 * 故意不放 `@nestjs/schedule`：单进程 setInterval 在 pod 重启 / 多副本
 * 部署下会漂；外部 cron 守护进程才有幂等性（leader-election 之类是后话）。
 */
import { parseArgs } from 'node:util';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { ResearchGcService } from '../src/research/research-gc.service';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const dryRun = values['dry-run'] === true;
  const logger = new Logger('research-gc');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const gc = app.get(ResearchGcService);
    const result = await gc.runGc({ dryRun });
    logger.log(
      `done — expiredSnapshots=${result.expiredSnapshots} ` +
        `retainedLinkedSnapshots=${result.retainedLinkedSnapshots} dryRun=${result.dryRun}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
