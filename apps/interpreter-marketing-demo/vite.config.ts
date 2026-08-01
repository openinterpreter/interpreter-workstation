import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  root: __dirname,
  publicDir: path.resolve(__dirname, "public"),
  envDir: repoRoot,
  base: "/",
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 4174,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(repoRoot, "src"),
    },
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
});
