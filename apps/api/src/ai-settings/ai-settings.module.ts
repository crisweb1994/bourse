import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [AiSettingsController],
  providers: [AiSettingsService],
  exports: [AiSettingsService],
})
export class AiSettingsModule {}
