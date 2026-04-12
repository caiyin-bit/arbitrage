import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ccxt", "bullmq", "ioredis"],
};

export default nextConfig;
