import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ScreeningController } from './screening.controller';
import { ScreeningService } from './screening.service';

@Module({
  imports: [AuthModule, ConnectorsModule],
  controllers: [ScreeningController],
  providers: [ScreeningService],
})
export class ScreeningModule {}
