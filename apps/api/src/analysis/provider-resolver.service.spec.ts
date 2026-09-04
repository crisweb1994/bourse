import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnvProviderName } from './provider-resolver.service';

/** KISS env review: env-level provider pick — explicit AI_PROVIDER wins,
 *  otherwise inferred from whichever key is configured. */

const mk = (env: Record<string, string>) =>
  ({ get: (k: string) => env[k] } as Parameters<typeof resolveEnvProviderName>[0]);

test('explicit AI_PROVIDER wins', () => {
  assert.equal(resolveEnvProviderName(mk({ AI_PROVIDER: 'openai' })), 'openai');
  assert.equal(resolveEnvProviderName(mk({ AI_PROVIDER: 'claude' })), 'claude');
  assert.equal(resolveEnvProviderName(mk({ AI_PROVIDER: 'ANTHROPIC' })), 'claude');
});

test('auto-detects from the configured key when AI_PROVIDER is empty', () => {
  assert.equal(resolveEnvProviderName(mk({ ANTHROPIC_API_KEY: 'sk-x' })), 'claude');
  assert.equal(resolveEnvProviderName(mk({ OPENAI_API_KEY: 'sk-y' })), 'openai');
  // both keys → claude (legacy default) rather than a silent pick
  assert.equal(resolveEnvProviderName(mk({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })), 'claude');
});

test('falls back to claude when nothing is configured', () => {
  assert.equal(resolveEnvProviderName(mk({})), 'claude');
});
