import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["ccxt", "bullmq", "ioredis", "@prisma/client"],
};

export default nextConfig;
