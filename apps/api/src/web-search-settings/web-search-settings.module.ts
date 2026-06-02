import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebSearchSettingsController } from './web-search-settings.controller';
import { WebSearchSettingsService } from './web-search-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [WebSearchSettingsController],
  providers: [WebSearchSettingsService],
  exports: [WebSearchSettingsService],
})
export class WebSearchSettingsModule {}
