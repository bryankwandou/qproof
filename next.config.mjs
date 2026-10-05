const isDev = process.env.NODE_ENV !== "production";
const origins = (urls) =>
  urls.flatMap((u) => {
    try {
      return [new URL(u).origin];
    } catch {
      return [];
    }
  });
const rpc = origins([
  process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
  process.env.NEXT_PUBLIC_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
]);
const ws = rpc.map((o) => o.replace(/^http/, "ws"));

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; drop 'unsafe-inline' later by using nonces.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", // wallet adapter icons are data: URIs
  "font-src 'self' data:",
  `connect-src 'self' ${[...rpc, ...ws].join(" ")}${isDev ? " ws://localhost:* http://localhost:*" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: false },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
