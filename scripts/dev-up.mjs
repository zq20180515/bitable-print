/**
 * 后台启动本地调试服务（脱离调用方会话）。
 *
 * 为什么需要这个脚本：`node node_modules/vite/bin/vite.js` 直接起在某个会话里，
 * **会话结束进程会被一起收走**，表现为浏览器里 `fetch failed`。
 * 这个坑在本项目里已经踩了三次（两个 worker 各一次、用户一次），所以固化成脚本。
 *
 * 关键在 `detached: true` + `unref()`：让 vite 成为**独立进程树**，
 * 父进程退出不会连带杀掉它。日志落到 `.dev-server.log` 便于排查。
 *
 * 用法：
 *   node scripts/dev-up.mjs            # 起服务（默认 5190）
 *   node scripts/dev-up.mjs --port 5200
 *   node scripts/dev-up.mjs --status   # 只看状态，不启动
 *
 * ⚠️ **必须在普通终端里运行**。
 * 在 agent 的沙箱里跑是没用的：那种环境会在**每条命令结束时回收它派生的所有后代进程**，
 * 实测 vite 能正常起来（日志里 `ready in 791 ms`、监听成功、探测到 HTTP 200），
 * 但命令一结束就被杀掉，随后探测变成 `ECONNREFUSED`。`detached: true` + `unref()` 也拦不住。
 * 在沙箱里要长期跑，应该用工具自带的后台任务机制，而不是这个脚本。
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const LOG = join(ROOT, '.dev-server.log')

const argv = process.argv.slice(2)
const statusOnly = argv.includes('--status')
const portIdx = argv.indexOf('--port')
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 5190
const URL = `http://127.0.0.1:${PORT}/`

async function probe(ms = 800) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), ms)
    const r = await fetch(URL, { signal: ctl.signal })
    clearTimeout(t)
    return r.status
  } catch {
    return null
  }
}

const before = await probe()
if (before !== null) {
  console.log(`已在运行：${URL} → HTTP ${before}`)
  process.exit(0)
}

if (statusOnly) {
  console.log(`未运行：${URL}（--status 模式，不启动）`)
  process.exit(1)
}

if (!existsSync(VITE)) {
  console.error(`找不到 vite：${VITE}\n请先在项目根执行 npm install`)
  process.exit(1)
}

const out = openSync(LOG, 'a')
const child = spawn(process.execPath, [VITE, '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  detached: true, // 独立进程树：父进程退出不连带杀掉
  stdio: ['ignore', out, out],
  windowsHide: true,
})
child.unref()

// 等它真正开始服务再报成功 —— 只看 spawn 成功是不够的，端口占用/编译失败都在这之后
let status = null
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  status = await probe()
  if (status !== null) break
}

if (status !== null) {
  console.log(`已启动：${URL} → HTTP ${status}`)
  console.log(`pid=${child.pid}（独立进程，不受本会话影响）`)
  console.log(`日志：${LOG}`)
  console.log('')
  console.log('带示例数据打开向导：')
  console.log(`  ${URL}?mock=1&tab=wizard`)
  process.exit(0)
}

console.error(`启动失败或超时（8 秒内未响应）。日志末尾：`)
try {
  const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
  console.error(lines.slice(-20).join('\n'))
} catch {
  console.error('（读不到日志）')
}
process.exit(1)
