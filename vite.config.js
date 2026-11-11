import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  server: {
    proxy: {
      "/geocoder": {
        target: "https://geocoding.geo.census.gov",
        changeOrigin: true,
      },
    },
  },
});
