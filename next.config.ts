import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  typescript: {
    // Never ship a build that doesn't typecheck.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
