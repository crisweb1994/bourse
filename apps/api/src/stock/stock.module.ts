import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { EarningsModule } from '../earnings/earnings.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { StockNewsService } from './stock-news.service';

@Module({
  imports: [AuthModule, ConnectorsModule, EarningsModule],
  controllers: [StockController],
  providers: [StockService, StockNewsService],
  exports: [StockService, StockNewsService],
})
export class StockModule {}
