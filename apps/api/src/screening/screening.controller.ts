import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';
import { ScreeningService } from './screening.service';

@Controller('screening')
@UseGuards(JwtCookieGuard)
export class ScreeningController {
  constructor(private readonly screening: ScreeningService) {}

  @Get('config')
  config(@Query('market') market?: string) {
    return this.screening.config(market);
  }

  @Post('runs')
  @UseGuards(CsrfGuard)
  createRun(@CurrentUser() user: any, @Body() body: unknown) {
    return this.screening.createRun(user.id, body);
  }

  @Get('runs/:id')
  getRun(@CurrentUser() user: any, @Param('id') id: string) {
    return this.screening.getRun(user.id, id);
  }

  @Post('runs/:id/refine')
  @UseGuards(CsrfGuard)
  refineRun(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.screening.refineRun(user.id, id, body);
  }

  @Get('saved-screens')
  listSavedScreens(@CurrentUser() user: any) {
    return this.screening.listSavedScreens(user.id);
  }

  @Post('saved-screens')
  @UseGuards(CsrfGuard)
  createSavedScreen(@CurrentUser() user: any, @Body() body: unknown) {
    return this.screening.createSavedScreen(user.id, body);
  }

  @Patch('saved-screens/:id')
  @UseGuards(CsrfGuard)
  updateSavedScreen(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.screening.updateSavedScreen(user.id, id, body);
  }

  @Delete('saved-screens/:id')
  @UseGuards(CsrfGuard)
  deleteSavedScreen(@CurrentUser() user: any, @Param('id') id: string) {
    return this.screening.deleteSavedScreen(user.id, id);
  }
}
