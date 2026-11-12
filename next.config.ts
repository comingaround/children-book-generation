import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // sharp is a native module; keep it out of the bundle.
  serverExternalPackages: ['sharp'],
  // Books and examples are read from data/ at runtime; on Vercel they must ship with the functions.
  outputFileTracingIncludes: {
    '/': ['./data/books/**/*', './data/examples/**/*'],
    '/**/*': ['./data/books/**/*', './data/examples/**/*'],
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
