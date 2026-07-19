import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AiSettingsService } from './ai-settings.service';
import {
  CreateAiProviderSettingDto,
  ListModelsDto,
  TestSavedConnectionDto,
  TestConnectionDto,
  UpdateAiProviderSettingDto,
} from './ai-settings.dto';

@Controller('settings/providers')
@UseGuards(JwtCookieGuard, CsrfGuard)
export class AiSettingsController {
  constructor(private aiSettingsService: AiSettingsService) {}

  @Get('catalog')
  getCatalog() {
    return this.aiSettingsService.getCatalog();
  }

  @Get()
  list(@CurrentUser() user: any) {
    return this.aiSettingsService.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: any, @Param('id') id: string) {
    return this.aiSettingsService.get(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateAiProviderSettingDto) {
    return this.aiSettingsService.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateAiProviderSettingDto,
  ) {
    return this.aiSettingsService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.aiSettingsService.remove(user.id, id);
  }

  /** 无状态：根据 body 直接拨打上游 /models，不依赖 DB 行 */
  @Post('models')
  listModels(@Body() body: ListModelsDto) {
    return this.aiSettingsService.listModelsStateless(body);
  }

  /** 无状态：根据 body 直接 ping 上游，不依赖 DB 行 */
  @Post('test')
  testConnection(@Body() body: TestConnectionDto) {
    return this.aiSettingsService.testConnectionStateless(body);
  }

  @Post(':id/models')
  listSavedModels(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: ListModelsDto,
  ) {
    return this.aiSettingsService.listModelsForSaved(user.id, id, body);
  }

  @Post(':id/test')
  testSavedConnection(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: TestSavedConnectionDto,
  ) {
    return this.aiSettingsService.testConnectionForSaved(user.id, id, body);
  }
}
