import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRootEnvFilePaths } from './root-env';

describe('root env paths', () => {
  it('only resolves monorepo-root .env', () => {
    assert.deepEqual(
      getRootEnvFilePaths('/repo/apps/api/dist/config'),
      ['/repo/.env'],
    );
  });
});
