import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

// The browser only ever talks to this origin; API calls are proxied so the
// session cookie stays first-party (httpOnly, SameSite=Lax) and CSRF checks see our Origin.
/**
 * Content Security Policy (production only: the dev server needs eval and websockets).
 * Next.js inlines its bootstrap scripts, hence 'unsafe-inline' for scripts; everything
 * else is limited to our own origin, plus HTTPS images (social avatars, media previews).
 */
const csp = (frameAncestors: string) =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
const isProd = process.env.NODE_ENV === 'production';

const config: NextConfig = {
  reactStrictMode: true,
  // Hide the Next.js development badge (the "N" circle shown during `next dev`).
  devIndicators: false,
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
        // Everything except the hosted lead form (/f/...) refuses to be framed (clickjacking).
        source: '/((?!f/).*)',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }, ...(isProd ? [{ key: 'Content-Security-Policy', value: csp("'none'") }] : [])],
      },
      {
        // Hosted lead forms may be embedded in customers' websites with an iframe.
        source: '/f/:key',
        headers: [{ key: 'Content-Security-Policy', value: isProd ? csp('*') : 'frame-ancestors *' }],
      },
      {
        source: '/embed/:file*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
