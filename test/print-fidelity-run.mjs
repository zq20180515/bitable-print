/**
 * 打印保真度探针的运行器：用 CDP 驱动真实 Chromium 打开探针页，
 * 读回"逐块实测几何 + 叠压判定"，并顺手截图。
 *
 * 用法：node test/print-fidelity-run.mjs [label]
 *   label 用于截图文件名（如 before / after），默认 probe
 *
 * 产物：
 *   .shots-fidelity/print-fidelity-<label>.png
 *   stdout 上的 JSON（请重定向到文件再读，本机 shell 的 stdout 会间歇性被吞）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASE = process.env.BP_BASE ?? 'http://localhost:5190'
const PORT = 9355
const label = process.argv[2] ?? 'probe'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

const outDir = join(ROOT, '.shots-fidelity')
const profileDir = join(tmpdir(), `bp-fid-${Date.now().toString(36)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时 ${method}`))
        }
      }, 25000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result?.value
  }
}

async function main() {
  if (!EDGE) {
    console.log('找不到 Edge/Chrome')
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })

  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      // 渲染分页里有 `await requestAnimationFrame` 的让出点（measure/pipeline）。
      // 无头环境一旦把页面判成"后台/被遮挡"，rAF 就永远不触发 → renderDocument 卡死、
      // 探针 25 秒不出结果。这三个开关是必须的。
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1500,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp = null
  try {
    let target = null
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find((t) => t.type === 'page')
        if (target?.webSocketDebuggerUrl) break
      } catch {}
      await sleep(300)
    }
    if (!target) throw new Error('连不上调试端口')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })

    await cdp.send('Page.navigate', { url: `${BASE}/test/print-fidelity-probe.html` })
    try {
      await cdp.send('Page.bringToFront')
    } catch {}

    let result = null
    for (let i = 0; i < 60; i++) {
      await sleep(400)
      try {
        const v = await cdp.eval('window.__fidelity ?? null')
        if (v && v.ready) {
          result = v
          break
        }
      } catch {}
    }
    if (!result) {
      const errs = await cdp.eval('window.__errors ?? []').catch(() => [])
      const st = await cdp.eval('window.__stage ?? "(未进入模块)"').catch(() => '?')
      throw new Error(`探针 25 秒内没出结果。最后阶段：${st}；页面错误：${JSON.stringify(errs)}`)
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const file = join(outDir, `print-fidelity-${label}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))

    console.log(JSON.stringify(result, null, 2))
    console.log(`\n截图：${file}`)
    if (result.error) process.exitCode = 2
  } finally {
    try {
      if (cdp) void cdp.send('Browser.close').catch(() => {})
    } catch {}
    await sleep(300)
    child.kill()
    await sleep(500)
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {}
  }
}

main().catch((e) => {
  console.error('探针失败：', e)
  process.exit(1)
})
