/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // Relative asset prefix lets the static export run from any sub-path (preview hosting).
  assetPrefix: process.env.ASSET_PREFIX || undefined,
  reactStrictMode: true,
};
export default nextConfig;
