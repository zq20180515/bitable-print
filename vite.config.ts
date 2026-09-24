import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// 重要：绝对不要给 dev server / preview 设置 X-Frame-Options 或 CSP frame-ancestors，
// 否则插件无法被飞书以 iframe 方式嵌入。
export default defineConfig({
  // base: './' 让插件可以部署在任意子路径（GitHub Pages 的 /<repo>/ 也可直接跑）
  base: './',
  plugins: [
    react(),
    {
      /*
       * ⚠️ **把构建时刻注入到 `<head>`**（2026-09-24 加，纯排障用）。
       *
       * 为什么不用 `define`：实测发现 `vite` 在 **dev 模式**下不会替换 `.tsx` 里出现的
       * `__APP_VERSION__` / `__BUILD_TIME__`（curl `/src/...` 拿到的仍是原标识符），
       * 所以 `__APP_VERSION__` 其实一直在走 `typeof … : 'dev'` 那条兜底分支、从没真正生效。
       * 而排障最需要保证的就是"**任何模式下都读得到**" ⇒ 改成在 HTML 里挂全局：
       * dev 与 build 都要过 `transformIndexHtml`，一次注入、两处可用。
       *
       * 用途：首页「开发者 → 数据自检」显示"构建于 …"。重启服务后这个时间会变；
       * 插件里没变 ⇒ 插件加载的是旧模块，**关掉插件重新打开**（刷飞书页面通常不够）。
       */
      name: 'bp-inject-build-time',
      transformIndexHtml(html: string): string {
        const stamp = new Date().toISOString()
        return html.replace(
          '</head>',
          `<script>window.__BUILD_TIME__=${JSON.stringify(stamp)};window.__BP_VERSION__=${JSON.stringify(
            pkg.version,
          )};</script></head>`,
        )
      },
    },
  ],
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
    /*
     * ⚠️ **构建时刻**（2026-09-24 加，纯排障用）。
     *
     * 起因：用户反复说"改了跟没改一模一样"，而我每次都验证过"服务端提供的代码是新的" ——
     * 缺的正是一个能一眼看出**"插件里跑的到底是哪一次构建"**的标记。
     * `vite` 每次启动（dev）/ 每次 `npm run build` 都会重新求值 ⇒ 它天然就是"这一份的身份证"。
     *
     * 显示位置：首页「开发者 → 数据自检」面板顶部（排障时第一眼看的就是那儿）。
     * 判读方法：**重启服务后这个时间应该变**；插件里没变，就说明插件加载的是旧模块、
     * 需要**关掉插件重新打开**（不是刷新飞书页面）。
     */
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    // 插件是单页 iframe，不需要 manualChunks 拆分
    chunkSizeWarningLimit: 2000,
  },
})
