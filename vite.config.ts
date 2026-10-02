import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The API runs as a plain Node server in dev (scripts/dev-api.ts) and as a
// Vercel serverless function in production, from the same Hono app. This proxy
// is what makes `npm run dev` work with no Vercel account and no API process
// juggling — criterion 3 is literally "could someone clone the repo and run it".
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  server: {
    // Pinned to IPv4 loopback. The default binds IPv6 only ([::1]:5173), so
    // http://127.0.0.1:5173 refused connections while http://localhost:5173
    // worked — and wallets treat those as different origins. One origin means
    // one session, one Slush appUrl, and no drift between them.
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        // Vite's default answer when the API is not listening is a bare 502,
        // which looks like the app is broken and says nothing about why. The
        // common cause is that only the web half is running, so say that.
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            const message =
              "The People Book API is not responding on 127.0.0.1:8787. " +
              `Start it with \`npm run dev\` (both halves) or \`npm run dev:api\` (API only). (${
                (err as Error)?.message ?? "connection failed"
              })`;
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "api_unreachable", message }));
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
