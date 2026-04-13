import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["ccxt", "bullmq", "ioredis"],
};

export default nextConfig;
