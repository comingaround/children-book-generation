import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // sharp is a native module; keep it out of the bundle.
  serverExternalPackages: ['sharp'],
};

export default nextConfig;
