import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { EastMoneyProvider } from './providers/eastmoney.provider';
import { YahooProvider } from './providers/yahoo.provider';

@Module({
  imports: [AuthModule, ConnectorsModule],
  controllers: [StockController],
  providers: [StockService, EastMoneyProvider, YahooProvider],
  exports: [StockService],
})
export class StockModule {}
