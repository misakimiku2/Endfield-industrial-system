import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ['pixi.js'],
        },
      },
    },
  },
});
