import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// 重要：绝对不要给 dev server / preview 设置 X-Frame-Options 或 CSP frame-ancestors，
// 否则插件无法被飞书以 iframe 方式嵌入。
export default defineConfig({
  // base: './' 让插件可以部署在任意子路径（GitHub Pages 的 /<repo>/ 也可直接跑）
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // 故意避开 5173：本机上另有插件项目（BTNExcel 桥）长期占用该端口
    port: 5190,
    cors: true,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4190,
    cors: true,
    strictPort: true,
  },
  define: {
    // 构建期注入版本号，供"复制反馈模板"使用（F7-11）
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    // 插件是单页 iframe，不需要 manualChunks 拆分
    chunkSizeWarningLimit: 2000,
  },
})
