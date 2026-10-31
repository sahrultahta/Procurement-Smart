import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // A self-contained server in .next/standalone (docs/deployment.md); `npm run build` then packages it.
  // Vercel builds its own functions and sets VERCEL during the build.
  ...(process.env.VERCEL ? {} : { output: 'standalone' as const }),
  // node-postgres must run as a plain Node.js dependency, not be bundled.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
