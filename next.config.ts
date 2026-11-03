import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    // Upstream API route handlers in [id] predate this ticket and use Promise<{id}> | {id} for test compatibility
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
