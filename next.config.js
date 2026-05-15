/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // Exclude browser/rendering packages from webpack bundling.
  // Next.js 14.x uses experimental.serverComponentsExternalPackages.
  experimental: {
    serverComponentsExternalPackages: [
      'puppeteer-core',
      '@sparticuz/chromium',
      'playwright',
      'playwright-core',
    ],
  },
};

module.exports = nextConfig;
