import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: { "/books": ["./books/*.epub"], "/books/*": ["./books/*.epub"], "/api/books": ["./books/*.epub"], "/api/books/*": ["./books/*.epub"] },
};

export default nextConfig;
