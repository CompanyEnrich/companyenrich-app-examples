import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The SDK runs only in route handlers, never in the browser.
  serverExternalPackages: ['@companyenrich/sdk'],
};

export default nextConfig;
