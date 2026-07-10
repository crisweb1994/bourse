import { Module } from '@nestjs/common';
import { ToolCacheService } from './tool-cache.service';

/**
 * Provides ToolCacheService (in-memory LRU + TTL). Consumed by
 * analysis workflow adapters and ToolGateway for explicit-tool result caching.
 */
@Module({
  providers: [ToolCacheService],
  exports: [ToolCacheService],
})
export class ToolCacheModule {}
