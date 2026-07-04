/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@zoft/contract"],
  // Bundles just the files `next start` actually needs (.next/standalone)
  // into a self-contained folder — the standard way to Dockerize a Next.js
  // app (apps/frontend/Dockerfile), and irrelevant to `next dev`/local tests.
  output: "standalone",
};

export default nextConfig;
