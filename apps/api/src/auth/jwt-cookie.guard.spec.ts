import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import { JwtCookieGuard } from './jwt-cookie.guard';

/**
 * Auth-path guard coverage (KISS review B1-2): token branches and the
 * anonymous-mode CSRF priming behavior the frontend relies on.
 */

function makeContext(req: any, res: any) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
}

function makeAuthService(overrides: Record<string, unknown> = {}) {
  return {
    isAuthOptional: () => false,
    // verifyJwt is synchronous in AuthService (jwt.verify is sync) — keep
    // the mock sync too, an async mock returns a truthy Promise.
    verifyJwt: () => ({ sub: 'user-1' }) as any,
    findUserById: async () => ({ id: 'user-1', name: 'u' }) as any,
    getOrCreateAnonymousUser: async () => ({ id: 'anon-1' }) as any,
    ...overrides,
  } as any;
}

describe('JwtCookieGuard · token branches (AUTH_REQUIRED=true)', () => {
  it('rejects with 401 when no sc_token cookie is present', async () => {
    const guard = new JwtCookieGuard(makeAuthService());
    const req = { cookies: {} };
    await assert.rejects(
      () => guard.canActivate(makeContext(req, {})),
      UnauthorizedException,
    );
  });

  it('rejects with 401 when the token fails verification', async () => {
    const guard = new JwtCookieGuard(
      makeAuthService({ verifyJwt: () => null }),
    );
    const req = { cookies: { sc_token: 'stale-token' } };
    await assert.rejects(
      () => guard.canActivate(makeContext(req, {})),
      UnauthorizedException,
    );
  });

  it('rejects with 401 when the token is valid but the user no longer exists', async () => {
    const guard = new JwtCookieGuard(
      makeAuthService({ findUserById: async () => null }),
    );
    const req = { cookies: { sc_token: 'token' } };
    await assert.rejects(
      () => guard.canActivate(makeContext(req, {})),
      UnauthorizedException,
    );
  });

  it('attaches the DB user to the request on success', async () => {
    const guard = new JwtCookieGuard(makeAuthService());
    const req = { cookies: { sc_token: 'token' } };
    assert.equal(await guard.canActivate(makeContext(req, {})), true);
    assert.equal((req as any).user.id, 'user-1');
  });
});

describe('JwtCookieGuard · anonymous mode (AUTH_REQUIRED=false)', () => {
  it('runs as the shared anonymous user without any token', async () => {
    const guard = new JwtCookieGuard(makeAuthService({ isAuthOptional: () => true }));
    const req = { cookies: {} };
    const res = { cookie: () => {} };
    assert.equal(await guard.canActivate(makeContext(req, res)), true);
    assert.equal((req as any).user.id, 'anon-1');
  });

  it('mints an sc_csrf cookie readable by the frontend on the first request', async () => {
    const guard = new JwtCookieGuard(makeAuthService({ isAuthOptional: () => true }));
    const req = { cookies: {} };
    const baked: Record<string, any> = {};
    const res = {
      cookie: (name: string, value: string, opts: any) => {
        baked[name] = { value, opts };
      },
    };
    assert.equal(await guard.canActivate(makeContext(req, res)), true);
    assert.ok(baked.sc_csrf, 'sc_csrf cookie must be set');
    assert.equal(baked.sc_csrf.opts.httpOnly, false, 'frontend csrfHeaders() reads it');
    // The minted token is available within the same request so a POST on the
    // very first call still passes CsrfGuard.
    assert.equal((req as any).cookies.sc_csrf, baked.sc_csrf.value);
  });

  it('does not re-mint when sc_csrf already exists', async () => {
    const guard = new JwtCookieGuard(makeAuthService({ isAuthOptional: () => true }));
    const req = { cookies: { sc_csrf: 'existing' } };
    let cookieCalls = 0;
    const res = { cookie: () => { cookieCalls += 1; } };
    await guard.canActivate(makeContext(req, res));
    assert.equal(cookieCalls, 0);
    assert.equal((req as any).cookies.sc_csrf, 'existing');
  });
});
