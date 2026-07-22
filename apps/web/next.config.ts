import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Keep production builds from overwriting a running dev server's chunks.
  distDir:
    process.env.NEXT_DIST_DIR
    ?? (process.env.NODE_ENV === 'production' ? '.next-build' : '.next'),
  outputFileTracingRoot: path.join(__dirname, '../..'),
  transpilePackages: ['@bourse/shared-types'],
};

export default nextConfig;
