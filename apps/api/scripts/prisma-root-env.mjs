import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

config({ path: resolve(repoRoot, '.env') });

const prismaCommand = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
const child = spawn(prismaCommand, process.argv.slice(2), {
  env: process.env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Failed to start Prisma: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
