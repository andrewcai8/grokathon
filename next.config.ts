import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // nothing may overlay the canvas during a demo
  devIndicators: false,
  images: {
    // X serves avatars from pbs.twimg.com
    remotePatterns: [{ protocol: "https", hostname: "pbs.twimg.com" }],
  },
};

export default nextConfig;
