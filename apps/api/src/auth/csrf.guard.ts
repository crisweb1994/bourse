import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokensMatch(cookieToken: string, headerToken: string): boolean {
  const cookie = Buffer.from(cookieToken);
  const header = Buffer.from(headerToken);

  return (
    cookie.length === header.length &&
    crypto.timingSafeEqual(cookie, header)
  );
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    // AUTH_REQUIRED=false → 单租户匿名模式。没有 session 可被劫持，
    // CSRF 防护失去保护对象,直接放行。
    if (process.env.AUTH_REQUIRED === 'false') {
      return true;
    }

    const cookieToken = request.cookies?.['sc_csrf'];
    const headerToken = request.get('x-csrf-token');

    if (
      !cookieToken ||
      !headerToken ||
      !tokensMatch(cookieToken, headerToken)
    ) {
      throw new ForbiddenException('Invalid CSRF token');
    }

    return true;
  }
}
