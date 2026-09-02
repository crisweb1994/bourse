import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { GithubStrategy } from './github.strategy';

/**
 * OAuth state validation (KISS review B1-2 remainder): the callback leg
 * must reject missing/mismatched state before passport exchanges the code.
 * Construction uses AUTH_REQUIRED=false so placeholder credentials are
 * accepted — the state logic below never reaches passport in these paths.
 */

function makeStrategy() {
  const authService = {
    findOrCreateUser: async () => ({}),
  } as any;
  const config = new ConfigService({ AUTH_REQUIRED: 'false' });
  const strategy = new GithubStrategy(authService, config);

  const failures: Array<{ challenge: any; status: number }> = [];
  (strategy as any).fail = (challenge: any, status: number) => {
    failures.push({ challenge, status });
  };
  return { strategy, failures };
}

function makeCallbackReq(cookies: Record<string, string>, query: Record<string, string>) {
  const cleared: Array<{ name: string; opts: any }> = [];
  const res = {
    clearCookie: (name: string, opts: any) => cleared.push({ name, opts }),
  };
  return {
    req: { cookies, query, res } as any,
    cleared,
  };
}

describe('GithubStrategy · OAuth state validation', () => {
  it('fails with 403 when the provided state does not match the stored cookie', () => {
    const { strategy, failures } = makeStrategy();
    const { req, cleared } = makeCallbackReq(
      { oauth_state: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { code: 'x', state: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    );
    strategy.authenticate(req);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 403);
    // The one-time state cookie must be cleared on the callback leg even on failure.
    assert.ok(cleared.some((c) => c.name === 'oauth_state'));
  });

  it('fails with 403 when no state cookie was stored (e.g. cookie lost)', () => {
    const { strategy, failures } = makeStrategy();
    const { req } = makeCallbackReq({}, { code: 'x', state: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    strategy.authenticate(req);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 403);
  });

  it('fails with 403 when the callback carries no state query param', () => {
    const { strategy, failures } = makeStrategy();
    const { req } = makeCallbackReq(
      { oauth_state: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { code: 'x' },
    );
    // No state in query → isCallback is true (code present), providedState
    // is '' → mismatch → 403.
    strategy.authenticate(req);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 403);
  });
});
