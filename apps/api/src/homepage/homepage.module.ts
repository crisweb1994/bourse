import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HomepageController } from './homepage.controller';
import { HomepageService } from './homepage.service';

@Module({
  imports: [AuthModule],
  controllers: [HomepageController],
  providers: [HomepageService],
})
export class HomepageModule {}
