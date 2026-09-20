import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship raw TS/TSX (resolved via their `main: ./src/index.ts`);
  // Next must transpile them rather than expect prebuilt JS.
  transpilePackages: ['@core/ui', '@core/feature-auth', '@core/contracts', '@core/tokens'],
};

export default nextConfig;
