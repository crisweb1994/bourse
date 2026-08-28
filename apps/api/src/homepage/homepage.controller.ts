import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { HomepageService } from './homepage.service';

@Controller('homepage')
@UseGuards(JwtCookieGuard)
export class HomepageController {
  constructor(private readonly homepage: HomepageService) {}

  @Get('brief')
  brief(@CurrentUser() user: { id: string }) {
    return this.homepage.getBrief(user.id);
  }
}
