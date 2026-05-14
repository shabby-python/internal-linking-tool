/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  api: {
    bodyParser: { sizeLimit: '2mb' },
    responseLimit: '8mb',
  },
};

module.exports = nextConfig;
