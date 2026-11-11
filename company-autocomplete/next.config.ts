import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The SDK runs only in the route handler; keep it out of the client bundle.
  serverExternalPackages: ['@companyenrich/sdk'],
};

export default nextConfig;
