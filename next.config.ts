import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * PGlite ships a WASM build with its own filesystem shim that breaks when it
   * is bundled; Neon's driver opens sockets. Both must stay external to the
   * server bundle and be required at runtime instead.
   */
  serverExternalPackages: ['@electric-sql/pglite', '@neondatabase/serverless'],
  typedRoutes: true,
  typescript: {
    // Never ship a build that doesn't typecheck.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
