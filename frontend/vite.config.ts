import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const targetUrl = env.VITE_API_URL || "https://abdrabobackend-production.up.railway.app";

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
      proxy: {
        "/api": {
          target: targetUrl,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
    },
  };
});