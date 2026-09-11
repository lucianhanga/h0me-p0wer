import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      // /ws is NOT proxied: the browser connects straight to the backend
      // (see WS_URL in LivePower.jsx). Proxying websockets through Vite
      // spams EPIPE errors whenever a client disconnects mid-write.
    },
  },
});
