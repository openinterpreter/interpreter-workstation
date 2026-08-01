import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "node:path";

const reactCompilerPanicThreshold = process.env.REACT_COMPILER_PANIC_THRESHOLD ?? 'none';

export default defineConfig(() => {
  const debugRendererBuild = process.env.INTERPRETER_OVERLAY_DEBUG_BUILD === 'true';

  return {
    define: {
      'process.env.NODE_ENV': JSON.stringify(debugRendererBuild ? 'development' : 'production'),
    },
    plugins: [
      react({
        // React Compiler auto-memoizes eligible components and hooks to reduce render work.
        // Keep CI strict while leaving production builds on React's recommended panicThreshold.
        // See docs/react-compiler.md for live React citations and the opt-out policy.
        babel: {
          plugins: [
            ['babel-plugin-react-compiler', { panicThreshold: reactCompilerPanicThreshold }],
          ],
        },
      }),
      tailwindcss(),
      sentryVitePlugin({
        org: 'open-interpreter',
        project: 'electron',
        authToken: process.env.SENTRY_AUTH_TOKEN,
        sourcemaps: {
          filesToDeleteAfterUpload: ['./dist/**/*.map'],
        },
        telemetry: false,
        disable: debugRendererBuild || !process.env.SENTRY_AUTH_TOKEN,
      }),
    ],
    root: ".",
    publicDir: "public",
    base: "./", // Use relative paths for Electron
    build: {
      outDir: "dist",
      emptyOutDir: true,
      minify: debugRendererBuild ? false : undefined,
      sourcemap: debugRendererBuild ? true : 'hidden',
      rollupOptions: {
        input: [
          path.resolve(__dirname, 'index.html'),
          path.resolve(__dirname, 'apps/interpreter-overlay/renderer/overlay.html'),
          path.resolve(__dirname, 'apps/interpreter-overlay/renderer/world.html'),
        ],
        output: {
          // Ensure PDF.js worker is copied to output
          assetFileNames: (assetInfo) => {
            if (assetInfo.name && assetInfo.name.includes('pdf.worker')) {
              return 'assets/pdf.worker-[hash][extname]';
            }
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
    server: {
      port: parseInt(process.env.VITE_PORT || '5173', 10),
      strictPort: false, // Allow fallback to next available port for multi-instance support
      warmup: {
        // The overlay renderers load hidden at app startup and must mount
        // immediately; without warmup their module transforms queue behind the
        // much larger main-window graph and the overlay can stall for minutes
        // on a cold dev server.
        clientFiles: [
          './apps/interpreter-overlay/renderer/overlay-entry.tsx',
          './apps/interpreter-overlay/renderer/world-entry.tsx',
        ],
      },
      fs: {
        // Allow serving files from node_modules (for PDF.js worker)
        allow: ['..'],
      },
      proxy: {
        // Proxy API requests to the Express server (browser dev mode only)
        '/api': {
          target: `http://localhost:${process.env.EXPRESS_PORT || '5177'}`,
          changeOrigin: true,
        },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    optimizeDeps: {
      exclude: ['pdfjs-dist'],
    },
  };
});
