import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@bourse/shared-types'],
};

export default nextConfig;
