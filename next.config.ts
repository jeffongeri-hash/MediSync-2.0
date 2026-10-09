import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg and the generated Prisma client run server-side only.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
