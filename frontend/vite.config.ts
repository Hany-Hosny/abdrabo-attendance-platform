import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const defaultUrl = mode === "development" ? "http://127.0.0.1:4000" : "https://abdrabobackend-production.up.railway.app";
  const targetUrl = env.VITE_API_URL || defaultUrl;

  return {
    plugins: [react(), basicSsl()],
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
