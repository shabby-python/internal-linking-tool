/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  api: {
    bodyParser: { sizeLimit: '2mb' },
    responseLimit: '8mb',
  },
  // Exclude browser/rendering packages from webpack bundling.
  // These are native Node.js modules that must run outside the webpack bundle.
  serverExternalPackages: [
    'puppeteer-core',
    '@sparticuz/chromium',
    'playwright',
    'playwright-core',
  ],
};

module.exports = nextConfig;
