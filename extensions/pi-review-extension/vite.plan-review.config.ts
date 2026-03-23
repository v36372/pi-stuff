import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';

export default defineConfig({
  root: path.resolve(__dirname, 'plan-review-ui'),
  server: {
    port: 3002,
    host: '0.0.0.0',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/shared': path.resolve(__dirname, '../../packages/shared'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-plan-review'),
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
