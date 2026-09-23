/**
 * 界面截图工具：把插件在"侧边栏尺寸"下的真实样子拍下来。
 *
 * 为什么要有它：无头验证只能证明"功能对"，证明不了"好不好用、好不好看"。
 * 视觉问题必须看图。侧边栏真实可用宽度只有 320–400px，所以截图也按这个尺寸来。
 *
 * 用法：node test/shot.mjs [scene] [width] [height]
 *   scene: wizard | editor | preview | probe | all
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASE = process.env.BP_BASE ?? 'http://localhost:5190'
const PORT = 9344

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

const scene = process.argv[2] ?? 'all'
const W = Number(process.argv[3] ?? 400)
const H = Number(process.argv[4] ?? 900)

const outDir = join(ROOT, '.shots')
// 浏览器 profile 建在系统临时目录：项目根不再被 `.shot-profile-*` 污染。
const profileDir = join(tmpdir(), `bp-shot-${Date.now().toString(36)}`)

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

const HELPERS = `
window.__bp = {
  byExact(sel, t) { return Array.from(document.querySelectorAll(sel)).filter(e => (e.textContent||'').trim() === t); },
  byText(sel, t) { return Array.from(document.querySelectorAll(sel)).filter(e => (e.textContent||'').includes(t)); },
  click(sel, t) { const e = this.byExact(sel,t)[0] || this.byText(sel,t)[0]; if (!e) return false; e.click(); return true; },
  count(sel) { return document.querySelectorAll(sel).length; },
};
true`

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(outDir, `${name}.png`)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`  已保存 ${name}.png`)
}

async function main() {
  if (!EDGE) {
    console.log('找不到 Edge/Chrome')
    process.exit(1)
  }
  // 不清空输出目录：文件名是确定的，直接覆盖即可。
  // （曾经清空过，结果把上一轮为了做"改造前后对比"而复制过来的图也删了。）
  mkdirSync(outDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })

  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${W},${H}`,
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
    // 侧边栏尺寸（不是浏览器窗口尺寸，是内容区）
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 2,
      mobile: false,
    })

    console.log(`视口 ${W}×${H}（模拟飞书侧边栏）`)

    // editor / preview / probe 这些场景也必须先把页面打开再点按钮，
    // 否则是在 about:blank 上瞎点，截出来只会是一张白图。
    const flow = scene === 'all' || scene === 'editor' || scene === 'preview' || scene === 'probe'
    const wantsStep1 = scene === 'wizard' || scene === 'all'

    if (wantsStep1 || flow) {
      if (wantsStep1) console.log('\n[wizard 第 1 步 · 选范围]')
      await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tab=wizard` })
      await sleep(3000)
      await cdp.eval(HELPERS)
      if (wantsStep1) await shot(cdp, '01-wizard-step1')
    }

    if (flow) {
      console.log('\n[走流程到步骤②]')
      await cdp.eval(HELPERS)
      await cdp.eval(`__bp.click('button','下一步：选模板')`)
      await sleep(900)
      await shot(cdp, '02-wizard-step2')

      // ⚠️ 2026-09-21 UI 重设计后，"新建模板（选骨架）"这个入口**改名并换了位置**：
      //    它现在是模板卡片网格里那张虚线卡，文案就是「＋ 新建模板」
      //    （其余三个入口搬进了标题右侧的「导入 / 导出」下拉）。
      await cdp.eval(`__bp.click('button','新建模板')`)
      await sleep(700)
      await shot(cdp, '03-skeleton-picker')

      // 切记录模板 → 选验收单
      // ⚠️ 类型标签页变成了分段控制器，标签文案仍是「记录模板」/「视图模板」
      //    （数量用 `.sk-tab-count` 承载，`textContent` 里是纯数字 ⇒ 这里按 included 匹配即可）。
      await cdp.eval(`__bp.click('button','记录模板')`)
      await sleep(400)
      await cdp.eval(`(() => {
        const it = Array.from(document.querySelectorAll('.sk-item')).find(e => (e.textContent||'').includes('验收单'));
        if (it) it.click(); return !!it;
      })()`)
      await sleep(300)
      await shot(cdp, '04-skeleton-picked')

      await cdp.eval(`__bp.click('button','创建并编辑')`)
      await sleep(2500)
      await shot(cdp, '05-editor-default')
    }

    if (scene === 'all' || scene === 'editor') {
      console.log('\n[编辑器各面板]')
      await cdp.eval(`__bp.click('button','元素')`)
      await sleep(500)
      await shot(cdp, '06-editor-elements')
      // 选中画布上一个元素 → 属性面板
      await cdp.eval(`(() => {
        const el = document.querySelector('[class*="bp-el-"], .bp-canvas [data-el-id]');
        if (el) el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, clientX:1, clientY:1}));
        return !!el;
      })()`)
      await sleep(600)
      await shot(cdp, '07-editor-inspector')
    }

    if (scene === 'all' || scene === 'preview') {
      console.log('\n[回到向导 → 预览]')
      await cdp.eval(`__bp.click('button','完成')`)
      await sleep(1200)
      await cdp.eval(`__bp.click('button','下一步：预览')`)
      await sleep(6000)
      await shot(cdp, '08-preview')
    }

    if (scene === 'all' || scene === 'probe') {
      console.log('\n[探针页]')
      await cdp.eval(`__bp.click('button','探针')`)
      await sleep(900)
      await shot(cdp, '09-probe')
    }
  } finally {
    try {
      if (cdp) void cdp.send('Browser.close').catch(() => {})
    } catch {}
    await sleep(300)
    child.kill()
    await sleep(600)
  }
  console.log(`\n输出目录：${outDir}`)

  // 清理放在最后且 best-effort：rmSync 是同步的，浏览器刚被 kill 时 profile 里的文件
  // 常还被占着，带 maxRetries 会把事件循环卡住。profileDir 在 os.tmpdir() 下，删不掉无妨。
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {}
}

main().catch((e) => {
  console.error('截图失败：', e)
  process.exit(1)
})
