import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The SDKs run only in route handlers; keep them out of the client bundle.
  serverExternalPackages: ['@companyenrich/sdk', '@anthropic-ai/sdk'],
};

export default nextConfig;
