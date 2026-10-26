import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // sharp is a native module; keep it out of the bundle.
  serverExternalPackages: ['sharp'],
  experimental: {
    // Set by `next upgrade --agent=security` (16.4.0 → 16.4.3).
    agentUpgrade: 'security',
  },
};

export default nextConfig;
