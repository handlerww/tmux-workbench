import { defineConfig } from 'vite';

const backend = process.env.WORKBENCH_BACKEND ?? 'http://127.0.0.1:7690';
const wsBackend = backend.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      '/api': backend,
      '/ws': {
        target: wsBackend,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: '../web/dist',
    emptyOutDir: true,
  },
});
