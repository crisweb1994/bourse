import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

/**
 * JWT_EXPIRES_IN parsing (KISS review B1-1): a typo'd duration must fail
 * bootstrap instead of silently producing tokens that expire in seconds.
 */

function makeService(env: Record<string, string>) {
  return new AuthService({} as any, new ConfigService(env));
}

describe('AuthService · JWT_EXPIRES_IN validation', () => {
  it('accepts unit-suffixed durations and bare seconds', () => {
    makeService({ JWT_SECRET: 's', JWT_EXPIRES_IN: '7d' });
    makeService({ JWT_SECRET: 's', JWT_EXPIRES_IN: '12h' });
    makeService({ JWT_SECRET: 's', JWT_EXPIRES_IN: '3600' });
  });

  it('throws at construction on unparseable values like "7days"', () => {
    assert.throws(() => makeService({ JWT_SECRET: 's', JWT_EXPIRES_IN: '7days' }), /Invalid JWT_EXPIRES_IN/);
    assert.throws(() => makeService({ JWT_SECRET: 's', JWT_EXPIRES_IN: '1 week' }), /Invalid JWT_EXPIRES_IN/);
    assert.throws(() => makeService({ JWT_SECRET: 's', JWT_EXPIRES_IN: 'abc' }), /Invalid JWT_EXPIRES_IN/);
  });

  it('falls back to the documented 7d default when unset', () => {
    makeService({ JWT_SECRET: 's' });
  });

  it('signs a verifiable token with a valid duration', async () => {
    const svc = makeService({ JWT_SECRET: 'test-secret', JWT_EXPIRES_IN: '1h' });
    const token = svc.signJwt('user-1');
    assert.equal(svc.verifyJwt(token)?.sub, 'user-1');
  });
});
