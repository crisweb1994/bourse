import { Module } from '@nestjs/common';
import { FilingStoreService } from './filing-store.service';

@Module({
  providers: [FilingStoreService],
  exports: [FilingStoreService],
})
export class FilingsModule {}
