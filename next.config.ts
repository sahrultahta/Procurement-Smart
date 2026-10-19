import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // node-postgres must run as a plain Node.js dependency, not be bundled.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
