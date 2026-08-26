import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // 端口被占用时直接报错退出（默认行为是自动 +1 换端口）——杜绝"多个 dev 服务器
    // 起在不同端口、各自跑着不同版本的代码"的排查混乱（2026-08-25 用户要求固定端口）。
    // 端口占用 = 有残留实例: netstat -ano | findstr ":5173" 找 PID → taskkill /PID <pid> /F
    strictPort: true,
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
