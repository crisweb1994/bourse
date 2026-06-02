import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearCookieVariants } from './cookies';

describe('auth cookies', () => {
  it('clears both domain-scoped and host-only variants', () => {
    const calls: Array<{ name: string; options: Record<string, string> }> = [];
    const response = {
      clearCookie(name: string, options: Record<string, string>) {
        calls.push({ name, options });
      },
    };

    clearCookieVariants(response as any, 'sc_csrf', 'static.crisweb.com');

    assert.deepEqual(calls, [
      { name: 'sc_csrf', options: { path: '/', domain: 'static.crisweb.com' } },
      { name: 'sc_csrf', options: { path: '/' } },
    ]);
  });
});
