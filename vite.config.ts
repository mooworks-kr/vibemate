import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, 'src/web'),
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:7321',
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      '@server': path.resolve(__dirname, 'src/server'),
    },
  },
});
