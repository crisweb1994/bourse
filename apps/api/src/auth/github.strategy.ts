import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-github2';
import { Request } from 'express';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { clearCookieVariants } from './cookies';

function statesMatch(storedState: string, providedState: string): boolean {
  const stored = Buffer.from(storedState);
  const provided = Buffer.from(providedState);

  return (
    stored.length === provided.length &&
    crypto.timingSafeEqual(stored, provided)
  );
}

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    private authService: AuthService,
    config: ConfigService,
  ) {
    // When AUTH_REQUIRED=false the strategy is never actually invoked
    // (OptionalGithubAuthGuard short-circuits before passport runs).
    // Fall back to placeholder values so missing env vars don't crash
    // module bootstrap in private-deploy mode.
    const authOptional =
      config.get<string>('AUTH_REQUIRED', 'true') === 'false';
    const fallback = authOptional
      ? '__unused-in-anonymous-mode__'
      : undefined;

    super({
      clientID:
        config.get<string>('GITHUB_CLIENT_ID') ??
        fallback ??
        config.getOrThrow<string>('GITHUB_CLIENT_ID'),
      clientSecret:
        config.get<string>('GITHUB_CLIENT_SECRET') ??
        fallback ??
        config.getOrThrow<string>('GITHUB_CLIENT_SECRET'),
      callbackURL:
        config.get<string>('GITHUB_CALLBACK_URL') ??
        fallback ??
        config.getOrThrow<string>('GITHUB_CALLBACK_URL'),
      scope: ['user:email'],
      passReqToCallback: true,
    });
  }

  /**
   * Store OAuth state in an httpOnly cookie and validate it manually.
   * Avoid passport-oauth2's default session-based state store.
   */
  authenticate(req: Request, options?: any) {
    const isCallback = Boolean(req.query.code || req.query.error || req.query.state);

    const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

    if (!isCallback) {
      const state = crypto.randomBytes(16).toString('hex');
      const response = (req as any).res;

      if (response) {
        clearCookieVariants(response, 'oauth_state', cookieDomain);
      }

      (req as any).res?.cookie('oauth_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000, // 10 minutes
        path: '/',
        domain: cookieDomain,
      });
      return super.authenticate(req, { ...options, state });
    }

    const storedState = req.cookies?.['oauth_state'];
    const providedState = typeof req.query.state === 'string' ? req.query.state : '';
    const response = (req as any).res;

    if (response) {
      clearCookieVariants(response, 'oauth_state', cookieDomain);
    }

    if (!storedState || !providedState || !statesMatch(storedState, providedState)) {
      return this.fail({ message: 'Invalid OAuth state' }, 403);
    }

    return super.authenticate(req, { ...options });
  }

  async validate(
    _req: Request,
    _accessToken: string,
    _refreshToken: string,
    profile: any,
  ) {
    return this.authService.findOrCreateUser(profile);
  }
}
