import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import {
  TestWebSearchSettingDto,
  UpsertWebSearchSettingDto,
} from './web-search-settings.dto';
import { WebSearchSettingsService } from './web-search-settings.service';

@Controller('settings/web-search')
@UseGuards(JwtCookieGuard, CsrfGuard)
export class WebSearchSettingsController {
  constructor(private svc: WebSearchSettingsService) {}

  @Get()
  get(@CurrentUser() user: any) {
    return this.svc.get(user.id);
  }

  @Put()
  async upsert(
    @CurrentUser() user: any,
    @Body() dto: UpsertWebSearchSettingDto,
  ) {
    try {
      return await this.svc.upsert(user.id, dto);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(msg);
    }
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: any): Promise<void> {
    await this.svc.remove(user.id);
  }

  @Post('test')
  async test(@Body() dto: TestWebSearchSettingDto) {
    return this.svc.test(dto);
  }
}
