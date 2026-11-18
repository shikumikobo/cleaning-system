import type { NextConfig } from "next";

// 静的な書き出し（Cloudflare Pages に置く）。サーバーの処理は Supabase 側。
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
};

export default config;
