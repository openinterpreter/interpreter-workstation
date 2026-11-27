import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** Browser-package bundle gate; the GGUF weights themselves are never build inputs. */
export default defineConfig({
  server: { headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  } },
  build: {
    outDir: resolve(import.meta.dirname, '.browser-build'),
    emptyOutDir: true,
    lib: { entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'], fileName: 'browser-agent-core' },
  },
});
