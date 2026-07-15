import { resolve } from 'node:path';
import { config } from 'dotenv';

/** Resolve the monorepo-root env files from src/config or dist/config. */
export function getRootEnvFilePaths(moduleDir: string): string[] {
  const repoRoot = resolve(moduleDir, '../../../..');
  return [resolve(repoRoot, '.env')];
}

export const ROOT_ENV_FILE_PATHS = getRootEnvFilePaths(__dirname);

/**
 * Load root env before importing Prisma-backed modules. Prisma may inspect a
 * package-local .env during module initialization; preloading here prevents
 * that legacy file from overriding the monorepo source of truth.
 */
export function loadRootEnv(): void {
  for (const path of ROOT_ENV_FILE_PATHS) config({ path });
}
