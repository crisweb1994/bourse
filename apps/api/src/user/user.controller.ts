import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtCookieGuard } from '../auth/jwt-cookie.guard';

@Controller('user')
@UseGuards(JwtCookieGuard)
export class UserController {
  /**
   * plan-v2 §12.1 — return the current sc_csrf cookie value so SSR /
   * RSC-rendered pages can prime the header without forcing a separate
   * mutation. JwtCookieGuard auto-mints one for anonymous sessions if
   * the cookie is absent, so this endpoint always returns a usable token.
   */
  @Get('csrf')
  csrf(@Req() req: Request) {
    return { csrfToken: req.cookies?.['sc_csrf'] ?? null };
  }
}
