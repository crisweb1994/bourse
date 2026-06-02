import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { JwtCookieGuard } from './jwt-cookie.guard';
import { OptionalGithubAuthGuard } from './optional-github.guard';
import { CsrfGuard } from './csrf.guard';
import { clearAuthCookieVariants } from './cookies';
import { IsOptional } from 'class-validator';

class UpdatePreferencesDto {
  @IsOptional()
  @IsBoolean()
  allowWebSearchFallback?: boolean;
}

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: ConfigService,
  ) {}

  @Get('github')
  @UseGuards(OptionalGithubAuthGuard)
  githubLogin(@Res() res: Response) {
    // Reached here only when AUTH_REQUIRED=false (the guard skipped
    // passport). In normal mode passport would've already redirected to
    // GitHub and we never reach the handler body.
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    return res.redirect(`${frontendUrl}/`);
  }

  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  githubCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as any;
    const token = this.authService.signJwt(user.id);
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const cookieDomain = this.config.get<string>('COOKIE_DOMAIN') || undefined;

    clearAuthCookieVariants(res, cookieDomain);

    res.cookie('sc_token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
      domain: cookieDomain,
    });

    res.cookie('sc_csrf', csrfToken, {
      httpOnly: false,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
      domain: cookieDomain,
    });

    res.redirect(`${frontendUrl}/callback`);
  }

  @Get('me')
  @UseGuards(JwtCookieGuard)
  getMe(@Req() req: Request) {
    const user = (req as any).user;
    return {
      id: user.id,
      githubId: user.githubId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      allowWebSearchFallback: user.allowWebSearchFallback ?? false,
    };
  }

  /**
   * RFC rfc-evidence-pack-web-search-fallback §3.1: user preference patch.
   * Currently only carries the fallback opt-in; structured as a partial
   * patch so future prefs can land here without a new route.
   */
  @Patch('preferences')
  @UseGuards(JwtCookieGuard, CsrfGuard)
  async updatePreferences(
    @Req() req: Request,
    @Body() body: UpdatePreferencesDto,
  ) {
    const user = (req as any).user;
    const updated = await this.authService.updatePreferences(user.id, {
      ...(body.allowWebSearchFallback !== undefined
        ? { allowWebSearchFallback: body.allowWebSearchFallback }
        : {}),
    });
    return {
      allowWebSearchFallback: updated.allowWebSearchFallback,
    };
  }

  @Post('logout')
  @UseGuards(CsrfGuard)
  logout(@Res() res: Response) {
    const cookieDomain = this.config.get<string>('COOKIE_DOMAIN') || undefined;
    clearAuthCookieVariants(res, cookieDomain);
    res.json({ ok: true });
  }
}
