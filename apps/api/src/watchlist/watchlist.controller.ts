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
import { WatchlistService } from './watchlist.service';
import { AddWatchlistDto, UpdateWatchlistDto } from './watchlist.dto';

@Controller('watchlist')
@UseGuards(JwtCookieGuard, CsrfGuard)
export class WatchlistController {
  constructor(private watchlistService: WatchlistService) {}

  @Get()
  list(@CurrentUser() user: any) {
    return this.watchlistService.list(user.id);
  }

  @Post()
  add(@CurrentUser() user: any, @Body() dto: AddWatchlistDto) {
    return this.watchlistService.add(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateWatchlistDto,
  ) {
    return this.watchlistService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.watchlistService.remove(user.id, id);
  }
}
