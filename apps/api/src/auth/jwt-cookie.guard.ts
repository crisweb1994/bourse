import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';

@Injectable()
export class JwtCookieGuard implements CanActivate {
  constructor(private authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // AUTH_REQUIRED=false → 全站以单例匿名用户身份运行，跳过 token 校验
    if (this.authService.isAuthOptional()) {
      const anon = await this.authService.getOrCreateAnonymousUser();
      (request as any).user = anon;

      // CSRF cookie 是 OAuth 回调时种下的，匿名模式没有回调流程。
      // 第一次 GET (通常是 /auth/me) 时顺手种一个，让前端
      // csrfHeaders() 能读到 sc_csrf cookie，后续 POST/PATCH/DELETE
      // 才能通过 CsrfGuard 校验。
      if (!request.cookies?.['sc_csrf']) {
        const response = context.switchToHttp().getResponse<Response>();
        const csrfToken = crypto.randomBytes(32).toString('hex');
        const isProduction = process.env.NODE_ENV === 'production';
        const cookieDomain = process.env.COOKIE_DOMAIN || undefined;
        response.cookie('sc_csrf', csrfToken, {
          httpOnly: false, // 前端 JS 要读
          secure: isProduction,
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000,
          path: '/',
          domain: cookieDomain,
        });
        // 同请求内立即可用,避免本次请求若是 POST 时仍 403
        (request as any).cookies = {
          ...(request.cookies ?? {}),
          sc_csrf: csrfToken,
        };
      }

      return true;
    }

    const token = request.cookies?.['sc_token'];

    if (!token) {
      throw new UnauthorizedException('No authentication token');
    }

    const payload = this.authService.verifyJwt(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.authService.findUserById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    (request as any).user = user;
    return true;
  }
}
