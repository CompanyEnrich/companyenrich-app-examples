import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The SDK runs only in route handlers; keep it out of the client bundle.
  serverExternalPackages: ['@companyenrich/sdk'],
};

export default nextConfig;
