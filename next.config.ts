import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // sharp is a native module; keep it out of the bundle.
  serverExternalPackages: ['sharp'],
  // Books are read from data/books/ at runtime; on Vercel they must ship with the functions.
  outputFileTracingIncludes: {
    '/': ['./data/books/**/*'],
    '/**/*': ['./data/books/**/*'],
  },
  outputFileTracingExcludes: {
    '/**/*': ['./data/runs/**/*', './data/children/**/*', './data/uploads/**/*'],
  },
  experimental: {
    // Set by `next upgrade --agent=security` (16.4.0 → 16.4.3).
    agentUpgrade: 'security',
  },
};

export default nextConfig;
