import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      // /ws is NOT proxied: the browser connects straight to the backend
      // (see WS_URL in LivePower.jsx). Proxying websockets through Vite
      // spams EPIPE errors whenever a client disconnects mid-write.
    },
  },
});
