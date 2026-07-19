import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { BuildMetadataSchema } from '@bourse/shared-types';
import { MetaController } from './meta.controller';

describe('MetaController', () => {
  it('returns schema-valid release metadata', () => {
    const config = new ConfigService({
      APP_VERSION: '0.1.0',
      GIT_SHA: 'abc1234',
      BUILD_DATE: '2026-07-19T06:00:00Z',
    });

    const result = new MetaController(config).getMetadata();

    assert.deepEqual(result, {
      version: '0.1.0',
      commit: 'abc1234',
      builtAt: '2026-07-19T06:00:00.000Z',
    });
    assert.equal(BuildMetadataSchema.safeParse(result).success, true);
  });

  it('uses safe local-development defaults', () => {
    const result = new MetaController(
      new ConfigService({ GIT_SHA: 'local', BUILD_DATE: 'local' }),
    ).getMetadata();

    assert.deepEqual(result, {
      version: 'dev',
      commit: null,
      builtAt: null,
    });
  });
});
