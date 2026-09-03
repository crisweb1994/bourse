import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { SESSION_TTL_SECONDS, SESSION_TTL_MS, AuthService } from './auth.service';

/** KISS env review: JWT_EXPIRES_IN is gone — the session TTL is one shared
 *  constant driving both the JWT expiry and every cookie maxAge. */

test('session TTL constants are consistent (seconds ↔ milliseconds)', () => {
  assert.equal(SESSION_TTL_SECONDS, 7 * 24 * 60 * 60);
  assert.equal(SESSION_TTL_MS, SESSION_TTL_SECONDS * 1000);
});

test('signs a verifiable token with the shared TTL', async () => {
  const svc = new AuthService({} as any, new ConfigService({ JWT_SECRET: 'test-secret' }));
  const token = svc.signJwt('user-1');
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.exp - payload.iat, SESSION_TTL_SECONDS);
  assert.equal(svc.verifyJwt(token)?.sub, 'user-1');
});
