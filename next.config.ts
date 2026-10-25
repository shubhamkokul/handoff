import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (deploy/Dockerfile).
  output: "standalone",
  // Strict mode double-runs effects in dev, which would create two sessions
  // and two listeners per page. The pages manage their own lifecycles.
  reactStrictMode: false,
  // Allow opening the dev server from a phone on the LAN.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "*.local"],
};

export default nextConfig;
