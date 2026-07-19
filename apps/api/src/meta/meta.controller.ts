import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BuildMetadataSchema,
  type BuildMetadata,
} from '@bourse/shared-types';

@Controller('meta')
export class MetaController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getMetadata(): BuildMetadata {
    return BuildMetadataSchema.parse({
      version: this.config.get<string>('APP_VERSION') || 'dev',
      commit: optionalValue(this.config.get<string>('GIT_SHA')),
      builtAt: optionalBuildDate(this.config.get<string>('BUILD_DATE')),
    });
  }
}

function optionalValue(value: string | undefined): string | null {
  return value && !['unknown', 'local'].includes(value) ? value : null;
}

function optionalBuildDate(value: string | undefined): string | null {
  if (!value || ['unknown', 'local'].includes(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
}
