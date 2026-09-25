import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

// The browser only ever talks to this origin; API calls are proxied so the
// session cookie stays first-party (httpOnly, SameSite=Lax) and CSRF checks see our Origin.
const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['@socialpilot/validation'],
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` },
      { source: '/media/local/:path*', destination: `${apiUrl}/media/local/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
