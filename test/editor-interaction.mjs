/**
 * 画布交互端到端验证：拖动 / 缩放 / 删除 / 合并 / 拆分 / 属性面板 / 撤销。
 *
 * 为什么必须单独写这一份：
 * 用户报的原始缺陷是「编辑页完全不可用，无法进行任何编辑，包括拖动、增加删除组件、
 * 合并拆分单元格之类的，无法对单元格内的文本做任何编辑，点击到表格内的字段时，
 * 右侧的属性还是显示的表格的属性」。交付方只做了截图 + 代码级核对就宣布修好了。
 * 截图只能证明"页面上有这些东西"，证明不了"拖得动、删得掉、能合并"。
 *
 * 已有的 test/window-handshake.mjs 第 7 节已经证明了「从左侧元素区拖入新元素 → 元素数 +1」，
 * 所以本脚本**不重复**验证"增加组件"，只补它没覆盖的部分。
 *
 * 与前两份脚本的关系：骨架直接抄 test/editor-cell-edit.mjs（CDP 直连 + 真实指针事件）。
 * 调试端口**每次随机**取一个确认空闲的（原因见下面 pickFreePort 的注释）。
 *
 * 用法：node test/editor-interaction.mjs
 * 前置：dev server 已经在 http://localhost:5190 跑着（本脚本不启动也不停它）
 *
 * ------------------------------------------------------------------
 * 「同名小工具」跨段清单（改一处必须看另一处）
 *
 * 本文件是一个三千多行的 try 块，每段自带作用域，**段与段之间看不见彼此的局部函数**。
 * 于是有几处只能是"同款各写一份"（复制，不是复用）。代价是：改了一处，另一处不会跟着变，
 * 而"两处行为悄悄分叉"在这个项目里已经栽过（同一个逻辑两份实现，只有一份被改）。
 * 所以在文件头登记在案，改动前按名字全文搜一遍：
 *
 *   1. `switchPalette`（[13] 段，定义在它自己的块里）
 *      ↔ `switchPalette14`（[14] 段 E 组）—— 左侧插入面板的页签切换，两份逐字相同。
 *      两处都挂了指向这条清单的注释。
 *   2. `withProduct`（[14] 段 E 组）—— 打开预览 → 等产物就绪 → 在产物里读数 → 关掉。
 *      只有这一份（[14] 的 C 组用的是它自己那段的打开 / 关闭序列，口径不同）。
 *   3. `dragSession` / `dblClickAt`（[15] 段）—— 支持修饰键、且能在**松手之前**读页面。
 *      模块级的 `dragTo` / `clickAt` 是公共工具，改它们会影响所有段。
 *
 * 为什么不合并成一个带参数的公共工具：上面几处对"等待时长 / 读数口径"的假设各不相同
 * （例如 `switchPalette` 之后那 450ms 是留给面板重排的），合并之后每一段都要重新确认参数，
 * 反而更容易改错。登记清楚比强行复用划算。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BP_BASE ?? 'http://localhost:5190'

/**
 * 调试端口**不能写死**（照 test/range-picker.mjs 的写法）。
 *
 * 踩过的坑：脚本崩溃或被强杀时，Edge 的**浏览器进程**不是我们 spawn 的那个 launcher，
 * `child.kill()` 杀不掉它 —— 它会变成孤儿继续占着这个端口。下一次运行
 * `--remote-debugging-port` 绑不上，而 `/json/list` 仍然是通的，于是新脚本连上的是
 * **上一个僵尸**，然后在随机的地方 `Runtime.evaluate` 卡 25 秒超时。
 * 症状极具误导性：失败点每次都不一样（本项目这轮就撞过一次 ECONNREFUSED 9366）。
 *
 * 所以：每次运行挑一个**确认空闲**的随机端口，连上之后再核对目标页确实是刚起的
 * 那张 `about:blank` —— 两层都在，才能确定连上的是自己刚拉起来的那一只。
 */
async function isPortBusy(p) {
  try {
    await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(400) })
    return true
  } catch {
    return false
  }
}

async function pickFreePort() {
  for (let i = 0; i < 40; i++) {
    const p = 9300 + Math.floor(Math.random() * 500)
    if (!(await isPortBusy(p))) return p
  }
  throw new Error('找不到空闲的调试端口（可能有大量残留浏览器进程）')
}

/** 由 main 在 spawn 之前赋值 */
let PORT = 0

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

// 浏览器 profile 建在系统临时目录：项目根不再被 `.inter-profile-*` 污染，
// 万一删不掉也由 OS 最终回收。
const profileDir = join(tmpdir(), `bp-inter-${Date.now().toString(36)}`)

/*
 * 耗时账本：为什么这套脚本跑起来这么慢，光看总时长分不清是"某一步卡住了"还是
 * "几百次 CDP 往返各慢一点点"。把 sleep / CDP 往返 / 最慢的几次 eval 分开记，
 * 跑完一次性打出来 —— 以后有人要优化，不必再靠猜。
 */
const TIMING = { sleepMs: 0, evals: 0, evalMs: 0, sends: 0, sendMs: 0, slowEvals: [] }
const sleep = (ms) => {
  TIMING.sleepMs += ms
  return new Promise((r) => setTimeout(r, ms))
}

let pass = 0
const failures = []
/** 每条断言都必须带上"观察到的前后值"——只断言"没抛异常"是零信息量的 */
function ok(name, cond, detail = '') {
  const tail = detail ? `  →  ${detail}` : ''
  if (cond) {
    pass++
    console.log(`  PASS  ${name}${tail}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${tail}`)
  }
}
/** 只打印观测值、不计分（用来给人看"这条路径到底发生了什么"） */
function note(label, value) {
  console.log(`        · ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

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
    const t0 = Date.now()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`超时 ${method}`))
        }
      }, 25000)
    }).finally(() => {
      TIMING.sends += 1
      TIMING.sendMs += Date.now() - t0
    })
  }
  async eval(expression) {
    const t0 = Date.now()
    try {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
      return r.result?.value
    } finally {
      const ms = Date.now() - t0
      TIMING.evals += 1
      TIMING.evalMs += ms
      if (ms > 300) {
        TIMING.slowEvals.push({ ms, head: String(expression).replace(/\s+/g, ' ').slice(0, 70) })
        TIMING.slowEvals.sort((a, b) => b.ms - a.ms)
        if (TIMING.slowEvals.length > 10) TIMING.slowEvals.length = 10
      }
    }
  }
}

// ============================================================
// 页面内小工具
// ============================================================

const HELPERS = `
window.__bp = {
  byExact(sel, t) { return Array.from(document.querySelectorAll(sel)).filter(e => (e.textContent||'').trim() === t) },
  byText(sel, t) { return Array.from(document.querySelectorAll(sel)).filter(e => (e.textContent||'').includes(t)) },
  click(sel, t) { const e = this.byExact(sel,t)[0] || this.byText(sel,t)[0]; if (!e) return false; e.click(); return true },
  count(sel) { return document.querySelectorAll(sel).length },
  text() { return document.body.innerText || '' },
  has(sel) { return document.querySelector(sel) !== null },
  /** 全部画布元素（data-el-id 是最可靠的钩子；.bp-el:nth-child 会被手柄/提示节点打乱） */
  els() {
    return Array.from(document.querySelectorAll('[data-el-id]')).map(e => {
      const r = e.getBoundingClientRect()
      return {
        id: e.getAttribute('data-el-id'),
        kind: (String(e.className).match(/bp-el--([a-z]+)/) || [])[1] || '',
        sel: e.classList.contains('is-selected'),
        oob: e.classList.contains('is-oob'),
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        text: (e.textContent || '').trim().slice(0, 12),
      }
    })
  },
  one(id) { return this.els().find(e => e.id === id) || null },
  /**
   * 找一个"点下去真的能命中这个元素"的屏幕点。
   * 为什么不直接取中心：元素之间会重叠，后来者盖在上面时中心点是别人的。
   * 这里按小网格采样，用 elementFromPoint 反向确认命中，顺便避开缩放手柄。
   */
  point(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (!(r.width >= 2 && r.height >= 2)) return null
    for (const fx of [0.5, 0.38, 0.62, 0.24, 0.76]) {
      for (const fy of [0.5, 0.38, 0.62, 0.24, 0.76]) {
        const x = Math.round(r.left + r.width * fx)
        const y = Math.round(r.top + r.height * fy)
        const hit = document.elementFromPoint(x, y)
        if (!hit) continue
        if (!(hit === el || el.contains(hit))) continue
        if (hit.classList && hit.classList.contains('bp-handle')) continue
        return { x, y }
      }
    }
    return null
  },
  pointSel(sel, idx) { return this.point(document.querySelectorAll(sel)[idx || 0]) },
  pointEl(id) { return this.point(document.querySelector('[data-el-id="' + id + '"]')) },
  /**
   * 缩放手柄的可点位置。
   * 手柄中心正好压在元素角上，一旦有邻居元素叠在那个角上（后来者绘在上层），
   * 直着点手柄中心会打到邻居身上 —— 那就不是"缩放没生效"，而是"根本没按到手柄"。
   * 所以这里必须用 elementFromPoint 确认命中的确实是这个手柄，否则把挡路者报出来。
   */
  pointHandle(dir) {
    const h = document.querySelector('.bp-el.is-selected .bp-handle--' + dir)
    if (!h) return null
    const r = h.getBoundingClientRect()
    if (!(r.width >= 2 && r.height >= 2)) return { blocked: true, why: '手柄尺寸不可点', w: Math.round(r.width), h: Math.round(r.height) }
    for (const fx of [0.5, 0.4, 0.6, 0.32, 0.68]) {
      for (const fy of [0.5, 0.4, 0.6, 0.32, 0.68]) {
        const x = Math.round(r.left + r.width * fx)
        const y = Math.round(r.top + r.height * fy)
        if (document.elementFromPoint(x, y) === h) return { x, y, w: Math.round(r.width), h: Math.round(r.height) }
      }
    }
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    const b = document.elementFromPoint(cx, cy)
    return {
      blocked: true, why: '手柄中心被别的节点挡住',
      at: { x: cx, y: cy },
      by: b ? (b.getAttribute('data-el-id') || String(b.className)) : null,
      w: Math.round(r.width), h: Math.round(r.height),
    }
  },
  rect(id) {
    const e = document.querySelector('[data-el-id="' + id + '"]')
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  },
  /**
   * 两个画布元素的矩形是否相交（同时给出交叠的宽高，px 与 mm 各报一份）。
   * 用来证明「版式区之间的元素不再叠压」——只看"两个矩形都不为空"证明不了这件事。
   *
   * 交叠量用**未取整**的矩形算：版式区边界上两端常常只差零点几毫米，
   * 各自 Math.round 之后会凭空多出 1px，把"贴边"判成"叠了 1px"（这种假阳性随
   * 画布缩放/滚动位置来回翻，同一份代码能一次绿一次红）。毫米值保留 3 位小数，
   * 这样 0.06mm 这种量级也看得见。
   */
  overlapOf(idA, idB) {
    const ea = document.querySelector('[data-el-id="' + idA + '"]')
    const eb = document.querySelector('[data-el-id="' + idB + '"]')
    if (!ea || !eb) return null
    const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect()
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
    const s = this.scale() || 1
    const pxPerMm = (96 / 25.4) * s
    const mm = (n) => Math.round((n / pxPerMm) * 1000) / 1000
    return {
      intersect: w > 0 && h > 0,
      w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100,
      mm: { w: mm(w), h: mm(h) },
      a: this.rect(idA), b: this.rect(idB),
      raw: { aBottom: ra.bottom, bTop: rb.top, aTop: ra.top, bBottom: rb.bottom },
    }
  },
  /**
   * 元素**可见区域的正中心**（屏幕坐标）。
   *
   * 只做"滚到视野里 + 取矩形中点"，**不做任何采样、不用 elementFromPoint 回退**：
   * 这一条要证明的正是"用户直着点一下中心就能选到"，采样会把结论洗掉
   * （旧行为下循环区那张表只能靠 11×11 撒点才点得到，采样等于替它掩盖了缺陷）。
   */
  centerOf(id) {
    const e = document.querySelector('[data-el-id="' + id + '"]')
    if (!e) return null
    try { e.scrollIntoView({ block: 'center', inline: 'center' }) } catch (err) {}
    const r = e.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const vw = window.innerWidth, vh = window.innerHeight
    return {
      x, y,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: x > 1 && y > 1 && x < vw - 1 && y < vh - 1,
      vp: [vw, vh],
    }
  },
  num(label) { return document.querySelector('input[aria-label="' + label + '"]') },
  /** 受控 input 必须走原生 setter + input 事件，直接 .value = x 不会触发 React onChange */
  setNum(label, v) {
    const i = this.num(label)
    if (!i) return null
    i.focus()
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    d.set.call(i, String(v))
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.blur()
    return i.value
  },
  numVal(label) { const i = this.num(label); return i ? i.value : null },
  blurAll() { const a = document.activeElement; if (a && a.blur) a.blur(); return document.activeElement === document.body || document.activeElement === null },
  scale() {
    const p = document.querySelector('.bp-paper')
    if (!p) return null
    const inv = parseFloat(getComputedStyle(p).getPropertyValue('--bp-inv'))
    return Number.isFinite(inv) && inv > 0 ? 1 / inv : null
  },
  /** 右侧属性面板当前可见的文本（用来直接观察"上下文是哪一层"） */
  panel() {
    const p = document.querySelector('.bp-panel--inspector')
    return p ? (p.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null
  },
  /** 表格某一行的 td 快照 */
  row(i) {
    const tr = document.querySelectorAll('.bp-el-table tbody tr')[i]
    if (!tr) return null
    const tds = Array.from(tr.querySelectorAll('td'))
    return {
      tdCount: tds.length,
      colspans: tds.map(t => Number(t.getAttribute('colspan') || 1)),
      cells: tds.map(t => (t.textContent || '').trim().slice(0, 8)),
      selected: tds.map(t => t.classList.contains('is-selected')),
    }
  },
  table() {
    const t = document.querySelector('.bp-el-table')
    if (!t) return null
    const tds = Array.from(t.querySelectorAll('td'))
    // 注意：不能数 td[colspan] —— React 会把 colSpan={1} 也渲染成 colspan="1"，
    // 那样"有 colspan 的格子数"永远等于格子总数，看不出合并。
    return { rows: t.querySelectorAll('tbody tr').length, tds: tds.length,
             merged: tds.filter(x => Number(x.getAttribute('colspan') || 1) > 1
                                  || Number(x.getAttribute('rowspan') || 1) > 1).length }
  },
  btn(label) { return document.querySelector('[aria-label="' + label + '"]') },
  btnState(label) { const b = this.btn(label); return b ? { found: true, disabled: !!b.disabled } : { found: false } },
  clickBtn(label) { const b = this.btn(label); if (!b) return { ok: false }; if (b.disabled) return { ok: false, disabled: true }; b.click(); return { ok: true } },
  /**
   * 合并确认层（缺陷：合并会**无声地永久丢弃**被并掉那格里的字段占位符）。
   * 同时报出 backdrop 的 z-index —— 这个项目踩过"宿主盖住下拉层"的坑，
   * 新弹层的层级必须有据可查，而不是"看起来在上面"。
   */
  mergeConfirm() {
    const d = document.querySelector('.bp-merge-confirm');
    if (!d) return { present: false };
    const r = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    const bd = document.querySelector('.bp-confirm-backdrop');
    return {
      present: true,
      visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
      text: (d.innerText || '').replace(/\\s+/g, ' ').trim(),
      backdropZ: bd ? Number(getComputedStyle(bd).zIndex) || 0 : null,
      toastZ: Number(getComputedStyle(document.documentElement).getPropertyValue('--z-toast')) || null,
    };
  },
  /** 确认层里某个按钮（按 aria-label 找） */
  confirmBtn(label) { return document.querySelector('.bp-merge-confirm [aria-label="' + label + '"]') },
  /**
   * 开关（role=switch）的完整状态。
   * 为什么必须同时报 disabled 和 checked：缺陷是"点了没反应"和"静默禁用"，
   * 只报"元素在不在"看不出这两件事。
   */
  switchState(label) {
    const b = document.querySelector('[aria-label="' + label + '"]')
    if (!b) return { found: false }
    return { found: true, role: b.getAttribute('role'), disabled: !!b.disabled, checked: b.getAttribute('aria-checked') === 'true' }
  },
  clickSwitch(label) {
    const b = document.querySelector('[aria-label="' + label + '"]')
    if (!b) return { ok: false, why: '找不到开关' }
    if (b.disabled) return { ok: false, disabled: true }
    b.click()
    return { ok: true }
  },
  /** 左侧页边距窄槽里那个版式区标签的 tooltip —— 循环区的说明文字就在这里 */
  bandHint(band) {
    const c = document.querySelector('.bp-band--' + band + ' .bp-band__chip')
    return c ? (c.getAttribute('title') || '') : null
  },
  /**
   * 元素属性面板里「所属版式区」当前亮着的是哪一个。
   * 表格元素可能不止一张（「通用清单」就是"表头一张表 + 循环区一张表"），
   * 光按 kind 取第一张会挑错，必须靠这个把"循环区那张"认出来。
   */
  activeBand() {
    const g = document.querySelector('[aria-label="所属版式区"]')
    if (!g) return null
    const on = Array.from(g.querySelectorAll('button')).find(b => b.getAttribute('aria-checked') === 'true')
    return on ? (on.textContent || '').trim() : null
  },
  /** 第③步「分页规则」那一段的每个 seg 项（含是否被禁用） */
  segs() {
    return Array.from(document.querySelectorAll('.seg-item')).map(b => ({
      label: (b.textContent || '').trim(), disabled: !!b.disabled, pressed: b.getAttribute('aria-pressed') === 'true',
    }))
  },
  /** 只挑「每 N 条」那四个 —— 第①步的打印范围 seg 也长这样，不筛会串台 */
  perPageSegs() {
    const want = ['自动', '每 1 条', '每 5 条', '每 10 条']
    return this.segs().filter(s => want.includes(s.label))
  },
  /** 第③步标题行（分页规则 + seg + 冲突说明）的可见文本 */
  prevHead() {
    const h = document.querySelector('.wiz-prev-head')
    return h ? (h.innerText || '').replace(/\\s+/g, ' ').trim() : null
  },
  /** 某张模板卡片上的「更多操作」菜单：item 传 null 只展开菜单，传字符串则点那一项 */
  cardMenu(tplName, item) {
    const card = Array.from(document.querySelectorAll('.wiz-tpl')).find(c => ((c.querySelector('.wiz-tpl-name') || {}).textContent || '').includes(tplName))
    if (!card) return { ok: false, why: '找不到模板卡片 ' + tplName }
    if (item === null) {
      const m = card.querySelector('[aria-label="更多操作"]')
      if (!m) return { ok: false, why: '卡片上没有更多操作' }
      m.click()
      return { ok: true }
    }
    const btn = Array.from(document.querySelectorAll('.wiz-tpl-menu button')).find(b => (b.textContent || '').trim() === item)
    if (!btn) return { ok: false, why: '菜单里没有 ' + item }
    btn.click()
    return { ok: true }
  },
}
true`

async function waitFor(cdp, expr, timeoutMs = 6000, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await cdp.eval(expr)) return true
    } catch {}
    await sleep(step)
  }
  return false
}

/** 真实指针点击（编辑器里很多交互走 Pointer Events，element.click() 不触发） */
async function clickAt(cdp, x, y, times = 1) {
  for (let n = 0; n < times; n++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n + 1,
    })
    await sleep(40)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n + 1,
    })
    await sleep(80)
  }
}

/**
 * 真实拖动。
 * 单次 mousePressed→mouseReleased 会被判成单击；中间点太少编辑器的拖动会话还没建立；
 * 间隔太短吸附/回流来不及跟。所以固定 10 个插值点、每点 40ms、按下后先停一下。
 */
async function dragTo(cdp, from, to, steps = 10) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
  await sleep(80)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
  })
  await sleep(60)
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(40)
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
  })
  await sleep(650)
}

const VK = { Delete: 46, Backspace: 8, Escape: 27, z: 90 }
/** 真实键盘事件（走 window 上的 keydown 监听，和用户按键同一条链路） */
async function keyPress(cdp, key, { modifiers = 0 } = {}) {
  const vk = VK[key] ?? 0
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await sleep(30)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(350)
}

/**
 * 让画布上**某个版式区里的**元素进入"元素属性"层，返回该元素。
 *
 * 为什么不能直接按 kind 挑第一个：一个模板里可能有好几张表（「通用清单」就是
 * "每页重复区一张列头表 + 循环区一张数据表"），按 kind 取第一张会挑错，
 * 后面所有关于"循环区唯一元素"的断言就全部测错了对象。
 *
 * 命中单元格时面板会先停在"单元格属性"（没有版式区信息），按一次 Esc 退回整元素层。
 */
async function selectInBand(cdp, kind, wantBand) {
  const cands = (await cdp.eval(`__bp.els()`)).filter((e) => e.kind === kind)
  for (const c of cands) {
    const pt = await cdp.eval(`__bp.pointEl(${JSON.stringify(c.id)})`)
    if (!pt) continue
    await clickAt(cdp, pt.x, pt.y, 1)
    await sleep(450)
    let band = await cdp.eval(`__bp.activeBand()`)
    if (!band) {
      await keyPress(cdp, 'Escape')
      await sleep(350)
      band = await cdp.eval(`__bp.activeBand()`)
    }
    if (band === wantBand) return c
  }
  return null
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const started = Date.now()
  if (!EDGE) {
    console.log('找不到 Edge/Chrome')
    process.exit(1)
  }
  try {
    const r = await fetch(BASE, { method: 'HEAD' })
    if (!r.ok) throw new Error(String(r.status))
  } catch (e) {
    console.log(`dev server 不可达：${e.message}`)
    process.exit(1)
  }

  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  PORT = await pickFreePort()
  console.log(`调试端口：${PORT}`)

  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1440,900',
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
        // 只认"刚起的那个空白页"：万一端口上蹲着上一轮的僵尸，它已经有别的 url 了，
        // 这里就挑不中 —— 宁可报错，也不要连上去在随机的地方超时。
        target = list.find((t) => t.type === 'page' && (t.url === 'about:blank' || t.url === ''))
        if (target?.webSocketDebuggerUrl) break
      } catch {}
      await sleep(300)
    }
    if (!target) throw new Error(`连不上浏览器调试端口 ${PORT}（或找到的都不是刚起的空白页）`)

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    })

    // ------------------------------------------------------------------
    console.log('\n[0] 打开插件 → 用「通用单据」骨架进编辑器（骨架里有一个 4 列表格）')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tab=wizard` })
    await sleep(3000)
    await cdp.eval(HELPERS)

    await cdp.eval(`__bp.click('button','下一步：选模板')`)
    await sleep(900)
    await cdp.eval(`__bp.click('button','＋ 新建模板')`)
    await sleep(800)
    await cdp.eval(`__bp.click('button','记录模板（一条记录一份）')`)
    await sleep(400)
    const picked = await cdp.eval(`(() => {
      const it = Array.from(document.querySelectorAll('.sk-item')).find(e => (e.textContent||'').includes('通用单据'))
      if (it) it.click(); return !!it
    })()`)
    ok('选到「通用单据」骨架', picked === true)
    await sleep(300)
    await cdp.eval(`__bp.click('button','创建并编辑')`)
    await waitFor(cdp, `__bp.count('.bp-el') > 0`, 8000)

    const env = await cdp.eval(`({
      els: __bp.count('[data-el-id]'),
      table: __bp.count('.bp-el-table'),
      rightPane: __bp.count('.bp-side--right'),
      panel: __bp.count('.bp-panel--inspector'),
      scale: __bp.scale(),
      layout: (document.querySelector('.bp-editor') || {}).getAttribute
        ? document.querySelector('.bp-editor').getAttribute('data-layout') : null,
    })`)
    note('编辑器环境', env)
    ok(
      '编辑器打开，画布上有多元素 + 一个表格 + 右侧属性面板可见',
      (env?.els ?? 0) > 1 && (env?.table ?? 0) > 0 && (env?.rightPane ?? 0) > 0,
      `元素 ${env?.els} 个 / 表格 ${env?.table} 个 / 右侧面板 ${env?.rightPane} 个 / 布局 ${env?.layout} / 缩放 ${env?.scale}`,
    )

    // 元素清单（后续所有用例都从这里挑靶子）
    const list = await cdp.eval(`__bp.els()`)
    note(`画布元素清单（${list?.length ?? 0} 个）`, list?.map((e) => `${e.kind}:${e.id}:${e.w}x${e.h}@${e.x},${e.y}"${e.text}"`))
    const tableEl = list?.find((e) => e.kind === 'table')
    const textEls = (list ?? []).filter((e) => e.kind === 'text')
    ok('画布上找得到表格元素与至少 2 个文本元素（后续用例的靶子）',
      !!tableEl && textEls.length >= 2,
      `表格=${tableEl?.id ?? '无'} / 文本元素 ${textEls.length} 个`)

    // 拖动靶子优先选带字的"备注"，它在中部、四周有空间
    const dragTarget = textEls.find((e) => e.text.includes('备注')) ?? textEls[0]
    note('拖动/缩放靶子', `${dragTarget?.id} "${dragTarget?.text}" ${dragTarget?.w}x${dragTarget?.h}@${dragTarget?.x},${dragTarget?.y}`)

    // ------------------------------------------------------------------
    console.log('\n[1] 属性面板上下文是否随选中对象切换（用户抱怨"点字段时右侧还是表格属性"）')
    /** 吸附网格步长（从属性面板的提示文案里读；读不到就按默认 5mm） */
    let gridMm = 5
    // 1a：什么都不选 → 页面属性
    await keyPress(cdp, 'Escape')
    await keyPress(cdp, 'Escape')
    await sleep(400)
    const pageState = await cdp.eval(`({
      paperW: !!__bp.num('纸张宽度'),
      paperH: !!__bp.num('纸张高度'),
      elW: !!__bp.num('宽度'),
      panel: __bp.panel(),
      selected: __bp.count('.bp-el.is-selected'),
    })`)
    note('未选中时的面板', pageState?.panel)
    ok('未选中 → 面板是「页面属性」（有纸张宽度/高度，没有元素级的「宽度」）',
      pageState?.paperW === true && pageState?.elW === false,
      `纸张宽度输入=${pageState?.paperW} 纸张高度输入=${pageState?.paperH} 元素宽度输入=${pageState?.elW} 选中元素数=${pageState?.selected}`)

    // 1b：选中表格 → 元素属性（点单元格会先进单元格层，再按 Esc 退回整表）
    const cellPt = await cdp.eval(`__bp.pointSel('.bp-el-table tbody tr:nth-child(1) td', 0)`)
    ok('能在画布上定位到表格第 1 行第 1 列的单元格', !!cellPt, JSON.stringify(cellPt))
    if (cellPt) {
      await clickAt(cdp, cellPt.x, cellPt.y, 1)
      await sleep(500)
      const cellState = await cdp.eval(`({
        cellTextarea: !!document.querySelector('textarea[aria-label="单元格内容"]'),
        mergeBtn: !!__bp.btn('与右侧单元格合并'),
        elW: !!__bp.num('宽度'),
        paperW: !!__bp.num('纸张宽度'),
        panel: __bp.panel(),
        selectedTds: __bp.count('td.bp-el-cell.is-selected'),
      })`)
      note('选中单元格时的面板', cellState?.panel)
      ok('选中单元格 → 面板是「单元格属性」（单元格内容输入 + 合并按钮，且没有元素级的「宽度」）',
        cellState?.cellTextarea === true && cellState?.mergeBtn === true && cellState?.elW === false,
        `单元格内容输入=${cellState?.cellTextarea} 合并按钮=${cellState?.mergeBtn} 元素宽度输入=${cellState?.elW} 纸张宽度输入=${cellState?.paperW} 高亮单元格=${cellState?.selectedTds}`)

      // 1c：Esc 退回整表 → 元素属性
      await keyPress(cdp, 'Escape')
      await sleep(400)
      const tableState = await cdp.eval(`({
        elW: !!__bp.num('宽度'),
        elH: !!__bp.num('高度'),
        paperW: !!__bp.num('纸张宽度'),
        mergeBtn: !!__bp.btn('与右侧单元格合并'),
        elbar: (document.querySelector('.bp-elbar__name') || {}).textContent || null,
        band: /所属版式区/.test(__bp.text()),
        gridMm: (() => { const m = __bp.text().match(/按网格\\s*([\\d.]+)mm\\s*步进/); return m ? Number(m[1]) : null })(),
        panel: __bp.panel(),
      })`)
      note('选中整张表格时的面板', tableState?.panel)
      ok('选中表格元素 → 面板是「元素属性」（宽度/高度 + 所属版式区，且没有合并按钮）',
        tableState?.elW === true && tableState?.elH === true && tableState?.mergeBtn === false && tableState?.band === true,
        `宽度输入=${tableState?.elW} 高度输入=${tableState?.elH} 合并按钮=${tableState?.mergeBtn} 所属版式区=${tableState?.band} 面板标题=${tableState?.elbar}`)
      if (Number.isFinite(tableState?.gridMm)) gridMm = tableState.gridMm
    }
    note('吸附网格步长', `${gridMm}mm`)

    // ------------------------------------------------------------------
    console.log('\n[2] 缩放元素（拖右下角手柄 .bp-handle--se）')
    // 先缩放、后拖动：此刻元素还在骨架给的原位上，右下角没有被邻居压住。
    // 反过来的话，被拖到签名行上的元素，那个角的 handle 会被邻居盖住 —— 那是测试自己造的坑。
    await keyPress(cdp, 'Escape') // 清掉选中，保证下面用点击重新选中
    await sleep(300)
    const aPt = await cdp.eval(`__bp.pointEl(${JSON.stringify(dragTarget.id)})`)
    ok('能定位到靶子上可命中的点', !!aPt, JSON.stringify(aPt))

    /** 吸附让落点最多偏半格：容差按实测网格步长算，不写死像素值 */
    const MM_TO_PX = 96 / 25.4
    const pxPerMm = (env?.scale ?? 1) * MM_TO_PX
    const tol = Math.ceil(0.5 * gridMm * pxPerMm) + 3

    if (aPt) {
      // 点选中（同时验证"点击能选中"）—— 缩放与拖动都建立在"选中的是它"之上
      await clickAt(cdp, aPt.x, aPt.y, 1)
      await sleep(400)
      const selectedNow = await cdp.eval(`__bp.one(${JSON.stringify(dragTarget.id)}).sel === true`)
      note('点击后该元素是否进入选中态', selectedNow)
      ok('点击画布上的元素能选中它（后续缩放/拖动都建立在"选中的是它"之上）',
        selectedNow === true,
        `点击 (${aPt.x},${aPt.y}) 后 ${dragTarget.id} 的 is-selected=${selectedNow}`)

      const handleInfo = await cdp.eval(`(() => {
        const hs = Array.from(document.querySelectorAll('.bp-el.is-selected .bp-handle'))
        const cur = __bp.one(${JSON.stringify(dragTarget.id)})
        return { selectedEl: cur ? cur.id : null, handles: hs.length,
                 dirs: hs.map(h => String(h.className).replace('bp-handle bp-handle--','')) }
      })()`)
      note('选中元素身上的手柄', handleInfo)
      ok('选中元素后有 8 个方向手柄（nw|n|ne|e|se|s|sw|w 各一个）',
        handleInfo?.handles === 8 && new Set(handleInfo.dirs).size === 8 && handleInfo?.selectedEl === dragTarget.id,
        `选中元素=${handleInfo?.selectedEl}，手柄数 ${handleInfo?.handles}，方向 [${handleInfo?.dirs?.join(',')}]`)

      const sePt = await cdp.eval(`__bp.pointHandle('se')`)
      note('右下角手柄的可点位置', sePt)
      const sizeBefore = await cdp.eval(`__bp.rect(${JSON.stringify(dragTarget.id)})`)
      if (!sePt || sePt.blocked) {
        ok('拖右下角手柄 → 元素宽高都变大', false,
          `手柄拿不到可命中的点：${JSON.stringify(sePt)}（元素 ${sizeBefore.w}x${sizeBefore.h}px）`)
      } else {
        await dragTo(cdp, sePt, { x: sePt.x + 90, y: sePt.y + 55 })
        const sizeAfter = await cdp.eval(`__bp.rect(${JSON.stringify(dragTarget.id)})`)
        ok('拖右下角手柄 → 元素宽高都变大',
          sizeAfter.w > sizeBefore.w + 20 && sizeAfter.h > sizeBefore.h + 20,
          `宽 ${sizeBefore.w} → ${sizeAfter.w}（+${sizeAfter.w - sizeBefore.w}），高 ${sizeBefore.h} → ${sizeAfter.h}（+${sizeAfter.h - sizeBefore.h}）；指针位移 (+90, +55)；手柄落点 (${sePt.x},${sePt.y})`)
        ok('缩放的位移量与指针位移一致（误差在半格吸附容差内）',
          Math.abs((sizeAfter.w - sizeBefore.w) - 90) <= tol && Math.abs((sizeAfter.h - sizeBefore.h) - 55) <= tol,
          `期望约 (+90, +55)，实测 (+${sizeAfter.w - sizeBefore.w}, +${sizeAfter.h - sizeBefore.h})，容差 ±${tol}px（网格 ${gridMm}mm × ${pxPerMm.toFixed(2)}px/mm）`)
      }
    }

    // ------------------------------------------------------------------
    console.log('\n[3] 拖动已有元素（真实指针序列）')
    // 缩放改过尺寸了，坐标必须重新取一次
    const dPt = await cdp.eval(`__bp.pointEl(${JSON.stringify(dragTarget.id)})`)
    if (dPt) {
      const before = await cdp.eval(`({ a: __bp.rect(${JSON.stringify(dragTarget.id)}), t: __bp.rect(${JSON.stringify(tableEl.id)}) })`)

      const DX = 120, DY = 70
      await dragTo(cdp, dPt, { x: dPt.x + DX, y: dPt.y + DY })
      const after = await cdp.eval(`({ a: __bp.rect(${JSON.stringify(dragTarget.id)}), t: __bp.rect(${JSON.stringify(tableEl.id)}), sel: __bp.one(${JSON.stringify(dragTarget.id)}).sel })`)

      const dx = after.a.x - before.a.x
      const dy = after.a.y - before.a.y
      ok('拖动元素：位置朝拖动方向真的变了（left 与 top 都增大）',
        dx > 20 && dy > 20,
        `left ${before.a.x} → ${after.a.x}（${dx >= 0 ? '+' : ''}${dx}），top ${before.a.y} → ${after.a.y}（${dy >= 0 ? '+' : ''}${dy}）；指针位移 (+${DX}, +${DY})；拖动后仍选中=${after.sel}`)

      ok('拖动的位移量与指针位移一致（误差在半格吸附容差内，说明不是别的东西碰巧动了）',
        Math.abs(dx - DX) <= tol && Math.abs(dy - DY) <= tol,
        `期望约 (+${DX}, +${DY})，实测 (+${dx}, +${dy})，容差 ±${tol}px（网格 ${gridMm}mm × ${pxPerMm.toFixed(2)}px/mm，半格≈${(0.5 * gridMm * pxPerMm).toFixed(1)}px）`)

      // ---- 反向对照 B：没被拖的元素不许动 ----
      const tdx = after.t.x - before.t.x
      const tdy = after.t.y - before.t.y
      ok('【反向对照 B】拖动靶子的同时，未被拖动的表格元素位置纹丝不动',
        tdx === 0 && tdy === 0 && after.t.w === before.t.w && after.t.h === before.t.h,
        `表格 left/top ${before.t.x},${before.t.y} → ${after.t.x},${after.t.y}（Δ${tdx},${tdy}），尺寸 ${before.t.w}x${before.t.h} → ${after.t.w}x${after.t.h}`)

      // ---- 反向对照 A：只悬停 / 只按下不动，位置不许变 ----
      // 必须用**拖动后**的新坐标重新找点：拿拖动前的旧点去悬停，
      // 命中的是空白处，那样"没动"是废话（所以 A2 会额外断言点击确实命中了这个元素）
      const aPt2 = await cdp.eval(`__bp.pointEl(${JSON.stringify(dragTarget.id)})`)
      const hoverBefore = await cdp.eval(`__bp.rect(${JSON.stringify(dragTarget.id)})`)
      ok('拖动后仍能定位到该元素上可命中的点（对照 A 的前提）', !!aPt2, JSON.stringify(aPt2))

      if (aPt2) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: aPt2.x, y: aPt2.y, button: 'none', buttons: 0 })
        await sleep(50)
        for (let i = 1; i <= 5; i++) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: aPt2.x + i * 6, y: aPt2.y + i * 4, button: 'none', buttons: 0 })
          await sleep(40)
        }
        await sleep(300)
        const afterHover = await cdp.eval(`__bp.rect(${JSON.stringify(dragTarget.id)})`)
        const hoverMoved = afterHover.x !== hoverBefore.x || afterHover.y !== hoverBefore.y || afterHover.w !== hoverBefore.w || afterHover.h !== hoverBefore.h
        ok('【反向对照 A】只悬停鼠标（不按下）不会移动元素',
          !hoverMoved,
          `在 (${aPt2.x},${aPt2.y}) 附近悬停前后：left ${hoverBefore.x} → ${afterHover.x}，top ${hoverBefore.y} → ${afterHover.y}，尺寸 ${hoverBefore.w}x${hoverBefore.h} → ${afterHover.w}x${afterHover.h}`)

        // 再按一下不移动（等价于单击）：这一条必须同时证明"真的点到了它"
        await clickAt(cdp, aPt2.x, aPt2.y, 1)
        await sleep(400)
        const afterPress = await cdp.eval(`({ r: __bp.rect(${JSON.stringify(dragTarget.id)}), sel: __bp.one(${JSON.stringify(dragTarget.id)}).sel })`)
        const pressMoved = afterPress.r.x !== hoverBefore.x || afterPress.r.y !== hoverBefore.y
        ok('【反向对照 A2】只按下不移动（等同单击）不会移动元素，且这次按压确实命中了该元素',
          !pressMoved && afterPress.sel === true,
          `按下-抬起前后：left ${hoverBefore.x} → ${afterPress.r.x}，top ${hoverBefore.y} → ${afterPress.r.y}；按压后该元素 is-selected=${afterPress.sel}`)
      }

      // ------------------------------------------------------------------
      console.log('\n[4] 属性面板里直接改「宽」「高」数值 → 画布像素尺寸跟着变')
      const numericBefore = await cdp.eval(`({
        wMm: __bp.numVal('宽度'), hMm: __bp.numVal('高度'),
        rect: __bp.rect(${JSON.stringify(dragTarget.id)}),
        paperW: !!__bp.num('纸张宽度'),
      })`)
      note('改之前的数值输入', `宽=${numericBefore?.wMm}mm 高=${numericBefore?.hMm}mm（画布 ${numericBefore?.rect?.w}x${numericBefore?.rect?.h}px）`)
      ok('此时面板里的是「元素」的宽高，不是纸张的宽高',
        numericBefore?.wMm !== null && numericBefore?.hMm !== null && numericBefore?.paperW === false,
        `宽输入=${numericBefore?.wMm} 高输入=${numericBefore?.hMm} 纸张宽度输入存在=${numericBefore?.paperW}`)

      const w0 = Number(numericBefore.wMm)
      const h0 = Number(numericBefore.hMm)
      const ppx = numericBefore.rect.w / Math.max(w0, 0.01)
      const newW = Math.round((w0 + 30) * 10) / 10
      const newH = Math.round((h0 + 20) * 10) / 10
      await cdp.eval(`__bp.setNum('宽度', ${newW})`)
      await sleep(400)
      await cdp.eval(`__bp.setNum('高度', ${newH})`)
      await sleep(600)
      const numericAfter = await cdp.eval(`({
        wMm: __bp.numVal('宽度'), hMm: __bp.numVal('高度'),
        rect: __bp.rect(${JSON.stringify(dragTarget.id)}),
      })`)
      const dwPx = numericAfter.rect.w - numericBefore.rect.w
      const dhPx = numericAfter.rect.h - numericBefore.rect.h
      const expDw = Math.round((newW - w0) * ppx)
      const expDh = Math.round((newH - h0) * ppx)
      ok('在属性面板里输入新的「宽」「高」→ 画布上该元素的像素宽高跟着变',
        Math.abs(dwPx - expDw) <= 3 && Math.abs(dhPx - expDh) <= 3,
        `宽 ${w0}→${newW}mm（画布 ${numericBefore.rect.w}→${numericAfter.rect.w}px，实测 Δ${dwPx}，按 ${ppx.toFixed(2)}px/mm 应为 Δ${expDw}）；高 ${h0}→${newH}mm（画布 ${numericBefore.rect.h}→${numericAfter.rect.h}px，实测 Δ${dhPx}，应为 Δ${expDh}）`)
      note('输入框回显', `宽=${numericAfter.wMm} 高=${numericAfter.hMm}`)

      // ------------------------------------------------------------------
      console.log('\n[5] 撤销（Ctrl+Z）：改完属性后回到改之前')
      // 宽、高是两次独立提交（mergeKey 不同 → 两步撤销）。所以按两次，
      // 并且分别断言每一步回退的是哪一项 —— 一次 Ctrl+Z 就全回去反而说明撤销粒度坏了。
      await cdp.eval(`__bp.blurAll()`)
      await sleep(200)
      const undoBefore = await cdp.eval(`({ rect: __bp.rect(${JSON.stringify(dragTarget.id)}), canUndo: !document.querySelector('[aria-label="撤销"]').disabled })`)
      await keyPress(cdp, 'z', { modifiers: 2 }) // 2 = Ctrl
      await sleep(500)
      const undo1 = await cdp.eval(`({ rect: __bp.rect(${JSON.stringify(dragTarget.id)}), wMm: __bp.numVal('宽度'), hMm: __bp.numVal('高度') })`)
      ok('Ctrl+Z 第 1 下：后改的「高」回到改之前（先改的「宽」不动，因为那是另一步）',
        Math.abs(undo1.rect.h - numericBefore.rect.h) <= 2 && Math.abs(undo1.rect.w - numericAfter.rect.w) <= 2,
        `高 ${numericAfter.rect.h} → ${undo1.rect.h}px（目标${numericBefore.rect.h}px，输入框 高=${undo1.hMm}mm 应回到 ${h0}）；同时 宽 ${numericAfter.rect.w} → ${undo1.rect.w}px 未回退（应仍为 ${numericAfter.rect.w}px，输入框 宽=${undo1.wMm}mm）；撤销按钮可用=${undoBefore.canUndo}`)

      await keyPress(cdp, 'z', { modifiers: 2 })
      await sleep(500)
      const undo2 = await cdp.eval(`({ rect: __bp.rect(${JSON.stringify(dragTarget.id)}), wMm: __bp.numVal('宽度'), hMm: __bp.numVal('高度') })`)
      ok('Ctrl+Z 第 2 下：「宽」也回到改之前（面板数值与画布像素同时回退）',
        Math.abs(undo2.rect.w - numericBefore.rect.w) <= 2 && Math.abs(undo2.rect.h - numericBefore.rect.h) <= 2,
        `画布 ${undo2.rect.w}x${undo2.rect.h}px（改之前 ${numericBefore.rect.w}x${numericBefore.rect.h}px）；输入框 宽=${undo2.wMm}mm（应 ${w0}） 高=${undo2.hMm}mm（应 ${h0}）`)
    }

    // ------------------------------------------------------------------
    console.log('\n[5b] 合并会丢弃非空单元格 → 必须先问一句（新增；原缺陷是"点一下就永久丢字段绑定"）')
    // 为什么盯这一格：右合并把右侧单元格整个丢掉（连同它的字段占位符），
    // 而拆分补回来的是**空**单元格 —— 用户手工配的字段绑定就没了，且当时没有任何提示。
    // 这里用"第 2 行"而不是第 1 行：第 1 行留给紧接着的 [6]/[7] 用，别互相干扰。
    const wCellPt = await cdp.eval(`__bp.pointSel('.bp-el-table tbody tr:nth-child(2) td', 0)`)
    const wRowBefore = await cdp.eval(`__bp.row(1)`)
    note('合并非空单元格前（第 2 行）', wRowBefore)
    if (wCellPt) {
      await clickAt(cdp, wCellPt.x, wCellPt.y, 1)
      await sleep(500)
      await cdp.eval(`__bp.clickBtn('与右侧单元格合并')`)
      await sleep(600)
      const wDlg = await cdp.eval(`__bp.mergeConfirm()`)
      note('确认层', wDlg)
      ok(
        '合并会丢弃非空单元格时先弹确认层（不是点一下就永久丢）',
        wDlg?.present === true && wDlg?.visible === true,
        JSON.stringify(wDlg),
      )
      const wLost = wRowBefore?.cells?.[1] ?? ''
      ok(
        '确认文案点名了将被丢弃的那格内容（用户能判断自己丢的是什么）',
        typeof wDlg?.text === 'string' && wDlg.text.includes('丢弃') && wLost !== '' && wDlg.text.includes(wLost),
        `确认文案「${wDlg?.text}」，将被丢弃的单元格内容「${wLost}」`,
      )
      ok(
        '确认层是阻塞式的：层级高于 toast / 编辑器弹出层（不会再被宿主盖住）',
        typeof wDlg?.backdropZ === 'number' && typeof wDlg?.toastZ === 'number' && wDlg.backdropZ > wDlg.toastZ,
        `backdrop z-index=${wDlg?.backdropZ}，--z-toast=${wDlg?.toastZ}`,
      )

      // ---- 取消：结构与内容都必须一点不动 ----
      const cancelClicked = await cdp.eval(`(() => { const b = __bp.confirmBtn('取消合并'); if (!b) return false; b.click(); return true })()`)
      await sleep(600)
      const wAfterCancel = await cdp.eval(`({ row: __bp.row(1), table: __bp.table(), dlg: __bp.mergeConfirm() })`)
      ok(
        '在确认层点「取消」→ 合并没有发生，该行内容与结构完全不变',
        cancelClicked === true &&
          wAfterCancel?.row?.tdCount === wRowBefore?.tdCount &&
          JSON.stringify(wAfterCancel?.row?.cells) === JSON.stringify(wRowBefore?.cells) &&
          JSON.stringify(wAfterCancel?.row?.colspans) === JSON.stringify(wRowBefore?.colspans) &&
          wAfterCancel?.dlg?.present === false,
        `td 数 ${wRowBefore?.tdCount} → ${wAfterCancel?.row?.tdCount}，内容 [${wRowBefore?.cells?.join('|')}] → [${wAfterCancel?.row?.cells?.join('|')}]，colspan [${wRowBefore?.colspans?.join(',')}] → [${wAfterCancel?.row?.colspans?.join(',')}]，确认层已消失=${wAfterCancel?.dlg?.present === false}`,
      )

      // ---- 确认：合并要真的发生 ----
      await cdp.eval(`__bp.clickBtn('与右侧单元格合并')`)
      await sleep(500)
      const confirmClicked = await cdp.eval(`(() => { const b = __bp.confirmBtn('确认合并'); if (!b) return false; b.click(); return true })()`)
      await sleep(700)
      const wAfterYes = await cdp.eval(`({ row: __bp.row(1), dlg: __bp.mergeConfirm() })`)
      ok(
        '在确认层点「仍然合并」→ 合并真的生效（td 数 -1 且出现 colspan）',
        confirmClicked === true &&
          wAfterYes?.row?.tdCount === wRowBefore?.tdCount - 1 &&
          (wAfterYes?.row?.colspans?.[0] ?? 1) >= 2 &&
          wAfterYes?.dlg?.present === false,
        `td 数 ${wRowBefore?.tdCount} → ${wAfterYes?.row?.tdCount}，colspan [${wRowBefore?.colspans?.join(',')}] → [${wAfterYes?.row?.colspans?.join(',')}]`,
      )

      // 拆回 4 格（拆出来的是**空**单元格），顺手造出下一步要用的"空单元格"
      await cdp.eval(`__bp.clickBtn('拆分单元格')`)
      await sleep(700)
      const wRowSplit = await cdp.eval(`__bp.row(1)`)
      note('拆分回 4 格后（被并掉那格现在是空的）', wRowSplit)

      // ---- 空单元格：不该有摩擦 ----
      const eCellPt = await cdp.eval(`__bp.pointSel('.bp-el-table tbody tr:nth-child(2) td', 0)`)
      const eRowBefore = await cdp.eval(`__bp.row(1)`)
      ok('空单元格合并用例的前提：第 2 行第 2 格此刻是空的', eRowBefore?.cells?.[1] === '', JSON.stringify(eRowBefore?.cells))
      if (eCellPt) {
        await clickAt(cdp, eCellPt.x, eCellPt.y, 1)
        await sleep(500)
        await cdp.eval(`__bp.clickBtn('与右侧单元格合并')`)
        await sleep(700)
        const eDlg = await cdp.eval(`__bp.mergeConfirm()`)
        const eRowAfter = await cdp.eval(`__bp.row(1)`)
        ok(
          '合并一个空单元格 → 不弹确认，直接合并（不给无谓的摩擦）',
          eDlg?.present === false && eRowAfter?.tdCount === eRowBefore?.tdCount - 1,
          `确认层存在=${eDlg?.present}，td 数 ${eRowBefore?.tdCount} → ${eRowAfter?.tdCount}`,
        )
        await cdp.eval(`__bp.clickBtn('拆分单元格')`)
        await sleep(700)
      } else {
        ok('合并一个空单元格 → 不弹确认，直接合并（不给无谓的摩擦）', false, '找不到可点的空单元格')
      }
    } else {
      ok('合并会丢弃非空单元格时先弹确认层（不是点一下就永久丢）', false, '第 2 行第 1 格找不到可点位置')
    }

    // ------------------------------------------------------------------
    console.log('\n[6] 合并单元格（右侧属性面板 → 合并与拆分 → 右合并）')
    const cellPt2 = await cdp.eval(`__bp.pointSel('.bp-el-table tbody tr:nth-child(1) td', 0)`)
    const rowBefore = await cdp.eval(`__bp.row(0)`)
    const tblBefore = await cdp.eval(`__bp.table()`)
    note('合并前的第 1 行', rowBefore)
    let mergeOk = false
    if (cellPt2) {
      await clickAt(cdp, cellPt2.x, cellPt2.y, 1)
      await sleep(500)
      const btnBefore = await cdp.eval(`({ merge: __bp.btnState('与右侧单元格合并'), split: __bp.btnState('拆分单元格'), p: __bp.panel() })`)
      note('选中单元格后面板上的按钮', btnBefore)
      ok('选中单元格后右侧面板出现「合并与拆分」分组与三个按钮',
        btnBefore?.merge?.found === true && btnBefore?.split?.found === true,
        `右合并按钮=${JSON.stringify(btnBefore?.merge)} 拆分按钮=${JSON.stringify(btnBefore?.split)}`)

      const clickRes = await cdp.eval(`__bp.clickBtn('与右侧单元格合并')`)
      await sleep(500)
      // 第 1 行这一格右边是**非空**的字段占位符 → 修复后这里会先弹确认层。
      // 既有的 28 项断言一条都没改，只是把"确认"这一步点掉，让合并继续跑完
      // （确认层本身由 [5b] 的专门断言负责）。
      const ackDlg = await cdp.eval(`(() => { const b = __bp.confirmBtn('确认合并'); if (!b) return null; b.click(); return true })()`)
      if (ackDlg === true) note('第 1 行右合并触发了确认层（非空单元格），已点「仍然合并」')
      else note('第 1 行右合并没有触发确认层', JSON.stringify(await cdp.eval(`__bp.row(0)`)))
      await sleep(600)
      if (!clickRes?.ok) note('点击右合并失败', clickRes)
      const rowAfter = await cdp.eval(`__bp.row(0)`)
      const tblAfter = await cdp.eval(`__bp.table()`)
      mergeOk = rowAfter?.tdCount === rowBefore?.tdCount - 1 && (rowAfter?.colspans?.[0] ?? 1) >= 2
      ok('点「右合并」→ 该行 td 数 -1 且出现 colspan',
        mergeOk,
        `第 1 行 td 数 ${rowBefore?.tdCount} → ${rowAfter?.tdCount}，colspan 由 [${rowBefore?.colspans?.join(',')}] 变为 [${rowAfter?.colspans?.join(',')}]；全表 td 数 ${tblBefore?.tds} → ${tblAfter?.tds}，跨行/跨列的格子数 ${tblBefore?.merged} → ${tblAfter?.merged}`)
      note('合并后第 1 行内容', rowAfter?.cells)

      // ------------------------------------------------------------------
      console.log('\n[7] 拆分单元格（回到合并前）')
      const splitBefore = await cdp.eval(`({ split: __bp.btnState('拆分单元格'), row: __bp.row(0) })`)
      note('拆分前拆分按钮', splitBefore?.split)
      if (splitBefore?.split?.disabled) {
        ok('合并后「拆分」按钮变为可用', false, `按钮仍禁用：${JSON.stringify(splitBefore.split)}`)
      } else {
        ok('合并后「拆分」按钮变为可用', true, `disabled=false；当前第 1 行 td 数 ${splitBefore.row.tdCount}`)
      }
      const splitRes = await cdp.eval(`__bp.clickBtn('拆分单元格')`)
      await sleep(700)
      if (!splitRes?.ok) note('点击拆分失败', splitRes)
      const rowSplit = await cdp.eval(`__bp.row(0)`)
      const tblSplit = await cdp.eval(`__bp.table()`)
      ok('点「拆分」→ 恢复原状（td 数回到合并前，不再有 colspan）',
        rowSplit?.tdCount === rowBefore?.tdCount && rowSplit?.colspans.every((c) => c === 1),
        `第 1 行 td 数 ${rowAfter?.tdCount} → ${rowSplit?.tdCount}（合并前 ${rowBefore?.tdCount}），colspan [${rowSplit?.colspans?.join(',')}]；全表 td 数 ${tblAfter?.tds} → ${tblSplit?.tds}，跨行/跨列的格子数 ${tblSplit?.merged}`)
    } else {
      ok('选中单元格后右侧面板出现「合并与拆分」分组与三个按钮', false, '找不到可点的单元格')
    }

    // ------------------------------------------------------------------
    console.log('\n[7b] 重叠元素：被邻居盖住的缩放手柄必须仍然可拖（新增；原缺陷是"拖那个角完全没反应"）')
    // 为什么必须单独测：手柄没有层级时，层叠完全由 DOM 顺序（= 元素在版式区里的顺序）决定。
    // 把「备注」拖到后画的签字行上重叠，签字行就盖住「备注」的右下角手柄，
    // 拖上去毫无反应 —— 用户的感受是"拖动不可用"，但拖动逻辑本身一点没坏。
    await keyPress(cdp, 'Escape')
    await sleep(400)
    const ovList = await cdp.eval(`__bp.els()`)
    const ovA = (ovList ?? []).find((e) => e.kind === 'text' && e.text.includes('备注'))
    const ovIdx = ovA ? ovList.findIndex((e) => e.id === ovA.id) : -1
    // DOM 顺序 = 绘制顺序（谁都没有 z-index 时）。取「备注」**之后**画的文本元素当"盖住它的那个"。
    const ovB = ovIdx >= 0 ? (ovList.slice(ovIdx + 1).filter((e) => e.kind === 'text').pop() ?? null) : null
    ok(
      '找得到「备注」以及它之后绘制的签字行（重叠实验的前提）',
      Boolean(ovA) && Boolean(ovB),
      ovA && ovB
        ? `${ovA.id}"${ovA.text}"(${ovA.x},${ovA.y} ${ovA.w}x${ovA.h})；后画的 ${ovB.id}"${ovB.text}"(${ovB.x},${ovB.y} ${ovB.w}x${ovB.h})`
        : JSON.stringify({ a: ovA?.id ?? null, b: ovB?.id ?? null }),
    )
    if (ovA && ovB) {
      // 先把两个元素的造型调成"能叠起来"的样子，否则重叠造不出来（第一次跑就是这么失败的）：
      //   · 把"盖住它的那个"垫高到 20mm —— 被盖那个点的纵向余量就远大于吸附误差，
      //     "手柄有没有被盖住"只取决于层级，不取决于拖动落点的小数点；
      //   · 把"被盖的那个"收窄到 60mm —— 两个元素都占满版心宽度时，谁都没法把角落
      //    挪进对方盒子里（横向会被版心边界夹住）。
      const bPt = await cdp.eval(`__bp.pointEl(${JSON.stringify(ovB.id)})`)
      if (bPt) {
        await clickAt(cdp, bPt.x, bPt.y, 1)
        await sleep(400)
        await cdp.eval(`__bp.setNum('高度', 20)`)
        await sleep(500)
      }
      const aPt0 = await cdp.eval(`__bp.pointEl(${JSON.stringify(ovA.id)})`)
      if (aPt0) {
        await clickAt(cdp, aPt0.x, aPt0.y, 1)
        await sleep(400)
        await cdp.eval(`__bp.setNum('宽度', 60)`)
        await sleep(600)
      }
      const ra = await cdp.eval(`__bp.rect(${JSON.stringify(ovA.id)})`)
      const rb = await cdp.eval(`__bp.rect(${JSON.stringify(ovB.id)})`)
      // 把 A 的右下角正好落在 B 的中心
      const dx = Math.round(rb.x + rb.w / 2) - (ra.x + ra.w)
      const dy = Math.round(rb.y + rb.h / 2) - (ra.y + ra.h)
      const ovPt = await cdp.eval(`__bp.pointEl(${JSON.stringify(ovA.id)})`)
      ok('能定位到「备注」上可命中的拖动点', Boolean(ovPt), JSON.stringify(ovPt))
      if (ovPt) {
        await dragTo(cdp, ovPt, { x: ovPt.x + dx, y: ovPt.y + dy })
        const ra2 = await cdp.eval(`__bp.rect(${JSON.stringify(ovA.id)})`)
        const rb2 = await cdp.eval(`__bp.rect(${JSON.stringify(ovB.id)})`)
        const ow = Math.max(0, Math.min(ra2.x + ra2.w, rb2.x + rb2.w) - Math.max(ra2.x, rb2.x))
        const oh = Math.max(0, Math.min(ra2.y + ra2.h, rb2.y + rb2.h) - Math.max(ra2.y, rb2.y))
        note(
          '拖完之后的相对位置',
          `A ${ra2.x},${ra2.y} ${ra2.w}x${ra2.h}；B ${rb2.x},${rb2.y} ${rb2.w}x${rb2.h}；重叠 ${ow}x${oh}px（目标位移 ${dx},${dy}）`,
        )
        ok('重叠确实造出来了（两者盒子相交）', ow > 8 && oh > 8, `重叠 ${ow}x${oh}px`)

        const hit = await cdp.eval(`(() => {
          const sel = document.querySelector('.bp-el.is-selected')
          const h = document.querySelector('.bp-el.is-selected .bp-handle--se')
          if (!h) return { handle: false }
          const r = h.getBoundingClientRect()
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
          const top = document.elementFromPoint(cx, cy)
          const owner = top && top.closest ? top.closest('[data-el-id]') : null
          return {
            handle: true,
            selected: sel ? sel.getAttribute('data-el-id') : null,
            self: top === h,
            by: owner ? owner.getAttribute('data-el-id') : (top ? String(top.className) : null),
            at: { x: cx, y: cy },
          }
        })()`)
        note('重叠后右下角手柄的命中情况', hit)
        ok(
          '重叠后「备注」仍是选中的那个元素（下一步拖手柄的前提）',
          hit?.selected === ovA.id,
          `选中的是 ${hit?.selected}，期望 ${ovA.id}`,
        )
        ok(
          '被邻居压住的右下角手柄仍然归它自己（不会被邻居抢走指针）',
          hit?.self === true,
          `elementFromPoint 在 (${hit?.at?.x},${hit?.at?.y}) 命中它自己=${hit?.self}，实际命中的是 ${hit?.by}`,
        )
        if (hit?.self) {
          const sp = await cdp.eval(`__bp.pointHandle('se')`)
          const szB = await cdp.eval(`__bp.rect(${JSON.stringify(ovA.id)})`)
          await dragTo(cdp, sp, { x: sp.x + 60, y: sp.y + 40 })
          const szA = await cdp.eval(`__bp.rect(${JSON.stringify(ovA.id)})`)
          ok(
            '拖"被邻居压过的那条边"上的角手柄 → 元素宽高真的变化',
            szA.w > szB.w + 15 && szA.h > szB.h + 15,
            `宽 ${szB.w} → ${szA.w}（+${szA.w - szB.w}），高 ${szB.h} → ${szA.h}（+${szA.h - szB.h}），指针位移 (+60, +40)`,
          )
        } else {
          ok('拖"被邻居压过的那条边"上的角手柄 → 元素宽高真的变化', false, `手柄被 ${hit?.by} 挡住，拿不到可命中的点`)
        }
      }
    }

    // ------------------------------------------------------------------
    console.log('\n[8] 删除元素（两条路径：Delete 键 / 面板删除按钮）')
    const live = await cdp.eval(`__bp.els()`)
    const usedIds = new Set([dragTarget?.id, tableEl?.id].filter(Boolean))
    const others = (live ?? []).filter((e) => !usedIds.has(e.id)).sort((a, b) => b.w * b.h - a.w * a.h)
    note('可删除的候选元素', others.map((e) => `${e.id}(${e.kind} "${e.text}")`))

    // --- 路径 A：Delete 键 ---
    const delA = others[0]
    if (!delA) {
      ok('路径 A：Delete 键删除元素', false, '没有多余的候选元素')
    } else {
      const pA = await cdp.eval(`__bp.pointEl(${JSON.stringify(delA.id)})`)
      if (!pA) {
        ok('路径 A：Delete 键删除元素', false, `元素 ${delA.id} 找不到可命中的点`)
      } else {
        await clickAt(cdp, pA.x, pA.y, 1)
        await sleep(400)
        const selA = await cdp.eval(`({ sel: __bp.one(${JSON.stringify(delA.id)})?.sel === true, hasDelBtn: !!__bp.btn('删除该元素'), n: __bp.count('[data-el-id]') })`)
        note('点击后', `选中=${selA.sel} 面板删除按钮=${selA.hasDelBtn} 元素数=${selA.n}`)
        await cdp.eval(`__bp.blurAll()`)
        await keyPress(cdp, 'Delete')
        await sleep(500)
        const afterDelKey = await cdp.eval(`({ n: __bp.count('[data-el-id]'), gone: __bp.one(${JSON.stringify(delA.id)}) === null })`)
        ok('路径 A：选中元素后按 Delete 键 → 元素数 -1 且该元素从 DOM 消失',
          afterDelKey.n === selA.n - 1 && afterDelKey.gone === true,
          `元素数 ${selA.n} → ${afterDelKey.n}，被删元素 ${delA.id} 是否已消失=${afterDelKey.gone}（选中态=${selA.sel}）`)
      }
    }

    // --- 路径 B：面板上的删除按钮 ---
    const delB = others.find((e) => e.id !== delA?.id)
    if (!delB) {
      ok('路径 B：面板删除按钮删除元素', false, '没有第二个候选元素')
    } else {
      const pB = await cdp.eval(`__bp.pointEl(${JSON.stringify(delB.id)})`)
      if (!pB) {
        ok('路径 B：面板删除按钮删除元素', false, `元素 ${delB.id} 找不到可命中的点`)
      } else {
        await clickAt(cdp, pB.x, pB.y, 1)
        await sleep(400)
        const selB = await cdp.eval(`({ sel: __bp.one(${JSON.stringify(delB.id)})?.sel === true, n: __bp.count('[data-el-id]'), btn: __bp.btnState('删除该元素') })`)
        const clickB = await cdp.eval(`__bp.clickBtn('删除该元素')`)
        await sleep(500)
        const afterDelBtn = await cdp.eval(`({ n: __bp.count('[data-el-id]'), gone: __bp.one(${JSON.stringify(delB.id)}) === null })`)
        ok('路径 B：选中元素后点面板上的「删除该元素」按钮 → 元素数 -1 且该元素从 DOM 消失',
          selB.btn?.found === true && clickB?.ok === true && afterDelBtn.n === selB.n - 1 && afterDelBtn.gone === true,
          `元素数 ${selB.n} → ${afterDelBtn.n}，被删元素 ${delB.id} 是否已消失=${afterDelBtn.gone}（点击前选中=${selB.sel}，按钮=${JSON.stringify(selB.btn)}，点击结果=${JSON.stringify(clickB)}）`)
      }
    }

    // ------------------------------------------------------------------
    console.log('\n[9] 观察到的其他现象（不参与 PASS/FAIL，仅供参考）')
    const tail = await cdp.eval(`({
      els: __bp.els(),
      oobIds: __bp.els().filter(e => e.oob).map(e => e.id + '(' + e.kind + ')'),
      countText: (__bp.text().match(/\\d+\\s*个元素/) || [null])[0],
      canUndo: !document.querySelector('[aria-label="撤销"]').disabled,
      canRedo: !document.querySelector('[aria-label="重做"]').disabled,
      table: __bp.row(0),
    })`)
    note('收尾时元素数 / 顶栏计数 / 撤销可用', `${tail?.els?.length} / ${tail?.countText} / undo=${tail?.canUndo} redo=${tail?.canRedo}`)
    note('超界元素（is-oob）', tail?.oobIds)
    note('收尾时第 1 行', tail?.table)
    note(
      '本用例对文档做的改动（供理解上一条）',
      '拖动并放大了「备注」元素、又把它加宽到 190mm —— 它会超出 170mm 版心，所以收尾时有 1 个 is-oob。这是测试自己造成的，不是初始模板的状态。',
    )

    // ------------------------------------------------------------------
    console.log('\n[10] 三个 UI 缺口（新增）：连续打印 / 「每 N 条」与连续大表冲突 / 循环区标签说明')
    {
      // ============================================================
      // 反向对照①：记录模板（通用单据）的循环区里有十几个元素。
      // 这种模板**开不了**「连续打印」（它与其它循环元素的相对位置无法定义）。
      // 要求是"就地写清原因"，而不是把开关藏起来或静默禁用 —— 静默禁用用户只会以为坏了。
      // ============================================================
      // ⚠️ 直接按 kind 点表格会先落到"单元格层"，面板是「单元格属性」——那一层根本没有这个开关。
      // 必须点进去再按 Esc 退回整元素层（selectInBand 里做了这件事），而且要认准"循环区"那张表。
      const recTable = await selectInBand(cdp, 'table', '循环区')
      if (!recTable) {
        ok('能在画布上选中循环区里的表格元素（下面四条断言的前提）', false, '没有任何表格落在循环区')
      } else {
        note('选中的是循环区里的表格', recTable.id)
        const stRec = await cdp.eval(`__bp.switchState('连续打印')`)
        note('记录模板里「连续打印」开关的状态', stRec)
        ok('记录模板（循环区有多个元素）→ 开关**仍在面板上**，只是禁用（不静默隐藏、不点了没反应）',
          stRec?.found === true && stRec?.role === 'switch' && stRec?.disabled === true,
          JSON.stringify(stRec))
        const why = await cdp.eval(`(() => {
          const p = document.querySelector('.bp-panel--inspector')
          if (!p) return null
          const hit = Array.from(p.querySelectorAll('.bp-hint')).map(e => (e.textContent || '').trim()).filter(t => t.includes('开关不生效'))
          return hit[0] || null
        })()`)
        note('不生效时就地给出的原因', why)
        ok('不生效时**就地写明原因**（含"循环区里还有其它元素…无法确定与它们的相对位置"），不是只塞进 tooltip',
          typeof why === 'string' && why.includes('循环区里还有其它元素') && why.includes('无法确定与它们的相对位置'),
          `面板文案「${why}」`)
        const hintRec = await cdp.eval(`__bp.bandHint('loop')`)
        ok('【反向对照】这张表没开"连续大表" → 循环区标签说明里不出现"导出"二字',
          typeof hintRec === 'string' && hintRec.length > 0 && !hintRec.includes('导出'),
          `循环区标签说明「${hintRec}」`)

        // ============================================================
        // 正向：视图模板「通用清单」—— 循环区里恰好只有一张声明了 rowsFromRecords 的表。
        // 顺带把"编辑器 → 完成 → 落库 → 向导读到新 doc"这条链路走通。
        // ============================================================
        await cdp.eval(`__bp.click('button','完成')`)
        await sleep(1400)
        const backAtWizard = await cdp.eval(`__bp.byExact('button','＋ 新建模板').length > 0`)
        ok('编辑器点「完成」→ 回到向导（改动在这一步落库，后面第③步读的就是它）',
          backAtWizard === true, `向导可见=${backAtWizard}`)

        await cdp.eval(`__bp.click('button','＋ 新建模板')`)
        await sleep(800)
        await cdp.eval(`__bp.click('button','视图模板（多条记录一份）')`)
        await sleep(500)
        const pickedList = await cdp.eval(`(() => {
          const it = Array.from(document.querySelectorAll('.sk-item')).find(e => (e.textContent||'').includes('通用清单'))
          if (it) it.click(); return !!it
        })()`)
        await sleep(300)
        await cdp.eval(`__bp.click('button','创建并编辑')`)
        await waitFor(cdp, `__bp.count('.bp-el') > 0`, 9000)
        await cdp.eval(HELPERS) // 编辑器把 DOM 换了一茬，幂等重注入一遍省得踩到旧引用
        const list2 = await cdp.eval(`__bp.els()`)
        note('「通用清单」骨架', { picked: pickedList, elements: (list2 ?? []).map((e) => `${e.kind}:${e.id}`) })
        // ⚠️ 这个骨架有**两张表**：每页重复区的"列头表" + 循环区的"数据表"。
        // 按 kind 取第一张会挑到列头表 —— 第一轮就是在这儿测错对象的（断言全挂在"这张表不在循环区里"）。
        const viewTable = await selectInBand(cdp, 'table', '循环区')
        ok('选到「通用清单」骨架，并认准了循环区里那张表（该骨架有两张表，按 kind 取第一张会挑错）',
          pickedList === true && !!viewTable,
          `骨架选中=${pickedList} 表格=${viewTable?.id ?? '无'} 候选=${(list2 ?? []).filter((e) => e.kind === 'table').map((e) => e.id).join('|')}`)

        if (!viewTable) {
          ok('能选中「通用清单」循环区里那张表格', false, '没有任何表格落在循环区')
        } else {
          const stView = await cdp.eval(`__bp.switchState('连续打印')`)
          note('视图模板里该开关的状态', stView)
          ok('循环区只有这一张表 → 开关**可用**，且默认打开（读的是骨架落进 doc 的 true）',
            stView?.found === true && stView?.disabled === false && stView?.checked === true,
            JSON.stringify(stView))
          const hintOn = await cdp.eval(`__bp.bandHint('loop')`)
          note('开启后循环区标签的说明', hintOn)
          ok('开启后，循环区标签说明改成"画布按模板原样显示，导出时按记录逐行铺开"（说清画布 ≠ 导出）',
            typeof hintOn === 'string' && hintOn.includes('导出') && hintOn.includes('逐行铺开'),
            `循环区标签说明「${hintOn}」`)

          // 关掉开关 → 说明立刻退回旧文案。这一步同时证明"这个开关真的在改文档"，不是摆着好看的。
          const offRes = await cdp.eval(`__bp.clickSwitch('连续打印')`)
          await sleep(500)
          const stOff = await cdp.eval(`__bp.switchState('连续打印')`)
          const hintOff = await cdp.eval(`__bp.bandHint('loop')`)
          note('关掉开关后', { click: offRes, state: stOff, hint: hintOff })
          ok('关掉开关 → 开关状态跟着变，循环区标签说明立刻退回"按数据行重复"（说明开关真的写进了 doc）',
            offRes?.ok === true && stOff?.checked === false && typeof hintOff === 'string' && !hintOff.includes('导出'),
            `点击=${JSON.stringify(offRes)} 状态=${JSON.stringify(stOff)} 说明「${hintOff}」`)

          // 先验**反向对照**：此刻 doc 里没有这张连续大表 → 第③步的「每 N 条」应当照常可用
          await cdp.eval(`__bp.click('button','完成')`)
          await sleep(1400)
          await cdp.eval(`__bp.click('button','下一步：预览')`)
          await sleep(2600)
          const segsOff = await cdp.eval(`__bp.perPageSegs()`)
          const noteOff = await cdp.eval(`__bp.prevHead()`)
          note('关掉开关后的第③步 seg', segsOff)
          note('关掉开关后的第③步说明', noteOff)
          ok('【反向对照】doc 里没有这张连续大表 → 四个「每 N 条」全都**可用**，且不出现"不再按条数分页"',
            Array.isArray(segsOff) && segsOff.length === 4 && segsOff.every((s) => s.disabled === false)
              && typeof noteOff === 'string' && !noteOff.includes('不再按条数分页'),
            `seg=${JSON.stringify(segsOff)} / 说明「${noteOff}」`)

          // 再走真实入口（模板卡片 → 更多操作 → 在侧边栏编辑）把它打开
          await cdp.eval(`__bp.click('button','上一步')`)
          await sleep(900)
          const menuOpen = await cdp.eval(`__bp.cardMenu('通用清单', null)`)
          await sleep(400)
          const menuPick = await cdp.eval(`__bp.cardMenu('通用清单', '在侧边栏编辑')`)
          await sleep(1000)
          note('回到编辑器的入口', { menuOpen, menuPick })
          await waitFor(cdp, `__bp.count('.bp-el') > 0`, 9000)
          await cdp.eval(HELPERS)
          const backTable = await selectInBand(cdp, 'table', '循环区')
          const stBack = await cdp.eval(`__bp.switchState('连续打印')`)
          if (!backTable) {
            ok('从模板卡片重新进入编辑器并选中循环区那张表', false, `入口=${JSON.stringify(menuPick)}`)
          } else {
            ok('落库往返（关）：重新进入编辑器，开关读到的是上次落库的"关"（关掉的改动真的存进了 doc）',
              menuPick?.ok === true && stBack?.disabled === false && stBack?.checked === false,
              `入口=${JSON.stringify(menuPick)} 表格=${backTable.id} 状态=${JSON.stringify(stBack)}`)
            const onRes = await cdp.eval(`__bp.clickSwitch('连续打印')`)
            await sleep(500)
            const stOn = await cdp.eval(`__bp.switchState('连续打印')`)
            ok('再点一次把它打开 → 开关变成"开"',
              onRes?.ok === true && stOn?.checked === true,
              `点击=${JSON.stringify(onRes)} 状态=${JSON.stringify(stOn)}`)

            await cdp.eval(`__bp.click('button','完成')`)
            await sleep(1400)
            await cdp.eval(`__bp.click('button','下一步：预览')`)
            await sleep(2600)
            const segsOn = await cdp.eval(`__bp.perPageSegs()`)
            const noteOn = await cdp.eval(`__bp.prevHead()`)
            note('打开开关后的第③步 seg', segsOn)
            note('打开开关后的第③步说明', noteOn)
            ok('doc 里是这张连续大表 → 四个「每 N 条」**全部禁用**，但控件仍在原地（保留可见，不是被藏起来）',
              Array.isArray(segsOn) && segsOn.length === 4 && segsOn.every((s) => s.disabled === true),
              `seg=${JSON.stringify(segsOn)}`)
            ok('冲突时就地说明原因：「本模板的循环区是一张连续大表，按页高连续排布，不再按条数分页」',
              typeof noteOn === 'string' && noteOn.includes('连续大表') && noteOn.includes('不再按条数分页'),
              `说明「${noteOn}」`)
          }
        }
      }
    }

    // ------------------------------------------------------------------
    console.log('\n[11] 版式区偏移（新增）：循环区元素不能被画在页级重复区里')
    {
      // 背景：循环区元素的 `el.y` 是从**版心顶部**算的绝对值，渲染层还要再叠加一个
      // 循环区起点（render/pipeline.ts:337-339 的 headerReserve / loopOffset），
      // 分页时还会被 `max(y, 游标)` 兜一次底（render/layout.ts:343-345、:357、:360）。
      // 画布一度只加了页边距、没加这个偏移，于是「通用清单」的列头表（页级重复区）
      // 与数据表（循环区）在画布上完全叠在一起：循环区那张表既看不见，
      // 也只能靠撒点采样才点得到 —— 刚做的「连续打印」开关几乎不可达。
      //
      // 此刻向导停在第③步、手上是「通用清单」且开关是开的（上一节留下的状态）。
      // 从模板卡片重新进编辑器，走的是和用户一样的入口。
      await cdp.eval(`__bp.click('button','上一步')`)
      await sleep(900)
      await cdp.eval(`__bp.cardMenu('通用清单', null)`)
      await sleep(400)
      const m11 = await cdp.eval(`__bp.cardMenu('通用清单', '在侧边栏编辑')`)
      await sleep(1000)
      await waitFor(cdp, `__bp.count('.bp-el') > 0`, 9000)
      await cdp.eval(HELPERS)
      ok('（本节前提）从模板卡片「在侧边栏编辑」重新进入编辑器', m11?.ok === true, `入口=${JSON.stringify(m11)}`)

      // 认准"循环区那张表"靠的是**产品自己的读数**（属性面板里的「所属版式区」），
      // 不按 kind 取第一张、也不靠元素数组下标 —— 这个骨架有两张表，那两种挑法都会挑错。
      const loopTbl = await selectInBand(cdp, 'table', '循环区')
      const tblIds = (await cdp.eval(`__bp.els()`)).filter((e) => e.kind === 'table').map((e) => e.id)
      const headTbl = tblIds.find((id) => id !== loopTbl?.id) ?? null
      note('本模板画布上的表格', { 全部: tblIds, 循环区: loopTbl?.id ?? null, 页级重复区: headTbl })

      if (!loopTbl || !headTbl) {
        ok('「通用清单」画布上有两张表（页级列头表 + 循环区数据表），且能认出各自属于哪个版式区',
          false, `全部=${tblIds.join('|') || '无'} 循环区=${loopTbl?.id ?? '无'}`)
      } else {
        // ---- 断言 1：两张表在画布上不相交 ----
        // 先把"每个元素被画在哪"整个列出来（辅助信息，不计分）：
        // Canvas 的渲染顺序就是 页级重复区 → 循环区 → 表尾区（Canvas.tsx 里 renderBand 的三次调用），
        // 所以这一列同时也把"哪些元素挤在版心顶部"暴露出来 —— 表尾区元素目前仍画在版心顶部，
        // 与页级重复区的标题/日期叠着（同一根因的另一面，本任务未改，见交接说明）。
        note('画布上全部元素矩形（屏幕坐标，按 DOM 顺序）',
          (await cdp.eval(`__bp.els()`)).map((e) => `${e.kind} ${e.id} y=${e.y} h=${e.h} 「${e.text}」`))
        const ov = await cdp.eval(`__bp.overlapOf(${JSON.stringify(headTbl)}, ${JSON.stringify(loopTbl.id)})`)
        note('页级重复区表格的矩形', ov?.a)
        note('循环区表格的矩形', ov?.b)
        note('两者交叠', { intersect: ov?.intersect, px: `${ov?.w}×${ov?.h}`, mm: `${ov?.mm?.w}×${ov?.mm?.h}` })
        ok('画布上「页级重复区表格」与「循环区表格」**不相交**（相交 = 循环区那张表既看不见也点不到）',
          !!ov && ov.intersect === false,
          `交叠 ${ov?.w}×${ov?.h}px（${ov?.mm?.w}×${ov?.mm?.h}mm）`)

        // ---- 断言 2：不采样、不靠下标，直着点可见区域的正中心就能选中循环区那张表 ----
        const ctr = await cdp.eval(`__bp.centerOf(${JSON.stringify(loopTbl.id)})`)
        note('循环区表格的可见区域中心', ctr)
        if (!ctr || !ctr.inViewport) {
          ok('能取到循环区表格可见区域的正中心（且在视口内）', false, JSON.stringify(ctr))
        } else {
          // 先清掉选中态，保证下面读到的"选中了谁"确实是这一次点击造成的，不是上一节的残留
          await keyPress(cdp, 'Escape')
          await sleep(300)
          const cleared = (await cdp.eval(`__bp.els()`)).filter((e) => e.sel).length
          await clickAt(cdp, ctr.x, ctr.y, 1)
          await sleep(500)
          const selNow = (await cdp.eval(`__bp.els()`)).filter((e) => e.sel).map((e) => e.id)
          let bandNow = await cdp.eval(`__bp.activeBand()`)
          if (!bandNow) {
            // 点到单元格会先落到「单元格属性」层，按一次 Esc 退回整元素层
            await keyPress(cdp, 'Escape')
            await sleep(350)
            bandNow = await cdp.eval(`__bp.activeBand()`)
          }
          note('点击前已清空的选中数 / 点击后读到的版式区', `${cleared} / ${JSON.stringify(bandNow)}`)
          ok('【核心】在循环区表格可见区域**正中心单击**（不采样、不靠元素数组下标）→ 选中的正是循环区那张表',
            selNow.length === 1 && selNow[0] === loopTbl.id,
            `点(${ctr.x},${ctr.y}) 选中=${selNow.join('|') || '无'} 期望=${loopTbl.id}`)
          ok('并且属性面板「所属版式区」显示为**循环区**（不是页级重复区）',
            bandNow === '循环区', `读数=${JSON.stringify(bandNow)}`)

          // ---- 断言 4：直着点进去之后，B1 那个开关就是可用的（缺陷的最终后果） ----
          const stLoop = await cdp.eval(`__bp.switchState('连续打印')`)
          note('点中心选中后的开关状态', stLoop)
          ok('选中循环区那张表后，「连续打印」开关**可用**（直着点一下就能到，不必靠采样绕进去）',
            stLoop?.found === true && stLoop?.disabled === false,
            JSON.stringify(stLoop))
        }

        // ---- 断言 3（反向对照）：记录模板「通用单据」——循环区里十几个元素、
        //      画布上本来就各按自己的 y 排开（该模板没有页级重复区）。
        //      同一种"取中心点一下"必须仍然能选中那张表，否则上一条可能是"随便点都能中"。
        await cdp.eval(`__bp.click('button','完成')`)
        await sleep(1400)
        await cdp.eval(`__bp.click('button','＋ 新建模板')`)
        await sleep(800)
        await cdp.eval(`__bp.click('button','记录模板（一条记录一份）')`)
        await sleep(400)
        const pickedRec = await cdp.eval(`(() => {
          const it = Array.from(document.querySelectorAll('.sk-item')).find(e => (e.textContent||'').includes('通用单据'))
          if (it) it.click(); return !!it
        })()`)
        await sleep(300)
        await cdp.eval(`__bp.click('button','创建并编辑')`)
        await waitFor(cdp, `__bp.count('.bp-el') > 0`, 9000)
        await cdp.eval(HELPERS)
        const recTbl = await selectInBand(cdp, 'table', '循环区')
        if (!recTbl) {
          ok('【反向对照】用「通用单据」骨架建模板并认出循环区那张表', false, `骨架选中=${pickedRec}`)
        } else {
          const ctr2 = await cdp.eval(`__bp.centerOf(${JSON.stringify(recTbl.id)})`)
          note('「通用单据」循环区表格的矩形与中心', { rect: ctr2?.rect, center: ctr2 && { x: ctr2.x, y: ctr2.y } })
          if (!ctr2 || !ctr2.inViewport) {
            ok('【反向对照】能取到「通用单据」循环区表格的正中心', false, JSON.stringify(ctr2))
          } else {
            await keyPress(cdp, 'Escape')
            await sleep(300)
            await clickAt(cdp, ctr2.x, ctr2.y, 1)
            await sleep(500)
            const selRec = (await cdp.eval(`__bp.els()`)).filter((e) => e.sel).map((e) => e.id)
            note('「通用单据」点中心后选中的元素', selRec)
            ok('【反向对照】记录模板「通用单据」下，同样"取中心点一下"仍能选中那张表（说明上一条不是恒真）',
              selRec.length === 1 && selRec[0] === recTbl.id,
              `骨架选中=${pickedRec} 点(${ctr2.x},${ctr2.y}) 选中=${selRec.join('|') || '无'} 期望=${recTbl.id}`)
          }
        }
      }
    }

    // ------------------------------------------------------------------
    console.log('\n[12] 表尾区落点 + 循环区元素拖动锚点（新增）')
    {
      // 背景（本任务第 1 步在真机上量出来的打印侧模型）：
      //  · 表尾是**底部锚定**的（render/layout.ts:409-410）：
      //    footerReserve = max(表尾元素 y + 实测高)、top = contentH - footerReserve、
      //    块落在 top + el.y。实测 1 / 6 / 20 / 60 条记录下，表尾两条的打印 y 恒为
      //    263.75 / 271.64mm（版心高 257mm、版心边界 277mm）—— 记录数只影响循环区。
      //  · 画布一度把表尾元素按 el.y 画在版心顶部（y=20 起），与页级重复区的
      //    「明细清单」「打印日期」**完全叠着**：表尾两条既看不清，点到的也是上层元素。
      //  · 画布要不要照抄"底部锚定"：照抄的话，当前最靠下的那条表尾元素画出来恒等于
      //    `contentH - h`（与它自己的 y 无关，拖它画布纹丝不动、同区其它元素却跟着跑），
      //    表尾在画布上就没法编辑了。所以画布按"版式区自上而下"堆叠，把表尾画在
      //    自己的分界线**之下**，并用一条常驻小字说明打印时的落点。
      await cdp.eval(`__bp.click('button','完成')`)
      await sleep(1200)
      await cdp.eval(`__bp.cardMenu('通用清单', null)`)
      await sleep(400)
      const m12 = await cdp.eval(`__bp.cardMenu('通用清单', '在侧边栏编辑')`)
      await sleep(1000)
      await waitFor(cdp, `__bp.count('.bp-el') > 0`, 9000)
      await cdp.eval(HELPERS)
      ok('（本节前提）再次从模板卡片「在侧边栏编辑」进入「通用清单」', m12?.ok === true, `入口=${JSON.stringify(m12)}`)

      const all12 = await cdp.eval(`__bp.els()`)
      note('画布上全部元素矩形（屏幕坐标，按 DOM 顺序）',
        all12?.map((e) => `${e.kind} ${e.id} y=${e.y} h=${e.h} 「${e.text}」`))
      // 元素文本里可能带排版空格（「明 细 清 单」），比对前先把空白全去掉
      const flat = (s) => String(s ?? '').replace(/\s/g, '')
      const footEls12 = (all12 ?? []).filter((e) => /合计条数|共/.test(flat(e.text)))
      const headTitle12 = (all12 ?? []).find((e) => flat(e.text).includes('明细清单')) ?? null
      const headDate12 = (all12 ?? []).find((e) => flat(e.text).includes('打印日期')) ?? null
      note('本模板的表尾元素 / 页级重复区的标题与日期',
        { 表尾: footEls12.map((e) => `${e.id}「${e.text}」y=${e.y}`), 标题: headTitle12?.id ?? null, 日期: headDate12?.id ?? null })
      if (footEls12.length < 2 || !headTitle12 || !headDate12) {
        ok('「通用清单」画布上能认出 2 个表尾元素 + 页级重复区的标题/日期（本节前提）', false,
          `表尾 ${footEls12.length} 个 / 标题=${headTitle12?.id ?? '无'} / 日期=${headDate12?.id ?? '无'}`)
      } else {
        // ---- 断言 1（核心）：表尾元素与页级重复区元素不相交 ----
        // 改前：表尾两条画在版心顶部（y=20 / 27.89），与「明细清单」(y=20) 完全重叠。
        const pairs = []
        for (const h of [headTitle12, headDate12]) {
          for (const f of footEls12) {
            const ov = await cdp.eval(`__bp.overlapOf(${JSON.stringify(h.id)}, ${JSON.stringify(f.id)})`)
            pairs.push({
              表头: `${h.text}(${h.id})`, 表尾: `${f.text}(${f.id})`,
              intersect: ov?.intersect, px: ov ? `${ov.w}×${ov.h}` : null, mm: ov ? `${ov.mm.w}×${ov.mm.h}` : null,
            })
          }
        }
        note('表尾元素 × 页级重复区元素的逐对交叠', pairs)
        ok('【核心】画布上「表尾区元素」与「页级重复区元素」**不相交**（改前 4 对全部相交：表尾画在版心顶部，压着标题和日期）',
          pairs.every((p) => p.intersect === false),
          pairs.map((p) => `${p.表尾}×${p.表头}: ${p.intersect ? `相交 ${p.px}px/${p.mm}mm` : '不相交'}`).join('；'))

        // ---- 断言 2：表尾也不能改去压在循环区表格上（"换个地方叠"不算修好） ----
        const loopTbl12 = await selectInBand(cdp, 'table', '循环区')
        if (!loopTbl12) {
          ok('认得出「通用清单」循环区那张数据表（后续拖动靶子）', false, '按「所属版式区」没能认出循环区表格')
        } else {
          const ovLoop = await cdp.eval(`__bp.overlapOf(${JSON.stringify(footEls12[0].id)}, ${JSON.stringify(loopTbl12.id)})`)
          note('表尾元素 × 循环区表格的交叠', { intersect: ovLoop?.intersect, px: ovLoop ? `${ovLoop.w}×${ovLoop.h}` : null })
          ok('画布上「表尾区元素」与「循环区表格」也不相交（不是把表尾挪到循环表上就算修好）',
            !!ovLoop && ovLoop.intersect === false,
            `交叠 ${ovLoop?.w}×${ovLoop?.h}px（${ovLoop?.mm?.w}×${ovLoop?.mm?.h}mm）`)
        }

        // ---- 断言 3：表尾元素画在表尾区**分界线之下**（画布内部自洽，不是"随便挪开"） ----
        // 拿分界线的 getBoundingClientRect().top 做基准：它 height:0 + border-top，
        // bottom 会比那条虚线的实际位置低 1px，拿 bottom 比会凭空得到 −2px。
        const geo = await cdp.eval(`(() => {
          const d = document.querySelector('.bp-band__divider')
          const f = document.querySelector('[data-el-id=${JSON.stringify(footEls12[0].id)}]')
          if (!d || !f) return null
          const dr = d.getBoundingClientRect(), fr = f.getBoundingClientRect()
          return {
            dividerTop: Math.round(dr.top), dividerBottom: Math.round(dr.bottom),
            footTop: Math.round(fr.top), gap: Math.round(fr.top - dr.top),
          }
        })()`)
        note('表尾分界线（虚线）位置 / 第一条表尾元素的顶边', geo)
        ok('表尾元素被画在**表尾区分界线之下**（改前它在分界线上方 60mm 处，即版心顶部）',
          !!geo && geo.gap >= -2 && geo.gap <= 60,
          `分界线顶边 ${geo?.dividerTop}px、表尾元素顶边 ${geo?.footTop}px、间距 ${geo?.gap}px`)

        // ---- 断言 4/5：表尾元素点得到，且「所属版式区」= 表尾区（不采样、直点中心） ----
        const ctrFoot = await cdp.eval(`__bp.centerOf(${JSON.stringify(footEls12[0].id)})`)
        note('第一条表尾元素的可见区域中心', ctrFoot)
        if (!ctrFoot || !ctrFoot.inViewport) {
          ok('能取到表尾元素可见区域的正中心（且在视口内）', false, JSON.stringify(ctrFoot))
        } else {
          await keyPress(cdp, 'Escape')
          await sleep(300)
          await clickAt(cdp, ctrFoot.x, ctrFoot.y, 1)
          await sleep(500)
          const selFoot = (await cdp.eval(`__bp.els()`)).filter((e) => e.sel).map((e) => e.id)
          let bandFoot = await cdp.eval(`__bp.activeBand()`)
          if (!bandFoot) {
            await keyPress(cdp, 'Escape')
            await sleep(350)
            bandFoot = await cdp.eval(`__bp.activeBand()`)
          }
          note('点表尾元素中心后：选中项 / 版式区读数', { 选中: selFoot, 版式区: bandFoot })
          ok('【核心】在表尾元素可见区域**正中心单击**（不采样）→ 选中的正是那条表尾元素',
            selFoot.length === 1 && selFoot[0] === footEls12[0].id,
            `点(${ctrFoot.x},${ctrFoot.y}) 选中=${selFoot.join('|') || '无'} 期望=${footEls12[0].id}`)
          ok('并且属性面板「所属版式区」显示为**表尾区**',
            bandFoot === '表尾区', `读数=${JSON.stringify(bandFoot)}`)
        }

        // ---- 断言 6/7：画布上必须**明说**"表尾打印时贴版心底部" ----
        // 选 (b) 的代价就是画布与打印的位置不一致，那就必须把不一致写在纸面上。
        // tooltip 不算（要悬停才看得见），必须是一条常驻、有实际尺寸的小字。
        //
        // ⚠️ 说明与表尾元素的相对位置必须在**同一次 eval** 里读：画布是可滚动的，
        // 前面 centerOf 的 scrollIntoView 会把纸张整体挪走，两次读数直接相减就是拿两个
        // 不同滚动位置下的坐标作比（第一版就踩了：把"说明在元素上方 196px"量成了事实）。
        const noteGeo = await cdp.eval(`(() => {
          const n = document.querySelector('.bp-band__note')
          if (!n) return null
          const nr = n.getBoundingClientRect()
          const flat = (s) => String(s || '').replace(/\\s/g, '')
          const foots = Array.from(document.querySelectorAll('.bp-paper > .bp-el'))
            .filter((e) => /合计条数|共/.test(flat(e.textContent)))
            .map((e) => e.getBoundingClientRect().bottom)
          const footBottom = foots.length ? Math.max(...foots) : null
          return {
            text: (n.textContent || '').trim(),
            w: Math.round(nr.width), h: Math.round(nr.height), top: Math.round(nr.top),
            footBottom: footBottom === null ? null : Math.round(footBottom),
            gap: footBottom === null ? null : Math.round(nr.top - footBottom),
          }
        })()`)
        note('表尾落点说明（.bp-band__note）与表尾元素底边（同一次读数）', noteGeo)
        ok('画布上有一条**常驻可见**的说明："表尾打印时贴版心底部"（不是 tooltip）',
          !!noteGeo && /版心底部/.test(noteGeo.text) && noteGeo.w > 20 && noteGeo.h > 4,
          `读数=${JSON.stringify(noteGeo)}`)
        ok('这条说明被放在表尾元素**下方**（不压住它要解释的那组元素）',
          !!noteGeo && noteGeo.gap !== null && noteGeo.gap >= 0 && noteGeo.gap <= 60,
          `说明顶边 ${noteGeo?.top}px、表尾元素底边 ${noteGeo?.footBottom}px、间距 ${noteGeo?.gap}px`)

        // ---- 断言 8（核心）：拖循环区元素必须有可见反馈（改前那段位移被版式区起点吃掉） ----
        // 版式区会把循环区元素顶到"页级重复区底部"再往下画（render/layout.ts:343-345），
        // 画布也照做了；但拖动一度还拿模型里的 el.y 当锚点，于是元素与指针之间差着
        // 这个偏移量 —— 往下拖 20mm 元素纹丝不动，用户的感受是"拖不动"。
        const beforePin = await cdp.eval(`__bp.rect(${JSON.stringify(loopTbl12.id)})`)
        const ptLoop = await cdp.eval(`__bp.pointEl(${JSON.stringify(loopTbl12.id)})`)
        note('循环区表格：拖动前的矩形与可命中点', { rect: beforePin, pt: ptLoop })
        if (!loopTbl12 || !ptLoop) {
          ok('能定位到循环区表格上可命中的拖动点', false, JSON.stringify({ tbl: loopTbl12?.id ?? null, pt: ptLoop }))
        } else {
          // 8a：先往上拖 —— 它本来就贴着上边界，位置不会变，但画面必须给出解释
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ptLoop.x, y: ptLoop.y, button: 'none', buttons: 0 })
          await sleep(80)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ptLoop.x, y: ptLoop.y, button: 'left', buttons: 1, clickCount: 1 })
          await sleep(80)
          for (let i = 1; i <= 6; i++) {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ptLoop.x, y: ptLoop.y - i * 8, button: 'left', buttons: 1 })
            await sleep(40)
          }
          const pinSeen = await cdp.eval(`(() => {
            const p = document.querySelector('.bp-el-pin')
            if (!p) return null
            const r = p.getBoundingClientRect()
            return { text: (p.textContent || '').trim(), w: Math.round(r.width), h: Math.round(r.height) }
          })()`)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ptLoop.x, y: ptLoop.y - 48, button: 'left', buttons: 0, clickCount: 1 })
          await sleep(500)
          const pinGone = await cdp.eval(`!document.querySelector('.bp-el-pin')`)
          note('往上拖（已贴上边界）时读到的小标 / 松手后是否消失', { pinSeen, pinGone })
          ok('【核心】元素已经贴着版式区上边界、位置推不动时，画布给出**可见反应**（描边 +「已贴版式区上边」小标），而不是"拖了完全没反应"',
            !!pinSeen && /已贴版式区上边/.test(pinSeen.text) && pinSeen.w > 10 && pinSeen.h > 4,
            `读到的反馈=${JSON.stringify(pinSeen)}`)
          ok('松手后这枚小标消失（只在"推不动"的当下出现，不是常驻装饰）',
            !!pinSeen && pinGone === true, `拖拽中读到的反馈=${!!pinSeen}；松手后还存在吗：${!pinGone}`)
        }

        // 8b：再往下拖 —— 必须**立刻**跟着指针走
        const ptLoop2 = await cdp.eval(`__bp.pointEl(${JSON.stringify(loopTbl12.id)})`)
        const beforeDrag = await cdp.eval(`__bp.rect(${JSON.stringify(loopTbl12.id)})`)
        if (!ptLoop2) {
          ok('往上拖之后仍能定位到循环区表格上可命中的点', false, JSON.stringify(ptLoop2))
        } else {
          const DY12 = 40
          await dragTo(cdp, ptLoop2, { x: ptLoop2.x, y: ptLoop2.y + DY12 })
          const afterDrag = await cdp.eval(`__bp.rect(${JSON.stringify(loopTbl12.id)})`)
          const dyL = afterDrag.y - beforeDrag.y
          note('往下拖循环区表格', { before: beforeDrag, after: afterDrag, Δtop: dyL, 指针位移: DY12 })
          ok('【核心】往下拖循环区表格 → 画布上它**立刻**跟着指针走（改前：这段位移被"页级重复区底部"这个起点吃掉了，实测位移 0px）',
            dyL > 0, `top ${beforeDrag.y} → ${afterDrag.y}（Δ${dyL}px），指针位移 +${DY12}px`)
          ok('位移量与指针位移一致（误差在半格吸附容差内，说明它跟的是指针而不是"跳一下"）',
            Math.abs(dyL - DY12) <= tol,
            `期望约 +${DY12}px，实测 +${dyL}px，容差 ±${tol}px（网格 ${gridMm}mm × ${pxPerMm.toFixed(2)}px/mm）`)
        }

        // ---- 断言 9（反向对照）：拖表尾元素时，页级重复区的标题必须纹丝不动 ----
        const ptFoot12 = await cdp.eval(`__bp.pointEl(${JSON.stringify(footEls12[0].id)})`)
        if (!ptFoot12) {
          ok('【反向对照】能定位到表尾元素上可命中的拖动点', false, JSON.stringify(ptFoot12))
        } else {
          const bT = await cdp.eval(`({ f: __bp.rect(${JSON.stringify(footEls12[0].id)}), h: __bp.rect(${JSON.stringify(headTitle12.id)}) })`)
          await dragTo(cdp, ptFoot12, { x: ptFoot12.x, y: ptFoot12.y + 30 })
          const aT = await cdp.eval(`({ f: __bp.rect(${JSON.stringify(footEls12[0].id)}), h: __bp.rect(${JSON.stringify(headTitle12.id)}) })`)
          note('拖表尾元素前后的矩形', { 表尾前: bT.f, 表尾后: aT.f, 表头前: bT.h, 表头后: aT.h })
          ok('【反向对照】拖表尾元素 → 它自己动了，页级重复区的标题元素位置纹丝不动',
            aT.f.y > bT.f.y && aT.h.y === bT.h.y && aT.h.x === bT.h.x && aT.h.w === bT.h.w,
            `表尾 top ${bT.f.y} → ${aT.f.y}（Δ${aT.f.y - bT.f.y}）；标题 ${bT.h.x},${bT.h.y} → ${aT.h.x},${aT.h.y}`)
        }
      }
    }

    // ------------------------------------------------------------------
    console.log('\n[13] 网格分层 / 重叠模型 / 属性面板排版（新增）')
    {
      // 用户三条原始反馈：
      //  ①「拖入的表格边框和内部的线条都不清晰，和画布的网格重合了，无法区分」
      //  ②「拖入表格后，从左侧拖入的其他字段也无法放置到单元格内，似乎是漂浮在单元格上了」
      //  ③「属性区域，一些功能排版有问题，有些字显示不全，用了省略号代替，有些又和输入框太远」
      //
      // ① 的根因：表格线的**兜底色和网格线共用同一个令牌**（--paper-line），而新建表格的线色
      //    #c9cdd4 本身就淡 —— 实测"网格 vs 表格线"的对照度只有 1.36:1，肉眼就是糊成一片。
      //    修法是**分层**、不是删网格（网格是用户明确要的）：网格换独立令牌 + 降 opacity
      //    （有效 0.1×0.5 = 0.05，落在白纸上约 rgb(244,244,244)），新建表格的线色改深到
      //    骨架里早就在用的 #8f959e。
      // ② 的根因：拖放链路只会 createDefaultElement + addElement，从不写进单元格的 nodes ——
      //    于是字段"漂浮"在单元格上方，跟那一格没有任何关系。
      // ③ 的根因：.bp-field__label 上挂着 nowrap + overflow:hidden + text-overflow:ellipsis。

      // 量"真实颜色"而不是"class 在不在"：读 getComputedStyle 里的 rgba 与 opacity，
      // 按 CSS 的合成规则折算成落在白纸上的颜色，再算 WCAG 对照度。
      // 改前 .bp-grid 这个 class 也在（网格一直在），所以"断言 class 存在"是恒真的废断言。
      const LINES_PROBE = `(() => {
        const parse = (s) => {
          const m = String(s || '').match(/rgba?\\(([^)]+)\\)/)
          if (!m) return null
          const p = m[1].split(',').map((x) => parseFloat(x.trim()))
          return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
        }
        const over = (fg, bg) => ({
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
        })
        const lum = (c) => {
          const f = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4) }
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
        }
        const ratio = (a, b) => {
          const l1 = lum(a), l2 = lum(b)
          return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100
        }
        const round = (c) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) })
        const paper = document.querySelector('.bp-paper')
        const grid = document.querySelector('.bp-grid')
        if (!paper || !grid) return { missing: { paper: !!paper, grid: !!grid } }
        const pc = getComputedStyle(paper), gc = getComputedStyle(grid)
        const paperBg = parse(pc.backgroundColor) || { r: 255, g: 255, b: 255, a: 1 }
        const token = parse(gc.backgroundImage)
        if (!token) return { missing: { gridToken: gc.backgroundImage } }
        const op = parseFloat(gc.opacity)
        const eff = token.a * op
        const gridInk = over({ ...token, a: eff }, paperBg)
        const tables = Array.from(document.querySelectorAll('.bp-el-table')).map((t, i) => {
          const td = t.querySelector('td')
          if (!td) return { i, ink: null }
          const ink = over(parse(getComputedStyle(td).borderTopColor), paperBg)
          return { i, ink, vsPaper: ratio(ink, paperBg), vsGrid: ratio(ink, gridInk) }
        })
        const legacyGridInk = over({ r: 31, g: 35, b: 41, a: 0.12 * 0.7 }, paperBg)
        return {
          band: paper.className.includes('is-element-selected') ? '选中态' : '默认态',
          paperBg: round(paperBg),
          gridToken: token, gridOpacity: Math.round(op * 1000) / 1000,
          gridEffAlpha: Math.round(eff * 10000) / 10000,
          gridInk: round(gridInk), gridVsPaper: ratio(gridInk, paperBg),
          tables: tables.map((t) => (t.ink ? { i: t.i, ink: round(t.ink), vsPaper: t.vsPaper, vsGrid: t.vsGrid } : { i: t.i, ink: null })),
          minVsGrid: tables.length && tables.every((t) => t.ink) ? Math.min(...tables.map((t) => t.vsGrid)) : null,
          legacy: {
            gridInk: round(legacyGridInk),
            tableInk: { r: 201, g: 205, b: 212 },
            vsGrid: ratio({ r: 201, g: 205, b: 212 }, legacyGridInk),
          },
        }
      })()`

      /** 找一块真正空的纸面：网格/版心框都不吃鼠标事件，只有 .bp-el 和 td 会挡 */
      const FREE_POINT = `(function () {
        const box = document.querySelector('.bp-content-box') || document.querySelector('.bp-paper')
        const r = box.getBoundingClientRect()
        const els = Array.from(document.querySelectorAll('.bp-paper .bp-el')).map((e) => e.getBoundingClientRect())
        for (let fy = 0.3; fy <= 0.97; fy += 0.04) {
          for (let fx = 0.08; fx <= 0.92; fx += 0.04) {
            const x = Math.round(r.left + r.width * fx)
            const y = Math.round(r.top + r.height * fy)
            if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) continue
            const hit = document.elementFromPoint(x, y)
            if (!hit || hit.closest('.bp-el') || hit.closest('td')) continue
            if (els.some((b) => x > b.left - 12 && x < b.right + 12 && y > b.top - 12 && y < b.bottom + 12)) continue
            return { x, y }
          }
        }
        return null
      })()`

      /**
       * 宽屏下左侧插入面板的页签是 [aria-label="插入面板"] 里的 .bp-seg__item。
       *
       * ⚠️ `[14]` 段 E 组里有一份**逐字相同**的 `switchPalette14`（它那段看不见这里）。
       * 改这一份时对照着改那一份 —— 见文件头的「同名小工具跨段清单」。
       */
      const switchPalette = async (label) => {
        const r = await cdp.eval(`(() => {
          const host = document.querySelector('[aria-label="插入面板"]') || document.querySelector('.bp-tabs')
          if (!host) return { ok: false, why: '找不到插入面板页签' }
          const b = Array.from(host.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)})
          if (b) b.click()
          return { ok: !!b, items: Array.from(host.querySelectorAll('button')).map((x) => (x.textContent || '').trim()) }
        })()`)
        await sleep(450)
        return r
      }

      /**
       * 从左侧面板拖到画布某点。关键是**松手之前**读一次实时反馈 ——
       * "能不能放"必须在拖的时候就能看见，不能等松手了才弹一句"不行"。
       */
      const dragPalette = async (startExpr, to, tag) => {
        const from = await cdp.eval(startExpr)
        if (!from || !to) return { tag, from, to, skipped: true }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
        await sleep(80)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
        await sleep(60)
        for (let i = 1; i <= 10; i++) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(from.x + ((to.x - from.x) * i) / 10),
            y: Math.round(from.y + ((to.y - from.y) * i) / 10),
            button: 'left', buttons: 1,
          })
          await sleep(45)
        }
        const live = await cdp.eval(`(() => {
          const hint = document.querySelector('.bp-drop-hint')
          const cell = document.querySelector('.bp-el-cell.is-drop-target')
          const paper = document.querySelector('.bp-paper')
          return {
            hint: hint ? (hint.textContent || '').trim() : null,
            hintClass: hint ? hint.className : null,
            targetCell: cell ? cell.getAttribute('data-cell-id') : null,
            rejectRing: paper ? paper.className.includes('is-drop-reject') : null,
            elCount: __bp.count('.bp-el'),
          }
        })()`)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
        await sleep(750)
        const after = await cdp.eval(`(() => {
          const t = document.querySelector('.bp-toast')
          return {
            toast: t ? (t.textContent || '').trim() : null,
            elCount: __bp.count('.bp-el'),
            selectedCell: (document.querySelector('.bp-el-cell.is-selected') || { getAttribute: () => null }).getAttribute('data-cell-id'),
          }
        })()`)
        return { tag, from, to, live, after }
      }

      // ---- 重新进编辑器（走用户入口，状态干净、和用户看到的一样） ----
      await cdp.eval(`__bp.click('button','完成')`)
      await sleep(1200)
      await cdp.eval(`__bp.cardMenu('通用清单', null)`)
      await sleep(400)
      const m13 = await cdp.eval(`__bp.cardMenu('通用清单', '在侧边栏编辑')`)
      await sleep(1000)
      await waitFor(cdp, `__bp.count('.bp-el') > 0`, 9000)
      await cdp.eval(HELPERS)
      ok('（本节前提）从模板卡片重新进入「通用清单」编辑器', m13?.ok === true, `入口=${JSON.stringify(m13)}`)

      const defLines = await cdp.eval(LINES_PROBE)
      note('默认态（什么都没选中）：网格 / 表格线的真实颜色与对照度', defLines)
      const tablesOf = (l) => (l?.tables ?? []).filter((t) => t.ink)
      if (!defLines || defLines.missing || tablesOf(defLines).length === 0) {
        ok('【核心】默认态：能量到网格线与表格线的实际颜色', false, JSON.stringify(defLines))
      } else {
        ok('【核心】默认态（未选中任何元素）：画布网格线与表格线的实际对照度**分得开**（网格更淡，差 ≥2 倍）',
          defLines.minVsGrid !== null && defLines.minVsGrid >= 2,
          `网格落在白纸上 ${JSON.stringify(defLines.gridInk)}（${defLines.gridVsPaper}:1），` +
            `表格线 ${tablesOf(defLines).map((t) => `#${t.i}:${JSON.stringify(t.ink)} 与网格 ${t.vsGrid}:1`).join('；')}`)
        ok('同一把尺子量**改前**那组取值 → 只有 1.36:1（说明上一条不是恒真断言：这把尺子确实能把"分不清"和"分得清"分开）',
          defLines.legacy.vsGrid < 2,
          `改前 网格 ${JSON.stringify(defLines.legacy.gridInk)} vs 新表线 ${JSON.stringify(defLines.legacy.tableInk)} = ${defLines.legacy.vsGrid}:1`)
        ok('默认态的网格**仍然看得见**（没有被"修好"成删掉网格）：有效不透明度在 0.03～0.2 之间',
          defLines.gridEffAlpha >= 0.03 && defLines.gridEffAlpha <= 0.2,
          `令牌 ${JSON.stringify(defLines.gridToken)} × opacity ${defLines.gridOpacity} = 有效 ${defLines.gridEffAlpha}`)
      }

      // ---- 选中表格元素：网格再淡一档，但默认态已经能分开 ----
      const pickTbl = await cdp.eval(`(() => {
        const t = document.querySelector('.bp-paper > .bp-el--table')
        if (!t) return null
        const r = t.getBoundingClientRect()
        return { x: Math.round(r.left + r.width * 0.25), y: Math.round(r.top + r.height * 0.5) }
      })()`)
      if (pickTbl) {
        await clickAt(cdp, pickTbl.x, pickTbl.y, 1)
        await sleep(500)
      }
      const selLines = await cdp.eval(LINES_PROBE)
      note('选中表格元素后：网格 / 表格线的真实颜色与对照度', selLines)
      if (!selLines || selLines.missing || selLines.band !== '选中态') {
        ok('【核心】选中元素后网格再淡一档、但表格线依旧更清楚', false,
          `此刻版式=? ${JSON.stringify(selLines?.band)} 未选中态读数=${JSON.stringify(selLines?.missing ?? null)}`)
      } else {
        ok('【核心】选中元素后网格再淡一档（有效不透明度变小）但仍可见，表格线依旧比它清楚 ≥2 倍',
          selLines.gridEffAlpha < defLines.gridEffAlpha && selLines.gridEffAlpha > 0.015 &&
            selLines.minVsGrid !== null && selLines.minVsGrid >= 2,
          `网格有效不透明度 ${defLines.gridEffAlpha} → ${selLines.gridEffAlpha}；表格线与网格最小对照度 ${selLines.minVsGrid}:1`)
      }

      // ---- 属性面板：标签不被截断 / 色板不挤成竖条 ----
      const panelFacts = await cdp.eval(`(() => {
        const side = document.querySelector('.bp-side--right')
        if (!side) return null
        const fields = Array.from(side.querySelectorAll('.bp-field')).map((f) => {
          const lab = f.querySelector('.bp-field__label')
          const body = f.querySelector('.bp-field__body')
          const cs = lab ? getComputedStyle(lab) : null
          return {
            label: lab ? (lab.textContent || '').trim() : null,
            truncated: lab ? lab.scrollWidth > lab.clientWidth + 1 : null,
            textOverflow: cs ? cs.textOverflow : null,
            whiteSpace: cs ? cs.whiteSpace : null,
            title: lab ? (lab.getAttribute('title') || '') : '',
            bodyLeft: body ? Math.round(body.getBoundingClientRect().left) : null,
          }
        })
        const sw = side.querySelector('.bp-color__swatches')
        let swatch = null
        if (sw) {
          const dots = Array.from(sw.children).map((d) => d.getBoundingClientRect())
          swatch = {
            w: Math.round(sw.getBoundingClientRect().width),
            h: Math.round(sw.getBoundingClientRect().height),
            rows: new Set(dots.map((d) => Math.round(d.top))).size,
            dots: dots.length,
          }
        }
        const nums = Array.from(side.querySelectorAll('.bp-num')).map((n) => Math.round(n.getBoundingClientRect().width))
        return {
          fields,
          truncated: fields.filter((f) => f.truncated).map((f) => f.label),
          ellipsis: fields.filter((f) => f.textOverflow === 'ellipsis').map((f) => f.label),
          bodyLefts: Array.from(new Set(fields.map((f) => f.bodyLeft).filter((x) => x !== null))).sort((a, b) => a - b),
          swatch, numWidths: nums, wideNums: nums.filter((w) => w >= 140).length,
        }
      })()`)
      note('属性面板：标签是否被截断 / 色板排布 / 数值控件宽度', panelFacts)
      if (!panelFacts) {
        ok('【核心】属性面板不出现被省略号截断的标签', false, '找不到 .bp-side--right')
      } else {
        ok('【核心】属性面板里**没有一个**标签被省略号截断（逐条比对 scrollWidth ≤ clientWidth，且 textOverflow 不是 ellipsis）',
          panelFacts.truncated.length === 0 && panelFacts.ellipsis.length === 0 && panelFacts.fields.length > 0,
          `共 ${panelFacts.fields.length} 个标签；被截断 ${JSON.stringify(panelFacts.truncated)}；仍是 ellipsis 的 ${JSON.stringify(panelFacts.ellipsis)}`)
        // 反向对照：把改前那条规则临时注回去，看同一把尺子能不能报出"被截断"。
        // 没有这一步的话，"0 个被截断"有可能只是量不出来（例如标签全被撑成了 0 宽）。
        const revertProbe = await cdp.eval(`(() => {
          const st = document.createElement('style')
          st.id = 'bp-t6-revert-label'
          st.textContent = '.bp-field__label{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}'
          document.head.appendChild(st)
          const side = document.querySelector('.bp-side--right')
          const hit = Array.from(side.querySelectorAll('.bp-field__label'))
            .map((l) => ({ label: (l.textContent || '').trim(), truncated: l.scrollWidth > l.clientWidth + 1, w: Math.round(l.getBoundingClientRect().width) }))
            .filter((x) => x.truncated)
          st.remove()
          return { hit }
        })()`)
        note('反向对照：临时注回改前的 nowrap+ellipsis 规则', revertProbe)
        ok('【反向对照】把改前那条 nowrap + text-overflow:ellipsis 临时注回去 → 同一批标签立刻报出 ≥1 个被截断（证明上一条的 0 是改出来的，不是量不出来）',
          (revertProbe?.hit ?? []).length >= 1,
          `注回旧规则后报出被截断的标签=${JSON.stringify((revertProbe?.hit ?? []).map((x) => `${x.label}(${x.w}px)`))}`)
        ok('色板排成网格而不是一条竖线（行数 ≤2，且色块 ≥8 个）',
          !!panelFacts.swatch && panelFacts.swatch.rows <= 2 && panelFacts.swatch.dots >= 8,
          `色板 ${JSON.stringify(panelFacts.swatch)}；标签/控件左边缘取值集合 ${JSON.stringify(panelFacts.bodyLefts)}`)
        ok('边框分组里的数值控件不再被压成半行（≥140px 宽的数值控件 ≥2 个，改前只有 1 个）',
          panelFacts.wideNums >= 2,
          `数值控件宽度 ${JSON.stringify(panelFacts.numWidths)}（宽 ≥140px 的 ${panelFacts.wideNums} 个）`)
      }

      // ---- ② 重叠模型：字段要能真的放进单元格 ----
      // 拿循环区那张表（画布上最后一张；按 kind 取第一张会挑到页级列头表）
      const cellInfo = await cdp.eval(`(() => {
        const tbls = Array.from(document.querySelectorAll('.bp-el-table'))
        const t = tbls[tbls.length - 1]
        if (!t) return null
        const tds = Array.from(t.querySelectorAll('td'))
        const td = tds[4] || tds[tds.length - 1]
        if (!td) return null
        td.scrollIntoView({ block: 'center' })
        const r = td.getBoundingClientRect()
        return {
          cellId: td.getAttribute('data-cell-id'),
          text: (td.textContent || '').trim(),
          chips: td.querySelectorAll('.bp-chip').length,
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          tableTds: tds.length, tables: tbls.length,
        }
      })()`)
      note('待清空的循环区单元格', cellInfo)
      if (!cellInfo) {
        ok('（本节前提）能在画布上定位到循环区表格的一个单元格', false, '没找到 .bp-el-table td')
      } else {
        // 先选中这一格，再从面板的「单元格内容」把它清空 —— 这样才真的是"拖到空单元格"
        await clickAt(cdp, cellInfo.x, cellInfo.y, 1)
        await sleep(500)
        const cleared = await cdp.eval(`(() => {
          const ta = document.querySelector('textarea[aria-label="单元格内容"]')
          if (!ta) return { ok: false, why: '面板上没有「单元格内容」输入框（说明没选中单元格）' }
          const was = ta.value
          const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
          proto.set.call(ta, '')
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          return { ok: true, was }
        })()`)
        await sleep(450)
        const nowEmpty = await cdp.eval(`(() => {
          const td = document.querySelector('td[data-cell-id=${JSON.stringify(cellInfo.cellId)}]')
          if (!td) return null
          // 空 + 被选中的格子会渲染一句 .bp-el-cell__ph「双击输入」的提示，
          // 它不属于单元格内容，比对"是不是真的空了"时得把它剔掉
          const ph = td.querySelector('.bp-el-cell__ph')
          const text = (td.textContent || '').replace(ph ? ph.textContent : '', '').trim()
          return { text, ph: ph ? ph.textContent : null, chips: td.querySelectorAll('.bp-chip').length }
        })()`)
        note('清空这一格', { 清空前: cleared.was, 清空后: nowEmpty })
        ok('（本节前提）能把循环区表格的某一格清空成真正的空单元格',
          cleared.ok === true && !!nowEmpty && nowEmpty.text === '' && nowEmpty.chips === 0,
          `清空前「${cleared.was}」→ 清空后 ${JSON.stringify(nowEmpty)}`)

        const tdPt = await cdp.eval(`(() => {
          const td = document.querySelector('td[data-cell-id=${JSON.stringify(cellInfo.cellId)}]')
          if (!td) return null
          td.scrollIntoView({ block: 'center' })
          const r = td.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`)
        const fieldName = await cdp.eval(`(() => {
          const b = Array.from(document.querySelectorAll('.bp-chip-item')).find((e) => !e.className.includes('is-blocked'))
          return b ? ((b.querySelector('.bp-chip-item__name') || b).textContent || '').trim() : null
        })()`)
        const tabF = await switchPalette('字段')
        const countBefore = await cdp.eval(`__bp.count('.bp-el')`)
        const dragCell = await dragPalette(
          `(function () {
            const b = Array.from(document.querySelectorAll('.bp-chip-item')).find((e) => !e.className.includes('is-blocked'))
            if (!b) return null
            b.scrollIntoView({ block: 'center' })
            const r = b.getBoundingClientRect()
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          })()`,
          tdPt,
          'into-cell',
        )
        note('拖字段进空单元格（实时反馈 + 松手结果）', { 页签: tabF, 字段: fieldName, 拖前元素数: countBefore, ...dragCell })
        ok('【核心】拖字段到空单元格：拖拽过程中那一格被高亮成"可以放进来"（绿框 + 一句"松开即放进这个单元格"）',
          dragCell.live?.targetCell === cellInfo.cellId && /is-into/.test(dragCell.live?.hintClass ?? '') &&
            /放进这个单元格/.test(dragCell.live?.hint ?? ''),
          `拖拽中读数=${JSON.stringify(dragCell.live)} 期望格子=${cellInfo.cellId}`)
        const landed = await cdp.eval(`(() => {
          const td = document.querySelector('td[data-cell-id=${JSON.stringify(cellInfo.cellId)}]')
          if (!td) return null
          return {
            text: (td.textContent || '').trim(),
            chips: td.querySelectorAll('.bp-chip').length,
            chipText: Array.from(td.querySelectorAll('.bp-chip')).map((c) => (c.textContent || '').trim()),
          }
        })()`)
        note('松手后那一格的 DOM', landed)
        ok('【核心】松手后字段**真的进了这一格**：元素总数不变（没有多出一个漂浮元素），格子里出现字段占位符',
          dragCell.after?.elCount === countBefore && !!landed && landed.chips === 1 &&
            !!fieldName && landed.text.includes(fieldName),
          `元素数 ${countBefore} → ${dragCell.after?.elCount}；格子内容「${landed?.text}」占位符 ${JSON.stringify(landed?.chipText)}；拖的字段=${fieldName}`)
        const cellPanel = await cdp.eval(`(() => {
          const refs = Array.from(document.querySelectorAll('.bp-fieldref')).map((r) => (r.textContent || '').trim())
          const hint = document.querySelector('.bp-side--right .bp-hint')
          return {
            refs,
            section: (document.querySelector('.bp-side--right') || {}).innerText ? '' : null,
            hasContentInput: !!document.querySelector('textarea[aria-label="单元格内容"]'),
            hint: hint ? hint.textContent : null,
          }
        })()`)
        ok('产品自己的读数也认这一格绑上了字段（面板「这一格的字段」列出该占位符，而不是"这一格还没有字段占位符"）',
          !!fieldName && cellPanel.hasContentInput && cellPanel.refs.some((t) => t.includes(fieldName)),
          `「这一格的字段」读数=${JSON.stringify(cellPanel.refs)} 期望含「${fieldName}」`)
        ok('并且画布把选中切到了这一格（.bp-el-cell.is-selected 的 data-cell-id 就是它）',
          dragCell.after?.selectedCell === cellInfo.cellId,
          `选中格=${dragCell.after?.selectedCell} 期望=${cellInfo.cellId}`)
      }

      // ---- 容器边界：只有单元格能"装"东西，而且只装得下字段/系统变量/文字 ----
      await switchPalette('元素')
      const td0 = await cdp.eval(`(() => {
        const tbls = Array.from(document.querySelectorAll('.bp-el-table'))
        const t = tbls[tbls.length - 1]
        const td = t ? t.querySelectorAll('td')[0] : null
        if (!td) return null
        td.scrollIntoView({ block: 'center' })
        const r = td.getBoundingClientRect()
        return { cellId: td.getAttribute('data-cell-id'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      const elDragIntoCell = await dragPalette(
        `(function () {
          const b = Array.from(document.querySelectorAll('.bp-el-item')).find((e) => (e.textContent || '').includes('表格'))
          if (!b) return null
          b.scrollIntoView({ block: 'center' })
          const r = b.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`,
        td0,
        'element-into-cell',
      )
      note('把「表格」元素拖进单元格（应当被拒并说明容器装不下）', elDragIntoCell)
      ok('【容器边界】把**元素**（表格）拖进单元格 → 被拒，且理由说清"单元格只装得下字段、系统变量或文字"',
        /is-reject/.test(elDragIntoCell.live?.hintClass ?? '') && /只能放字段/.test(elDragIntoCell.live?.hint ?? '') &&
          elDragIntoCell.after?.toast !== null && /只能放字段/.test(elDragIntoCell.after?.toast ?? ''),
        `拖拽中=${JSON.stringify(elDragIntoCell.live?.hint)}；松手后 toast=${JSON.stringify(elDragIntoCell.after?.toast)}`)

      // ---- ③ 重叠：拖到已被占用的位置必须被拒、并当场说明理由 ----
      const hdrTitle = await cdp.eval(`(() => {
        const flat = (s) => String(s || '').replace(/\\s/g, '')
        const e = Array.from(document.querySelectorAll('.bp-paper > .bp-el')).find((x) => flat(x.textContent).includes('明细清单'))
        return e ? e.getAttribute('data-el-id') : null
      })()`)
      const occPt = hdrTitle ? await cdp.eval(`__bp.pointEl(${JSON.stringify(hdrTitle)})`) : null
      const countBefore2 = await cdp.eval(`__bp.count('.bp-el')`)
      const dragReject = await dragPalette(
        `(function () {
          const b = Array.from(document.querySelectorAll('.bp-el-item')).find((e) => (e.textContent || '').includes('表格'))
          if (!b) return null
          b.scrollIntoView({ block: 'center' })
          const r = b.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`,
        occPt,
        'reject',
      )
      note('把「表格」元素拖到已被占用的位置（实时反馈 + 松手结果）',
        { 目标元素: hdrTitle, 拖前元素数: countBefore2, ...dragReject })
      ok('【核心】往已被占用的位置拖 → 拖拽中就是"禁止"态（整张纸红边 + 一句话说明为什么不能放）',
        dragReject.live?.rejectRing === true && /is-reject/.test(dragReject.live?.hintClass ?? '') &&
          /不能重叠/.test(dragReject.live?.hint ?? ''),
        `拖拽中读数=${JSON.stringify(dragReject.live)}`)
      ok('【核心】松手被拒 → 元素总数不变（没有静默叠上去），并且当场把理由说出来（toast 不是沉默）',
        dragReject.after?.elCount === countBefore2 && /不能重叠/.test(dragReject.after?.toast ?? ''),
        `元素数 ${countBefore2} → ${dragReject.after?.elCount}；toast=${JSON.stringify(dragReject.after?.toast)}`)

      // ---- 反向对照：同一个元素拖到空白处应当正常落位 ----
      const freePt = await cdp.eval(FREE_POINT)
      const dragFree = await dragPalette(
        `(function () {
          const b = Array.from(document.querySelectorAll('.bp-el-item')).find((e) => (e.textContent || '').includes('表格'))
          if (!b) return null
          b.scrollIntoView({ block: 'center' })
          const r = b.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })()`,
        freePt,
        'free',
      )
      note('【反向对照】同一个「表格」元素拖到空白处', { 落点: freePt, ...dragFree })
      ok('【反向对照】同一个元素拖到**空白处** → 正常落位（元素数 +1），说明上一条的"被拒"不是"拖什么都没反应"',
        !dragFree.skipped && dragFree.after?.elCount === countBefore2 + 1,
        `落点=${JSON.stringify(freePt)}；元素数 ${countBefore2} → ${dragFree.after?.elCount}（期望 +1）；拖拽中提示=${JSON.stringify(dragFree.live?.hint)}`)

      // ---- 新拖进来的这张表，线色也得和网格分得开（改前它是 #c9cdd4，和网格只差 1.36:1） ----
      const newLines = await cdp.eval(LINES_PROBE)
      const lastTbl = (newLines?.tables ?? []).filter((t) => t.ink).pop()
      note('新拖入的表格：线与网格的对照度', { 全部表格: newLines?.tables, 最后一张: lastTbl })
      ok('【核心】新拖入的表格，线色与画布网格同样分得开（≥2 倍）—— 改前它是 #c9cdd4，和网格只差 1.36:1',
        !!lastTbl && lastTbl.vsGrid >= 2,
        `新表线色 ${JSON.stringify(lastTbl?.ink)} 与网格 ${newLines?.gridInk ? JSON.stringify(newLines.gridInk) : '?'} 的对照度 ${lastTbl?.vsGrid}:1`)
    }

    // ------------------------------------------------------------------
    console.log('\n[14] 顶栏工具栏 / 横向纵向 / 页内预览 / 字段字体（新增）')
    {
      // 用户原话（第二波）：
      //   「优化画布工具区的样式，可以参考这个官方的样式，文本的编辑可以放在上方，
      //     同时增加横向和纵向的设置，再增加直接在此页面预览打印效果的功能，
      //     页面的相关设置也放在这个按钮内」
      //   「似乎无法对**字段内容**进行字体的设置，增加可以设置字体的功能」
      //
      // 这一节每一条都**不看按钮的样式态**（aria-pressed / class 是不是 is-on），只看它改出来的东西：
      //   ① 顶栏的文本编辑真的写进了"当前最细的那一层"（元素 / 节点），不是只把按钮点亮；
      //   ② 横/纵向切换之后 pageSetup 真的变了、画布纸张真的对调；
      //   ③ 「在此页面预览」打开的是 **renderDocument 的产物**，不是另排一次版的简图；
      //   ④ 字段占位符能设自己的字体，而且**打印产物里那个字段的值真的带上了它**。
      //
      // ④ 是本节最承重的一条：模型（InlineField.style）到渲染层的通路本来就在
      //   （render/html.ts:294 那个 span 用的就是 inlineCss(n.style)），缺的只是编辑器里的
      //   选中与界面。所以"画布上看着变了"什么也证明不了 —— 必须把预览打开、进到产物里，
      //   读那一个 span 自己的 style。

      await keyPress(cdp, 'Escape')
      await sleep(200)
      await keyPress(cdp, 'Escape')
      await sleep(400)

      // ============================================================
      // A. 顶栏：文本编辑作用在"当前目标"上
      // ============================================================
      const bar0 = await cdp.eval(`(() => {
        const q = (s) => document.querySelector(s)
        const t = q('.bp-tools')
        const sc = q('.bp-tools__scope-text')
        const g = q('[aria-label="顶栏对齐"]')
        const box = t ? t.getBoundingClientRect() : null
        const undo = q('.bp-tools [aria-label="撤销"]')
        const redo = q('.bp-tools [aria-label="重做"]')
        const orient = q('button[aria-label^="纸张方向："]')
        const bx = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), w: Math.round(r.width) } }
        return {
          hasBar: !!t,
          mode: t ? t.getAttribute('data-tools') : null,
          scope: sc ? (sc.textContent || '').trim() : null,
          barH: box ? Math.round(box.height) : null,
          ctrl: {
            bold: !!q('button[aria-label="加粗"]'),
            italic: !!q('button[aria-label="斜体"]'),
            underline: !!q('button[aria-label="下划线"]'),
            strike: !!q('button[aria-label="删除线"]'),
            font: !!q('button[aria-label="顶栏字体"]'),
            size: !!q('input[aria-label="顶栏字号"]'),
            align: !!g,
            alignCount: g ? g.querySelectorAll('button').length : 0,
            color: !!q('input[aria-label="顶栏字色"]'),
            paper: !!q('button[aria-label="纸张"]'),
            orient: !!q('button[aria-label^="纸张方向："]'),
            page: !!q('button[aria-label="页面设置"]'),
            preview: !!q('button[aria-label="预览打印效果"]'),
          },
          history: {
            undo: !!undo, redo: !!redo,
            undoBox: bx(undo), redoBox: bx(redo), orientBox: bx(orient),
            barRight: box ? Math.round(box.right) : null,
          },
          selected: document.querySelectorAll('.bp-el.is-selected').length,
        }
      })()`)
      note('顶栏工具栏（未选中时的读数）', bar0)
      const c0 = bar0?.ctrl ?? {}
      ok('【顶栏】文本编辑搬到了上方，和纸张那一组并排：B/I/U/S + 字体 + 字号 + 左中右两端 4 档对齐 + 字色；右侧是 纸张 / 横纵向 / 页面设置 / 预览',
        bar0?.hasBar === true &&
          c0.bold === true && c0.italic === true && c0.underline === true && c0.strike === true &&
          c0.font === true && c0.size === true && c0.align === true && c0.alignCount === 4 && c0.color === true &&
          c0.paper === true && c0.orient === true && c0.page === true && c0.preview === true,
        `模式=${bar0?.mode} 工具行高=${bar0?.barH}px 控件=${JSON.stringify(c0)}`)
      ok('【顶栏】撤销 / 重做 落在**这条工具行的最右端**（左边文本编辑、右边纸张与页面）—— 改完随手一个撤销，不用再回上面那一行找',
        bar0?.history?.undo === true && bar0?.history?.redo === true &&
          !!bar0.history.undoBox && !!bar0.history.redoBox &&
          bar0.history.redoBox.l > bar0.history.undoBox.l &&
          typeof bar0.history.barRight === 'number' && bar0.history.barRight - bar0.history.redoBox.r <= 40,
        `工具行右边界 ${bar0?.history?.barRight}px；撤销 ${JSON.stringify(bar0?.history?.undoBox)} / 重做 ${JSON.stringify(bar0?.history?.redoBox)} / 方向 ${JSON.stringify(bar0?.history?.orientBox)}`)
      ok('【顶栏】什么都没选中时，作用对象写的是「默认样式（只影响之后插入的元素）」—— 顶栏改的是哪一层，是写在脸上的',
        bar0?.selected === 0 && /^改：默认样式/.test(bar0?.scope ?? ''),
        `选中元素数=${bar0?.selected} 作用对象「${bar0?.scope}」`)

      const textEls14 = (await cdp.eval(`__bp.els()`)).filter((e) => e.kind === 'text')
      const titleEl14 = textEls14.find((e) => e.text.replace(/\s/g, '').includes('明细清单'))
      const otherEl14 =
        textEls14.find((e) => e.id !== titleEl14?.id && e.text.replace(/\s/g, '').includes('合计条数')) ??
        textEls14.find((e) => e.id !== titleEl14?.id)
      const titlePt14 = titleEl14 ? await cdp.eval(`__bp.pointEl(${JSON.stringify(titleEl14.id)})`) : null
      note('A 组靶子：页级重复区标题 / 反向对照用的另一个文本元素', {
        标题: titleEl14?.id ?? null, 反向对照: otherEl14?.id ?? null, 可命中点: titlePt14,
      })
      if (!titleEl14 || !titlePt14 || !otherEl14) {
        ok('能定位到两个文本元素（页级重复区的标题 + 表尾的合计条数），A 组的前提',
          false, JSON.stringify({ titleEl14: titleEl14?.id ?? null, pt: titlePt14, otherEl14: otherEl14?.id ?? null }))
      } else {
        // ⚠️ 把"改前/改后"读在**同一次 eval** 里，避免两次读数之间夹进别的重排
        const READ_TITLE = `(() => {
          const T = ${JSON.stringify(titleEl14.id)}
          const O = ${JSON.stringify(otherEl14.id)}
          const el = document.querySelector('[data-el-id="' + T + '"]')
          const other = document.querySelector('[data-el-id="' + O + '"]')
          const inner = el ? el.querySelector('.bp-el-text') : null
          const sc = document.querySelector('.bp-tools__scope-text')
          const b = document.querySelector('button[aria-label="加粗"]')
          return {
            innerStyle: inner ? inner.getAttribute('style') : null,
            innerFw: inner ? getComputedStyle(inner).fontWeight : null,
            otherStyle: other ? other.getAttribute('style') : null,
            scope: sc ? (sc.textContent || '').trim() : null,
            boldPressed: b ? b.getAttribute('aria-pressed') : null,
            panel: __bp.panel(),
            elW: !!__bp.num('宽度'),
            paperW: !!__bp.num('纸张宽度'),
            selCount: document.querySelectorAll('.bp-el.is-selected').length,
          }
        })()`

        await clickAt(cdp, titlePt14.x, titlePt14.y, 1)
        await sleep(500)
        const before14 = await cdp.eval(READ_TITLE)
        note('点中标题文本元素后的读数', before14)
        ok('【顶栏】选中一个文本元素 → 作用对象立刻变成「改：整个文本元素」，右栏同步是元素面板（有「宽度」、没有「纸张宽度」）',
          before14?.selCount === 1 && before14?.scope === '改：整个文本元素' &&
            before14?.elW === true && before14?.paperW === false,
          `选中数=${before14?.selCount} 作用对象「${before14?.scope}」 面板「${before14?.panel}」`)

        const boldOn = await cdp.eval(`(() => {
          const b = document.querySelector('button[aria-label="加粗"]')
          if (!b) return { ok: false, why: '找不到顶栏加粗' }
          if (b.disabled) return { ok: false, disabled: true }
          b.click()
          return { ok: true }
        })()`)
        await sleep(500)
        const after14 = await cdp.eval(READ_TITLE)
        note('点顶栏「加粗」前后（读的是元素自己的 style，不是按钮态）',
          { 点击: boldOn, 改前: before14?.innerStyle, 改后: after14?.innerStyle, 计算字重: before14?.innerFw + ' → ' + after14?.innerFw })
        ok('【顶栏·核心】点顶栏「加粗」→ **选中的那个文本元素自己的样式真的变了**（内联样式里的 font-weight 600 消失、计算字重 600→400），不是只把按钮点亮',
          boldOn?.ok === true &&
            /font-weight:\s*600/.test(before14?.innerStyle ?? '') &&
            !/font-weight/.test(after14?.innerStyle ?? '') &&
            after14?.innerFw === '400',
          `改前「${before14?.innerStyle}」→ 改后「${after14?.innerStyle}」（计算字重 ${before14?.innerFw} → ${after14?.innerFw}）`)
        ok('【反向对照】同一次操作里，**没被选中**的另一个文本元素（表尾「合计条数」）的样式一字未改 —— 说明上一条不是"点谁都会动"',
          typeof before14?.otherStyle === 'string' && before14.otherStyle.length > 0 &&
            before14.otherStyle === after14?.otherStyle,
          `表尾元素「${before14?.otherStyle}」→「${after14?.otherStyle}」`)

        const boldBack = await cdp.eval(`(() => {
          const b = document.querySelector('button[aria-label="加粗"]')
          if (!b) return { ok: false }
          b.click()
          return { ok: true }
        })()`)
        await sleep(500)
        const restored14 = await cdp.eval(READ_TITLE)
        note('再点一次「加粗」之后', { 点击: boldBack, innerStyle: restored14?.innerStyle, pressed: restored14?.boldPressed })
        ok('再点一次「加粗」→ 回到原样（font-weight 600 回来了、aria-pressed 回到 true），说明它是可逆的、没把元素写坏',
          boldBack?.ok === true && /font-weight:\s*600/.test(restored14?.innerStyle ?? '') &&
            restored14?.boldPressed === 'true' && restored14?.otherStyle === before14.otherStyle,
          `「${restored14?.innerStyle}」 aria-pressed=${restored14?.boldPressed}`)

        // ============================================================
        // B. 横向 / 纵向：pageSetup 真的变了 + 画布纸张真的对调
        // ============================================================
        await keyPress(cdp, 'Escape')
        await sleep(200)
        await keyPress(cdp, 'Escape')
        await sleep(400)

        const PAGE_PROBE = `(() => {
          const MM = 96 / 25.4
          const paper = document.querySelector('.bp-paper')
          const btn = document.querySelector('button[aria-label^="纸张方向："]')
          const mm = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round((n / MM) * 100) / 100 : null }
          const hintEl = document.querySelector('.bp-panel--inspector')
          const m = hintEl ? ((hintEl.innerText || '').match(/成品尺寸\\s*[\\d.]+×[\\d.]+mm/) || [])[0] : null
          return {
            paperMm: paper ? { w: mm(paper.style.width), h: mm(paper.style.height) } : null,
            paperPx: paper ? { w: paper.style.width, h: paper.style.height } : null,
            orientText: btn ? (btn.textContent || '').replace(/\\s+/g, ' ').trim() : null,
            orientLabel: btn ? btn.getAttribute('aria-label') : null,
            orientPressed: btn ? btn.getAttribute('aria-pressed') : null,
            hint: m,
            scope: (function () { const s = document.querySelector('.bp-tools__scope-text'); return s ? (s.textContent || '').trim() : null })(),
            selCount: document.querySelectorAll('.bp-el.is-selected').length,
          }
        })()`
        const pgBefore14 = await cdp.eval(PAGE_PROBE)
        note('切换前：画布纸张（按未缩放 px 反算 mm）/ 方向按钮 / 右栏「成品尺寸」', pgBefore14)
        ok('（B 组前提）此刻是 A4 纵向：画布纸张 210×297mm、方向按钮写着「纵向」，且没有任何元素被选中',
          Math.abs((pgBefore14?.paperMm?.w ?? 0) - 210) <= 1 && Math.abs((pgBefore14?.paperMm?.h ?? 0) - 297) <= 1 &&
            (pgBefore14?.orientText ?? '').includes('纵向') && pgBefore14?.orientPressed === 'false' &&
            pgBefore14?.selCount === 0,
          `纸张 ${JSON.stringify(pgBefore14?.paperMm)}mm（px ${JSON.stringify(pgBefore14?.paperPx)}）按钮「${pgBefore14?.orientText}」选中数=${pgBefore14?.selCount}`)

        const orientClick14 = await cdp.eval(`(() => {
          const b = document.querySelector('button[aria-label^="纸张方向："]')
          if (!b) return { ok: false, why: '找不到顶栏方向按钮' }
          const before = b.getAttribute('aria-label')
          b.click()
          return { ok: true, before }
        })()`)
        await sleep(800)
        const pgAfter14 = await cdp.eval(PAGE_PROBE)
        note('切换后：画布纸张 / 方向按钮 / 右栏「成品尺寸」', pgAfter14)
        ok('【横向·核心】点顶栏方向按钮 → **画布纸张宽高真的对调**（210×297 → 297×210，按未缩放的 mm 比，不受画布缩放影响）',
          orientClick14?.ok === true &&
            Math.abs((pgAfter14?.paperMm?.w ?? 0) - (pgBefore14?.paperMm?.h ?? -1)) <= 1 &&
            Math.abs((pgAfter14?.paperMm?.h ?? 0) - (pgBefore14?.paperMm?.w ?? -1)) <= 1,
          `${JSON.stringify(pgBefore14?.paperMm)} → ${JSON.stringify(pgAfter14?.paperMm)}mm（px ${JSON.stringify(pgBefore14?.paperPx)} → ${JSON.stringify(pgAfter14?.paperPx)}）`)
        ok('并且按钮自己跟着变成「横向297×210」、aria-label 与 aria-pressed 同步 —— pageSetup.orientation 真的被改了，不是只画了一次',
          (pgAfter14?.orientText ?? '').includes('横向') && /297×210/.test(pgAfter14?.orientText ?? '') &&
            /当前横向/.test(pgAfter14?.orientLabel ?? '') && pgAfter14?.orientPressed === 'true',
          `按钮「${pgAfter14?.orientText}」 aria-label=「${pgAfter14?.orientLabel}」 pressed=${pgAfter14?.orientPressed}`)
        ok('右栏（与顶栏「页面设置」是同一份内容）的「成品尺寸」跟着变成 297×210 —— 版心宽度也真的换了方向（170→257）',
          typeof pgAfter14?.hint === 'string' && /成品尺寸\s*297×210mm/.test(pgAfter14.hint),
          `右栏读数「${pgAfter14?.hint}」（改前「${pgBefore14?.hint}」）`)

        // ---- 页面设置收进顶栏那个按钮，但右栏入口仍在 ----
        const popOpen14 = await cdp.eval(`(() => {
          const b = document.querySelector('button[aria-label="页面设置"]')
          if (!b) return { ok: false }
          b.click()
          return { ok: true }
        })()`)
        await sleep(500)
        const popC14 = await cdp.eval(`(() => {
          const box = document.querySelector('.bp-popover[aria-label="页面设置"]')
          const rightPanelEntry = document.querySelectorAll('.bp-panel--inspector [aria-label="纸张宽度"]').length
          if (!box) return { present: false, rightPanelEntry }
          return {
            present: true,
            width: Math.round(box.getBoundingClientRect().width),
            items: {
              paper: !!box.querySelector('[aria-label="纸张尺寸"]'),
              w: !!box.querySelector('[aria-label="纸张宽度"]'),
              h: !!box.querySelector('[aria-label="纸张高度"]'),
              orient: !!box.querySelector('[aria-label="纸张方向"]'),
              grid: !!box.querySelector('[aria-label="网格间距"]'),
              showGrid: !!box.querySelector('[aria-label="显示网格"]'),
              snap: !!box.querySelector('[aria-label="拖拽时吸附到网格"]'),
            },
            rightPanelEntry,
          }
        })()`)
        note('顶栏「页面设置」弹层里的内容 / 右栏那个入口还在不在', { 打开: popOpen14, 读数: popC14 })
        ok('【页面设置】「页面的相关设置」真的收进了这个按钮里：纸张尺寸 / 纸张宽高 / 方向 / 网格间距 / 显示网格 / 吸附，全在弹层内',
          popOpen14?.ok === true && popC14?.present === true && (popC14?.width ?? 0) >= 200 &&
            popC14.items?.paper === true && popC14.items?.w === true && popC14.items?.h === true &&
            popC14.items?.orient === true && popC14.items?.grid === true &&
            popC14.items?.showGrid === true && popC14.items?.snap === true,
          `弹层宽 ${popC14?.width}px 内含=${JSON.stringify(popC14?.items)}`)
        ok('【反向对照】右栏（页面属性）那个入口**没有被拆掉**：未选中时面板里照样有纸张宽高 —— 是"多了一个入口"，不是"把旧的挪走"',
          popC14?.rightPanelEntry === 1,
          `右栏里 [aria-label="纸张宽度"] 数量=${popC14?.rightPanelEntry}（弹层里还有 1 个，两处是同一个组件渲染的）`)
        await keyPress(cdp, 'Escape')
        await sleep(400)
        const popClosed14 = await cdp.eval(`!document.querySelector('.bp-popover[aria-label="页面设置"]')`)
        note('Esc 之后弹层是否收起', popClosed14)

        // ============================================================
        // C. 字段占位符自己的字体（节点级）+ 打印产物必须跟着变
        // ============================================================
        //
        // ⚠️ 先换一份**刚建出来的干净「通用清单」**，再验预览。
        //
        // 为什么不能接着用上面那份 doc：前面 [2]–[13] 各段是按"把功能拖一遍"来编排的，
        // 到这一步它已经被改得面目全非 —— [12] 把循环区那张数据表往页面下半部拖过、
        // [13] 往空单元格里丢过字段。横向下版心只有 170mm 高，那张表又被推到 y≈95mm，
        // 于是一条记录就占满一页，30 条记录排成 30 页。
        // 预览本身没有错（它照样把 30 页排出来了），但"从点下去到产物就绪"会从
        // 干净骨架的 ~0.3s 涨到几十秒 —— 这条断言会变成在测"极端 doc 下渲染要多久"，
        // 而不是在测"打开的是不是产物本身、字段字体有没有进产物"。
        // 这正是 [11]/[12]/[13] 各自开头都要"从模板卡片重新进入「通用清单」"的原因，
        // 沿用同一套办法：点「完成」回向导 → 新建一份 → 进编辑器。
        // 判据一条没放松（页数、产物内容、KaiTi 计数、反向对照都还是原来那些）。
        await cdp.eval(`__bp.click('button','完成')`)
        await sleep(1400)
        await cdp.eval(`__bp.click('button','＋ 新建模板')`)
        await sleep(800)
        await cdp.eval(`__bp.click('button','视图模板（多条记录一份）')`)
        await sleep(500)
        await cdp.eval(`(() => {
          const it = Array.from(document.querySelectorAll('.sk-item')).find(e => (e.textContent||'').includes('通用清单'))
          if (it) it.click(); return !!it
        })()`)
        await sleep(400)
        await cdp.eval(`__bp.click('button','创建并编辑')`)
        await waitFor(cdp, `__bp.count('.bp-el') > 0`, 12000)
        await sleep(600)
        await cdp.eval(HELPERS)
        const freshC14 = await cdp.eval(PAGE_PROBE)
        note('（C 组前提）换上一份刚建出来的干净「通用清单」', {
          元素数: await cdp.eval(`__bp.count('.bp-el')`),
          纸张: freshC14?.paperMm, 方向: freshC14?.orientText,
        })
        ok('（C 组前提）拿到一份干净的「通用清单」：画布上是 A4 纵向、没有残留选中',
          freshC14?.paperMm?.w === 210 && freshC14?.paperMm?.h === 297 && freshC14?.selCount === 0,
          `纸张 ${JSON.stringify(freshC14?.paperMm)}mm 方向「${freshC14?.orientText}」选中数=${freshC14?.selCount}`)
        // 预览要复现"横向"的闭环（下面那条断言），所以这里再把方向切到横向
        await cdp.eval(`(() => { const b = document.querySelector('button[aria-label^="纸张方向："]'); if (b) b.click(); return !!b })()`)
        await sleep(800)
        const landscapeC14 = await cdp.eval(PAGE_PROBE)
        ok('（C 组前提）干净 doc 上切到横向：纸张 297×210',
          landscapeC14?.paperMm?.w === 297 && landscapeC14?.paperMm?.h === 210,
          `纸张 ${JSON.stringify(landscapeC14?.paperMm)}mm 方向「${landscapeC14?.orientText}」`)

        const chipPick14 = await cdp.eval(`(() => {
          const flat = (s) => String(s || '').replace(/\\s/g, '')
          const chips = Array.from(document.querySelectorAll('.bp-chip[data-node-kind="field"]'))
          const chip = chips.find((c) => flat(c.textContent) === '规格型号')
          if (!chip) return { found: false, texts: chips.map((c) => flat(c.textContent)) }
          chip.scrollIntoView({ block: 'center' })
          const r = chip.getBoundingClientRect()
          for (const fx of [0.5, 0.3, 0.7, 0.44]) {
            for (const fy of [0.5, 0.3, 0.7, 0.44]) {
              const x = Math.round(r.left + r.width * fx)
              const y = Math.round(r.top + r.height * fy)
              if (document.elementFromPoint(x, y) === chip) {
                const host = chip.closest('[data-el-id]')
                return {
                  found: true, x, y,
                  w: Math.round(r.width), h: Math.round(r.height),
                  text: flat(chip.textContent),
                  hostId: host ? host.getAttribute('data-el-id') : null,
                  style: chip.getAttribute('style'),
                }
              }
            }
          }
          const cx = Math.round(r.left + r.width / 2)
          const cy = Math.round(r.top + r.height / 2)
          const by = document.elementFromPoint(cx, cy)
          return {
            found: false, why: 'chip 被盖住或尺寸不可点',
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            by: by ? (by.getAttribute('data-el-id') || String(by.className)) : null,
          }
        })()`)
        note('画布上的字段占位符（要找的是循环区表格里「规格型号」那一枚）',
          { 全部占位符: await cdp.eval(`Array.from(document.querySelectorAll('.bp-chip[data-node-kind="field"]')).map((c) => (c.textContent || '').trim())`), 目标: chipPick14 })
        if (!chipPick14?.found) {
          ok('能在画布上定位到循环区表格里「规格型号」这一枚字段占位符（C 组的前提）', false, JSON.stringify(chipPick14))
        } else {
          await clickAt(cdp, chipPick14.x, chipPick14.y, 1)
          await sleep(600)
          const nodeSel14 = await cdp.eval(`(() => {
            const sel = document.querySelector('.bp-chip.is-node-sel')
            const sc = document.querySelector('.bp-tools__scope-text')
            const panel = document.querySelector('.bp-panel--inspector')
            const title = panel ? panel.querySelector('.bp-panel__title') : null
            return {
              nodeSelCount: document.querySelectorAll('.is-node-sel').length,
              nodeSelText: sel ? (sel.textContent || '').trim() : null,
              scope: sc ? (sc.textContent || '').trim() : null,
              panelTitle: title ? (title.textContent || '').trim() : null,
              panelText: panel ? (panel.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
              hasNodeFont: !!document.querySelector('button[aria-label="这一处的字体"]'),
              hasClear: !!document.querySelector('[aria-label="清除这一处的样式覆写"]'),
              // ⚠️ 节点面板**不能**把它所在那一格的面板顶掉：顶掉之后「单元格内容」输入框就没了，
              // 用户想改那一格的文字得先猜到哪里退出这一层（实测会直接把"点格子改内容"这条链路打断）。
              cellTextarea: !!document.querySelector('textarea[aria-label="单元格内容"]'),
              cellInsertChip: !!document.querySelector('[aria-label="向单元格插入字段占位符"]'),
            }
          })()`)
          note('点中字段占位符之后：节点选中态 / 顶栏作用对象 / 右栏面板', nodeSel14)
          ok('【分层·核心】真实指针点中字段占位符 → 选中的是**这一处节点**（那一枚 chip 拿到 is-node-sel），而不是只选中整表/整格',
            nodeSel14?.nodeSelCount === 1 && nodeSel14?.nodeSelText === '规格型号',
            `节点选中数=${nodeSel14?.nodeSelCount} 选中的是「${nodeSel14?.nodeSelText}」`)
          ok('【分层】顶栏作用对象同步变成「改：字段「规格型号」」，右栏标题是「这一处的样式」并写明**只影响这一格里的这一处**',
            nodeSel14?.scope === '改：字段「规格型号」' &&
              /这一处的样式/.test(nodeSel14?.panelTitle ?? '') &&
              /只影响这一格里的这一处/.test(nodeSel14?.panelText ?? ''),
            `顶栏「${nodeSel14?.scope}」/ 面板标题「${nodeSel14?.panelTitle}」/ 面板「${nodeSel14?.panelText}」`)
          ok('【分层】这一层真的有「字体」入口，并且能一键清掉覆写 —— 改前用户抱怨的正是"无法对字段内容进行字体的设置"',
            nodeSel14?.hasNodeFont === true && nodeSel14?.hasClear === true,
            `这一处的字体=${nodeSel14?.hasNodeFont} 清除覆写=${nodeSel14?.hasClear}`)
          ok('【分层】节点那一层**不会把它所在那一格的面板顶掉**：此刻「单元格内容」输入框和「插入占位符」都还在（改内容不用先退出这一层）',
            nodeSel14?.cellTextarea === true && nodeSel14?.cellInsertChip === true,
            `单元格内容输入框=${nodeSel14?.cellTextarea} 向单元格插入占位符=${nodeSel14?.cellInsertChip}`)

          const fontOpen14 = await cdp.eval(`(() => {
            const t = document.querySelector('button[aria-label="这一处的字体"]')
            if (!t) return { ok: false }
            const label = t.querySelector('.bp-picker__label')
            const before = label ? (label.textContent || '').trim() : null
            t.click()
            return { ok: true, before }
          })()`)
          await sleep(500)
          const fontPick14 = await cdp.eval(`(() => {
            const opts = Array.from(document.querySelectorAll('.bp-popover[role="listbox"] .bp-picker__opt'))
            const hit = opts.find((b) => (b.textContent || '').trim() === '楷体')
            if (!hit) return { ok: false, opts: opts.map((b) => (b.textContent || '').trim()) }
            hit.click()
            return { ok: true }
          })()`)
          await sleep(600)
          const fontAfter14 = await cdp.eval(`(() => {
            const chip = document.querySelector('.bp-chip.is-node-sel')
            const t = document.querySelector('button[aria-label="这一处的字体"]')
            const label = t ? t.querySelector('.bp-picker__label') : null
            const all = Array.from(document.querySelectorAll('.bp-chip'))
            return {
              chipText: chip ? (chip.textContent || '').trim() : null,
              chipStyle: chip ? chip.getAttribute('style') : null,
              chipComputed: chip ? getComputedStyle(chip).fontFamily : null,
              trigger: label ? (label.textContent || '').trim() : null,
              chipsWithKai: all.filter((c) => /KaiTi/.test(c.getAttribute('style') || '')).map((c) => (c.textContent || '').trim()),
              chipTotal: all.length,
            }
          })()`)
          note('把「这一处的字体」设成楷体之后的读数', { 展开: fontOpen14, 选中: fontPick14, 结果: fontAfter14 })
          ok('把「这一处的字体」设成楷体 → **这一枚 chip 自己的内联样式里出现了 KaiTi**（画布这一层先成立）',
            fontPick14?.ok === true && fontAfter14?.chipText === '规格型号' && /KaiTi/.test(fontAfter14?.chipStyle ?? ''),
            `chip style=「${fontAfter14?.chipStyle}」 计算字体=${fontAfter14?.chipComputed} 下拉回显「${fontAfter14?.trigger}」`)
          ok('【分层·反向对照】改的是**节点级**：整张画布上只有这一枚 chip 带上了楷体，同格其它文字、其它格子、其它元素的都没跟着变',
            Array.isArray(fontAfter14?.chipsWithKai) && fontAfter14.chipsWithKai.length === 1 &&
              fontAfter14.chipsWithKai[0] === '规格型号',
            `带上楷体的占位符=${JSON.stringify(fontAfter14?.chipsWithKai)}（画布上共 ${fontAfter14?.chipTotal} 枚占位符，改前触发值「${fontOpen14?.before}」）`)

          // 顺带记一笔：这份 doc 上循环区那张数据表落在版面的哪、多高，直接决定"30 条记录排几页"。
          // 不读这一笔，"预览排了几页"看着会没头没脑（它是被纸张方向与表格位置共同决定的）。
          // 这里只记不给判据 —— 判据在下面按"产物本身自洽"来定。
          const loopGeom14 = await cdp.eval(`(() => {
            const MM = 96 / 25.4
            const mm = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round((n / MM) * 10) / 10 : null }
            const els = Array.from(document.querySelectorAll('.bp-el--table'))
            if (!els.length) return { tables: 0 }
            const last = els[els.length - 1]
            return {
              tables: els.length,
              '循环区那张表的 top/height/width(mm)': {
                top: mm(last.style.top), height: mm(last.style.height), width: mm(last.style.width),
              },
              '高度模式': last.style.height ? '固定值' : '自动',
              '纸张(mm)': (function () {
                const p = document.querySelector('.bp-paper')
                return p ? { w: mm(p.style.width), h: mm(p.style.height) } : null
              })(),
            }
          })()`)
          note('打开预览前：循环区那张数据表在版面上的位置与尺寸（它决定这批记录会排成几页）', loopGeom14)
          // ---- 打开「在此页面预览打印效果」：看的必须是 renderDocument 的产物 ----
          const prevOpen14 = await cdp.eval(`(() => {
            const b = document.querySelector('button[aria-label="预览打印效果"]')
            if (!b) return { ok: false }
            b.click()
            return { ok: true }
          })()`)
          // 从"点下去"到"产物就绪"的真实耗时。
          // 为什么要把这个数报出来：这一段的产物是 30 条记录排出来的多页 HTML，是这套管线里最重的一次；
          // 有一次在机器忙碌时它 >25s 都出不来（`waitFor` 直接判红），光看 PASS/FAIL 分不清是"坏了"还是"慢了"。
          // 上限放到 60s 只是为了拿到真实数字，断言本身没有放松（页数/内容/字体那几条一条没少）。
          const prevT0 = Date.now()
          const rendered14 = await waitFor(cdp, `(() => {
            const f = document.querySelector('.bp-preview__frame')
            return !!(f && f.contentDocument && f.contentDocument.querySelectorAll('section.bp-page').length > 0)
          })()`, 60000, 500)
          note('预览：从点「预览」到产物就绪的耗时', { ready: !!rendered14, ms: Date.now() - prevT0 })
          const product14 = await cdp.eval(`(() => {
            const f = document.querySelector('.bp-preview__frame')
            const wrap = document.querySelector('.bp-preview')
            const meta = document.querySelector('.bp-preview__meta')
            const noteEl = document.querySelector('.bp-preview__note')
            const errEl = document.querySelector('.bp-preview__error')
            const base = {
              dialog: !!wrap && wrap.getAttribute('role') === 'dialog',
              frame: !!f,
              busy: !!document.querySelector('.bp-preview__busy'),
              error: errEl ? (errEl.textContent || '').trim() : null,
              meta: meta ? (meta.textContent || '').replace(/\\s+/g, ' ').trim() : null,
              note: noteEl ? (noteEl.textContent || '').replace(/\\s+/g, ' ').trim() : null,
            }
            let d = null
            try { d = f && f.contentDocument } catch (e) { d = null }
            if (!d) return Object.assign({}, base, { docReadable: false })
            const pages = d.querySelectorAll('section.bp-page').length
            const spans = Array.from(d.querySelectorAll('span'))
            const styled = spans.filter((s) => /KaiTi/.test(s.getAttribute('style') || ''))
            const specs = spans.filter((s) => /^BTN-[ABC]-\\d+$/.test((s.textContent || '').trim()))
            const titleLeaves = Array.from(d.querySelectorAll('*')).filter((x) => x.children.length === 0 && /明细清单/.test((x.textContent || '').replace(/\\s/g, '')))
            return Object.assign({}, base, {
              docReadable: true,
              pages,
              htmlLen: d.documentElement ? d.documentElement.outerHTML.length : 0,
              firstPageW: d.querySelector('section.bp-page') ? d.querySelector('section.bp-page').style.width : null,
              spanTotal: spans.length,
              titleLeafCount: titleLeaves.length,
              titleHasKai: titleLeaves.filter((x) => /KaiTi/.test(x.getAttribute('style') || '')).length,
              kaiCount: styled.length,
              kaiTexts: styled.slice(0, 3).map((s) => (s.textContent || '').trim()),
              kaiStyle: styled.length ? styled[0].getAttribute('style') : null,
              specCount: specs.length,
              specWithKai: specs.filter((s) => /KaiTi/.test(s.getAttribute('style') || '')).length,
              specWithoutKai: specs.filter((s) => !/KaiTi/.test(s.getAttribute('style') || '')).length,
              specTexts: specs.slice(0, 3).map((s) => (s.textContent || '').trim()),
            })
          })()`)
          note('预览产物读数（这一份就是打印出去的那一份）', product14)
          ok('【预览·核心】点顶栏「预览」打开的是**渲染产物本身**：iframe 里装着 renderDocument 排出来的页面（多页 section.bp-page + 大量真实内容），不是另排一次版的简图',
            prevOpen14?.ok === true && rendered14 === true && product14?.docReadable === true &&
              (product14?.pages ?? 0) >= 2 && (product14?.htmlLen ?? 0) > 15000 && (product14?.spanTotal ?? 0) >= 60,
            `页数=${product14?.pages} 产物长度=${product14?.htmlLen} 字节 span=${product14?.spanTotal} 首页宽=${product14?.firstPageW}`)
          /*
           * 【定点修改 a】面板 meta 的「N 页」必须**等于** iframe 里真正排出来的纸数。
           *
           * 原来这一条测的是"那句文案在不在"：`PreviewPane.tsx` 里「这一份就是打印出去的那一份
           * （同一套排版管线）」是**硬编码的 JSX 文案**（整句话里只有 `result.source` 是动态的），
           * 所以它测不出"面板说的话是不是真的" —— 变异 `preview-empty`（iframe 里一张纸都没有）
           * 之下它照样是绿的：面板说 4 页，iframe 里 0 张，而断言只看那句字还在不在。
           *
           * 改成"读数对齐"之后就有了牙：面板说几页，就得真有那几张纸。
           */
          const metaPages = Number((/(\d+)\s*页/.exec(product14?.meta ?? '') ?? [])[1])
          ok('【预览·承重】面板 meta 里的「N 页」必须等于 iframe 里真正排出来的 section.bp-page 条数 —— 面板说几页就得有几张纸',
            Number.isFinite(metaPages) && metaPages === product14?.pages,
            `面板 meta=「${product14?.meta}」→ 解析出 ${metaPages} 页；iframe 里 section.bp-page=${product14?.pages} 张`)

          // 【定点修改 a·单列出来的存在性那半句】
          // 「那句话还在」仍然要有人管（它被删掉也是缺陷），但它**只能证明这半句字还在**，
          // 证明不了预览是好的 —— 所以从这里单列出来，判据（读数对齐）在上一行。
          // 行为由上面那条【预览·承重】覆盖；本条只保证文案存在性
          ok('【预览·存在性】面板里仍然写着「这一份就是打印出去的那一份（同一套排版管线）」，且没有走到失败/加载中分支（本条只保证文案还在）',
            /同一套排版管线/.test(product14?.note ?? '') && product14?.error === null && product14?.busy === false,
            `面板「${product14?.note}」error=${JSON.stringify(product14?.error)} busy=${product14?.busy}`)
          ok('【横向·闭环】预览的页尺寸跟着刚才切的横向走（297×210mm）—— 说明预览读的就是当前这份 doc 的 pageSetup，不是另一份快照',
            /297×210mm/.test(product14?.meta ?? ''),
            `预览读数「${product14?.meta}」`)

          // ---- 本节最承重的一条：到**打印产物**里读那一个字段的值 ----
          ok('【承重·打印产物】打印产物里那个字段的**值**真的带上了这一处设的字体：值形如 BTN-x-1000 的 span 全部带 font-family:KaiTi',
            (product14?.specCount ?? 0) >= 10 && product14?.specCount === product14?.specWithKai,
            `产物里「规格型号」的值 ${product14?.specCount} 个（${JSON.stringify(product14?.specTexts)}…），其中带 KaiTi 的 ${product14?.specWithKai} 个 / 没带上的 ${product14?.specWithoutKai} 个；样例 style=「${product14?.kaiStyle}」`)
          ok('【反向对照·产物】同一份产物里**别的文字没有跟着变楷体**：带 KaiTi 的 span 数恰好等于该字段值的个数，标题「明 细 清 单」不在其中',
            product14?.kaiCount === product14?.specCount && product14?.titleHasKai === 0 &&
              Array.isArray(product14?.kaiTexts) && product14.kaiTexts.every((t) => /^BTN-[ABC]-/.test(t)),
            `带 KaiTi 的 span ${product14?.kaiCount} 个 = 字段值 ${product14?.specCount} 个；带楷体的文本前 3 个=${JSON.stringify(product14?.kaiTexts)}；标题节点带楷体的个数=${product14?.titleHasKai}（标题叶子节点 ${product14?.titleLeafCount} 个）`)

          // ---- 关掉预览，把这一处改回「跟随外层」，并切回纵向 ----
          const prevClose14 = await cdp.eval(`(() => {
            const b = document.querySelector('button[aria-label="关闭预览"]')
            if (!b) return { ok: false }
            b.click()
            return { ok: true }
          })()`)
          await sleep(600)
          const prevGone14 = await cdp.eval(`!document.querySelector('.bp-preview')`)
          ok('点「关闭」→ 预览浮层收起（不残留一个挡住画布的层）',
            prevClose14?.ok === true && prevGone14 === true,
            `关闭按钮=${JSON.stringify(prevClose14)} 浮层是否还在=${!prevGone14}`)

          const fontClearOpen = await cdp.eval(`(() => {
            const t = document.querySelector('button[aria-label="这一处的字体"]')
            if (!t) return { ok: false, why: '节点选中没了' }
            const label = t.querySelector('.bp-picker__label')
            const before = label ? (label.textContent || '').trim() : null
            t.click()
            return { ok: true, before }
          })()`)
          await sleep(500)
          const fontClearPick = await cdp.eval(`(() => {
            const opts = Array.from(document.querySelectorAll('.bp-popover[role="listbox"] .bp-picker__opt'))
            const hit = opts.find((b) => (b.textContent || '').trim() === '跟随外层')
            if (!hit) return { ok: false, opts: opts.map((b) => (b.textContent || '').trim()) }
            hit.click()
            return { ok: true }
          })()`)
          await sleep(600)
          const chipRestored14 = await cdp.eval(`(() => {
            const chip = document.querySelector('.bp-chip.is-node-sel')
            const all = Array.from(document.querySelectorAll('.bp-chip'))
            const clear = document.querySelector('[aria-label="清除这一处的样式覆写"]')
            const panel = document.querySelector('.bp-panel--inspector')
            return {
              chipText: chip ? (chip.textContent || '').trim() : null,
              chipStyle: chip ? chip.getAttribute('style') : null,
              chipsWithKai: all.filter((c) => /KaiTi/.test(c.getAttribute('style') || '')).length,
              clearDisabled: clear ? !!clear.disabled : null,
              noOverrideHint: panel ? /还没有任何覆写/.test(panel.innerText || '') : false,
            }
          })()`)
          note('把这一处改回「跟随外层」之后', { 展开: fontClearOpen, 选中: fontClearPick, 结果: chipRestored14 })
          ok('【反向对照·可逆】这一处改回「跟随外层」→ chip 自己的 KaiTi 消失、「清除覆写」回到禁用、面板明说"还没有任何覆写"（改的是节点级，也能原样退回去）',
            fontClearPick?.ok === true && fontClearOpen?.before === '楷体' &&
              !/KaiTi/.test(chipRestored14?.chipStyle ?? '') &&
              chipRestored14?.clearDisabled === true && chipRestored14?.noOverrideHint === true,
            `chip style=「${chipRestored14?.chipStyle}」 画布上带楷体的占位符=${chipRestored14?.chipsWithKai} 个 清除键禁用=${chipRestored14?.clearDisabled}`)

          /*
           * 【定点修改 b】判据收成「**第二次点击前后状态必须不同**」。
           *
           * 原来这一条测的是"再点一次 → 回到 210×297、按钮回到「纵向」"，而变异
           * `orient-ui-only`（只改按钮文案、不真动 pageSetup）之下它**恒真**：
           * 第一次点击后纸张压根没变（还是 210×297），第二次点击后当然还是 210×297 ——
           * "回到纵向"照样成立，因为它就从来没离开过纵向。
           *
           * 所以点前那份读数是**紧挨着点击现量的**（不引用别处的旧读数：那样一旦中间
           * 有别的操作插进来，比的就是两个不同时刻的状态，"前后不同"就不再是这件事本身）。
           */
          const orientBefore14 = await cdp.eval(PAGE_PROBE)
          const orientBack14 = await cdp.eval(`(() => {
            const b = document.querySelector('button[aria-label^="纸张方向："]')
            if (!b) return { ok: false }
            b.click()
            return { ok: true }
          })()`)
          await sleep(800)
          const backPortrait14 = await cdp.eval(PAGE_PROBE)
          note('再点一次方向按钮（切回纵向）', { 点击: orientBack14, 点前: orientBefore14, 点后: backPortrait14 })
          const ob = orientBefore14?.paperMm ?? null
          const oa = backPortrait14?.paperMm ?? null
          const orientChanged = !!ob && !!oa && (Math.abs(ob.w - oa.w) > 1 || Math.abs(ob.h - oa.h) > 1)
          ok('【反向对照·横纵向】第二次点方向按钮**前后状态必须不同**（点前 297×210 → 点后 210×297）—— 切换是双向的，不是只画了一次',
            orientBack14?.ok === true && orientChanged &&
              Math.abs((oa?.w ?? 0) - 210) <= 1 && Math.abs((oa?.h ?? 0) - 297) <= 1 &&
              (backPortrait14?.orientText ?? '').includes('纵向'),
            `点前 ${JSON.stringify(ob)}mm「${orientBefore14?.orientText}」→ 点后 ${JSON.stringify(oa)}mm「${backPortrait14?.orientText}」，前后不同=${orientChanged}`)
        }

        // ============================================================
        // D. 窄侧栏（380px）：顶栏不许塌
        // ============================================================
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 820, deviceScaleFactor: 1, mobile: false })
        // 布局断点是 ResizeObserver 算的，机器一忙就会晚一拍（实测踩过：读到的还是宽档 full/wide）。
        // 这里只等"它算过一次"；万一还没算，就补一次窗口尺寸变化的通知再等 ——
        // 等的是时机，判据仍然要求结果必须是 compact，没有放松。
        const COMPACT_Q = `(() => {
          const t = document.querySelector('.bp-tools')
          return !!t && t.getAttribute('data-tools') === 'compact'
        })()`
        let narrowSettled = await waitFor(cdp, COMPACT_Q, 6000, 200)
        if (!narrowSettled) {
          await cdp.eval(`window.dispatchEvent(new Event('resize'))`)
          narrowSettled = await waitFor(cdp, COMPACT_Q, 6000, 200)
        }
        if (!narrowSettled) await sleep(400)
        const narrow14 = await cdp.eval(`(() => {
          const q = (s) => document.querySelector(s)
          const t = q('.bp-tools')
          const tb = t ? t.getBoundingClientRect() : null
          const pv = q('button[aria-label="预览打印效果"]')
          const pr = pv ? pv.getBoundingClientRect() : null
          const vw = window.innerWidth
          const ed = q('.bp-editor')
          return {
            vw,
            mode: t ? t.getAttribute('data-tools') : null,
            layout: ed ? ed.getAttribute('data-layout') : null,
            // 断点是量容器算出来的：把容器自己的宽度也读出来，
            // 这样"档位没切"到底是"没量到"还是"量到了却是另一个值"能一眼分开
            edClientW: ed ? ed.clientWidth : null,
            edCount: document.querySelectorAll('.bp-editor').length,
            docW: document.documentElement.clientWidth,
            left: tb ? Math.round(tb.left) : null,
            right: tb ? Math.round(tb.right) : null,
            h: tb ? Math.round(tb.height) : null,
            overflow: tb ? Math.round(tb.right - vw) : null,
            previewInView: !!pr && pr.width > 0 && pr.left >= -1 && pr.right <= vw + 1,
            previewBox: pr ? { l: Math.round(pr.left), r: Math.round(pr.right) } : null,
            textPopBtn: !!q('button[aria-label="文字设置"]'),
            inlineBold: !!q('button[aria-label="加粗"]'),
            undoBox: (function () {
              const b = q('.bp-tools [aria-label="撤销"]')
              if (!b) return null
              const r = b.getBoundingClientRect()
              return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }
            })(),
            scope: (function () { const s = q('.bp-tools__scope-text'); return s ? (s.textContent || '').trim() : null })(),
            metaCount: (document.body.innerText.match(/\\d+\\s*个元素/g) || []).length,
          }
        })()`)
        note('380px 侧栏下的顶栏读数', narrow14)
        ok('【窄侧栏 380px】顶栏没有塌：工具区不横向溢出、预览按钮完整落在可视区内（改前它被推出可视区）',
          narrow14?.mode === 'compact' && typeof narrow14?.overflow === 'number' && narrow14.overflow <= 1 &&
            narrow14?.previewInView === true,
          `宽度=${narrow14?.vw} 工具区 ${narrow14?.left}~${narrow14?.right}px（溢出 ${narrow14?.overflow}px）预览按钮 ${JSON.stringify(narrow14?.previewBox)} 工具行高=${narrow14?.h}px 布局=${narrow14?.layout}（容器 ${narrow14?.edClientW}px / 视口 ${narrow14?.docW}px / 编辑器实例 ${narrow14?.edCount} 个）`)
        ok('【窄侧栏】文本编辑没有丢：一屏放不下时收进「文字设置」弹层（收起而不是删掉），作用对象那枚标签还在',
          narrow14?.textPopBtn === true && narrow14?.inlineBold === false &&
            /^改：/.test(narrow14?.scope ?? ''),
          `「文字设置」按钮=${narrow14?.textPopBtn} 行内「加粗」=${narrow14?.inlineBold} 作用对象「${narrow14?.scope}」 页面里"个元素"读数出现 ${narrow14?.metaCount} 次`)

        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
        // 和上面窄档同款：先用 ResizeObserver 那条路等，等不到就补一次窗口尺寸变化的通知。
        // 为什么要补：宿主改侧栏宽度靠的是"把 iframe 拉宽/拉窄"，落到插件里就是一次 window resize。
        // `Emulation.setDeviceMetricsOverride` 改的是视口，不保证每次都派发 DOM resize，
        // 而真机上是会派的 —— 所以这里补这一下是**还原真实条件**，不是给实现放水。
        const FULL_Q = `(() => {
          const t = document.querySelector('.bp-tools')
          return !!t && t.getAttribute('data-tools') === 'full'
        })()`
        let wideSettled = await waitFor(cdp, FULL_Q, 6000, 200)
        if (!wideSettled) {
          await cdp.eval(`window.dispatchEvent(new Event('resize'))`)
          wideSettled = await waitFor(cdp, FULL_Q, 6000, 200)
        }
        if (!wideSettled) await sleep(400)
        const wideBack14 = await cdp.eval(`(() => {
          const t = document.querySelector('.bp-tools')
          return { mode: t ? t.getAttribute('data-tools') : null, inlineBold: !!document.querySelector('button[aria-label="加粗"]') }
        })()`)
        ok('把侧栏宽度还原成宽屏后，文本编辑那几个控件回到顶栏上（不是"一旦收起就再也回不来"）',
          wideBack14?.mode === 'full' && wideBack14?.inlineBold === true,
          JSON.stringify(wideBack14))

        // ============================================================
        // E. 系统变量自己的参数（时间格式 / 要不要「共 N 页」）
        // ============================================================
        // 渲染层早就吃 `InlineSysVar.format` 与 `hideTotal` 了（记号和默认值都写在 lib/types.ts，
        // 渲染在 render/html.ts 的 resolveSysVar），但编辑器里一直**没有入口** ——
        // 用户能看到「页码 / 总页数」这种合并形态，却没法单独关掉「共 N 页」。
        // 这一组验的就是"入口在、而且改出来的东西真的进了打印产物"，同样不看控件样式只看产物。
        await keyPress(cdp, 'Escape')
        await sleep(300)
        await keyPress(cdp, 'Escape')
        await sleep(400)

        /**
         * 左侧面板页签切换。`[13]` 段里那份 `switchPalette` 定义在它自己的作用域里，
         * 这一段看不见 —— 所以这里放一份同款（纯新增，不动上面那份）。
         *
         * ⚠️ 它与 `[13]` 段那份**逐字相同**，改一处必须对照改另一处 ——
         * 见文件头的「同名小工具跨段清单」。
         */
        const switchPalette14 = async (label) => {
          const r = await cdp.eval(`(() => {
            const host = document.querySelector('[aria-label="插入面板"]') || document.querySelector('.bp-tabs')
            if (!host) return { ok: false, why: '找不到插入面板页签' }
            const b = Array.from(host.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)})
            if (b) b.click()
            return { ok: !!b, items: Array.from(host.querySelectorAll('button')).map((x) => (x.textContent || '').trim()) }
          })()`)
          await sleep(450)
          return r
        }

        /** 打开预览 → 等产物就绪 → 在产物里数几类节点 → 关掉。返回 null 表示没打开/没就绪 */
        const withProduct = async (label, expr) => {
          await cdp.eval(`(() => { const b = document.querySelector('button[aria-label="预览打印效果"]'); if (b) b.click(); return !!b })()`)
          const ready = await waitFor(cdp, `(() => {
            const f = document.querySelector('.bp-preview__frame')
            return !!(f && f.contentDocument && f.contentDocument.querySelectorAll('section.bp-page').length > 0)
          })()`, 45000, 400)
          const got = ready
            ? await cdp.eval(`(() => {
                const f = document.querySelector('.bp-preview__frame')
                let d = null
                try { d = f && f.contentDocument } catch (e) { d = null }
                if (!d) return { docReadable: false }
                return Object.assign({ docReadable: true, pages: d.querySelectorAll('section.bp-page').length }, (${expr})(d))
              })()`)
            : { ready: false }
          await cdp.eval(`(() => { const b = document.querySelector('button[aria-label="关闭预览"]'); if (b) b.click(); return !!b })()`)
          await sleep(400)
          note(`产物读数 · ${label}`, got)
          return got
        }

        const tabEl14 = await switchPalette14('元素')
        const paletteNames14 = await cdp.eval(`Array.from(document.querySelectorAll('.bp-chip-item__name')).map((e) => (e.textContent || '').trim())`)
        note('左侧「元素」页签里的系统变量清单', { 页签: tabEl14, 清单: paletteNames14 })
        ok('【系统变量】面板里看得到「页码 / 总页数」这一项（把页码与页数合并成一句的那种形态，之前只在骨架里出现过、面板里没有）',
          Array.isArray(paletteNames14) && paletteNames14.includes('页码 / 总页数'),
          `页签=${JSON.stringify(tabEl14)} 面板共 ${(paletteNames14 ?? []).length} 项：${JSON.stringify(paletteNames14)}`)

        // 改前的产物：表头那串「打印日期」此刻是纯 YYYY-MM-DD
        const dateProbe = `(function (d) {
          const spans = Array.from(d.querySelectorAll('span'))
          const iso = spans.map((s) => (s.textContent || '').trim()).filter((t) => /^\\d{4}-\\d{2}-\\d{2}/.test(t))
          return { iso: iso.slice(0, 4), isoCount: iso.length, withWeekday: iso.filter((t) => /星期/.test(t)).length }
        })`
        const beforeDate = await withProduct('改格式之前', dateProbe)

        const dateChip14 = await cdp.eval(`(() => {
          const flat = (s) => String(s || '').replace(/\\s/g, '')
          const all = Array.from(document.querySelectorAll('.bp-chip[data-node-kind="sysvar"]'))
          const c = all.find((x) => flat(x.textContent) === '当前日期')
          if (!c) return { found: false, texts: all.map((x) => flat(x.textContent)) }
          c.scrollIntoView({ block: 'center' })
          const r = c.getBoundingClientRect()
          for (const fx of [0.5, 0.3, 0.7, 0.44]) {
            for (const fy of [0.5, 0.3, 0.7, 0.44]) {
              const x = Math.round(r.left + r.width * fx)
              const y = Math.round(r.top + r.height * fy)
              if (document.elementFromPoint(x, y) === c) return { found: true, x, y, text: flat(c.textContent) }
            }
          }
          return { found: false, why: '被盖住' }
        })()`)
        if (!dateChip14?.found) {
          ok('能在画布上点中表头那枚「当前日期」系统变量（E 组的前提）', false, JSON.stringify(dateChip14))
        } else {
          await clickAt(cdp, dateChip14.x, dateChip14.y, 1)
          await sleep(600)
          const sysPanel14 = await cdp.eval(`(() => {
            const p = document.querySelector('.bp-panel--inspector')
            return {
              text: p ? (p.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 220) : null,
              hasContentSection: !!(p && /这一处的内容/.test(p.innerText || '')),
              hasFormat: !!document.querySelector('button[aria-label="这一处的时间格式"]'),
              hasHideTotal: !!document.querySelector('[aria-label="显示总页数"]'),
              scope: (function () { const s = document.querySelector('.bp-tools__scope-text'); return s ? (s.textContent || '').trim() : null })(),
            }
          })()`)
          note('点中「当前日期」之后的右栏', sysPanel14)
          ok('【系统变量】点中时间类变量 → 这一层多出「这一处的内容 / 时间格式」入口；【反向对照】同一层里**不出现**「显示总页数」（那是合并形态才有的开关，不该乱给）',
            sysPanel14?.hasContentSection === true && sysPanel14?.hasFormat === true && sysPanel14?.hasHideTotal === false,
            `面板=${JSON.stringify({ 内容段: sysPanel14?.hasContentSection, 时间格式: sysPanel14?.hasFormat, 显示总页数: sysPanel14?.hasHideTotal })} 作用对象「${sysPanel14?.scope}」`)

          const fmtPick14 = await cdp.eval(`(() => {
            const t = document.querySelector('button[aria-label="这一处的时间格式"]')
            if (!t) return { ok: false }
            const label = t.querySelector('.bp-picker__label')
            const before = label ? (label.textContent || '').trim() : null
            t.click()
            return { ok: true, before }
          })()`)
          await sleep(500)
          const fmtChoose14 = await cdp.eval(`(() => {
            const opts = Array.from(document.querySelectorAll('.bp-popover[role="listbox"] .bp-picker__opt'))
            const hit = opts.find((b) => (b.textContent || '').trim() === '2026-09-16 星期三')
            if (!hit) return { ok: false, opts: opts.map((b) => (b.textContent || '').trim()) }
            hit.click()
            return { ok: true }
          })()`)
          await sleep(600)
          const fmtAfter14 = await cdp.eval(`(() => {
            const t = document.querySelector('button[aria-label="这一处的时间格式"]')
            const label = t ? t.querySelector('.bp-picker__label') : null
            return { trigger: label ? (label.textContent || '').trim() : null }
          })()`)
          note('选「2026-09-16 星期三」这一档', { 展开: fmtPick14, 选中: fmtChoose14, 结果: fmtAfter14 })
          const afterDate = await withProduct('改格式之后', dateProbe)
          ok('【系统变量·承重】把这一处的时间格式设成「YYYY-MM-DD dddd」→ **打印产物里那串日期真的跟着变了**：改前是纯「2026-09-17」，改后带上「星期四」，而且**每一页的表头都变了**（说明改的是节点、不是某一份快照）',
            fmtChoose14?.ok === true &&
              typeof beforeDate?.iso?.[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(beforeDate.iso[0]) &&
              beforeDate.withWeekday === 0 &&
              Array.isArray(afterDate?.iso) && afterDate.iso.length === beforeDate.isoCount &&
              afterDate.withWeekday === afterDate.isoCount && afterDate.isoCount > 0 &&
              /^\d{4}-\d{2}-\d{2} 星期[日一二三四五六]$/.test(afterDate.iso[0]),
            `改前 ${JSON.stringify(beforeDate?.iso)}（带星期 ${beforeDate?.withWeekday}/${beforeDate?.isoCount}）；改后 ${JSON.stringify(afterDate?.iso)}（带星期 ${afterDate?.withWeekday}/${afterDate?.isoCount}）`)

          // ---- 合并形态：把「页码 / 总页数」放进一个单元格，再开关「共 N 页」 ----
          const cellE = await cdp.eval(`(() => {
            const tbls = Array.from(document.querySelectorAll('.bp-el-table'))
            const t = tbls[tbls.length - 1]
            if (!t) return null
            const tds = Array.from(t.querySelectorAll('td'))
            const td = tds[4] || tds[tds.length - 1]
            if (!td) return null
            td.scrollIntoView({ block: 'center' })
            const r = td.getBoundingClientRect()
            return { cellId: td.getAttribute('data-cell-id'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
          })()`)
          if (!cellE) {
            ok('（E 组前提）能定位到循环区表格的一个单元格', false, '没找到 td')
          } else {
            await clickAt(cdp, cellE.x, cellE.y, 1)
            await sleep(500)
            const typedE = await cdp.eval(`(() => {
              const ta = document.querySelector('textarea[aria-label="单元格内容"]')
              if (!ta) return { ok: false, why: '没有「单元格内容」输入框' }
              const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
              proto.set.call(ta, '【页码 / 总页数】')
              ta.dispatchEvent(new Event('input', { bubbles: true }))
              return { ok: true }
            })()`)
            await sleep(700)
            const chipE = await cdp.eval(`(() => {
              const td = document.querySelector('td[data-cell-id=${JSON.stringify(cellE.cellId)}]')
              if (!td) return null
              const c = td.querySelector('.bp-chip[data-node-kind="sysvar"]')
              if (!c) return { found: false, html: (td.textContent || '').trim() }
              const r = c.getBoundingClientRect()
              c.scrollIntoView({ block: 'center' })
              const r2 = c.getBoundingClientRect()
              return { found: true, text: (c.textContent || '').trim(), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r2.top) }
            })()`)
            note('在单元格里敲「【页码 / 总页数】」', { 输入: typedE, 结果: chipE })
            ok('【系统变量】在单元格里敲「【页码 / 总页数】」→ 它变成了**活的系统变量节点**（不是一段字面文本）',
              typedE?.ok === true && chipE?.found === true && chipE.text === '页码 / 总页数',
              `输入=${JSON.stringify(typedE)} 格子里读到=${JSON.stringify(chipE)}`)

            if (chipE?.found) {
              const cPoint = await cdp.eval(`(() => {
                const td = document.querySelector('td[data-cell-id=${JSON.stringify(cellE.cellId)}]')
                const c = td && td.querySelector('.bp-chip[data-node-kind="sysvar"]')
                if (!c) return null
                c.scrollIntoView({ block: 'center' })
                const r = c.getBoundingClientRect()
                for (const fx of [0.5, 0.3, 0.7, 0.44]) {
                  for (const fy of [0.5, 0.3, 0.7, 0.44]) {
                    const x = Math.round(r.left + r.width * fx)
                    const y = Math.round(r.top + r.height * fy)
                    if (document.elementFromPoint(x, y) === c) return { x, y }
                  }
                }
                return null
              })()`)
              if (!cPoint) {
                ok('（E 组前提）能点中刚插入的「页码 / 总页数」', false, '被盖住')
              } else {
                await clickAt(cdp, cPoint.x, cPoint.y, 1)
                await sleep(600)
                const hidePanel = await cdp.eval(`(() => {
                  const b = document.querySelector('[aria-label="显示总页数"]')
                  return {
                    hasHideTotal: !!b,
                    checked: b ? b.getAttribute('aria-checked') : null,
                    hasFormat: !!document.querySelector('button[aria-label="这一处的时间格式"]'),
                    scope: (function () { const s = document.querySelector('.bp-tools__scope-text'); return s ? (s.textContent || '').trim() : null })(),
                  }
                })()`)
                note('点中「页码 / 总页数」之后的右栏', hidePanel)
                ok('【系统变量】点中合并形态 → 这一层给出「显示总页数」开关（默认开）；【反向对照】同时**不给**「时间格式」（它取的是第几页，没有格式可言）',
                  hidePanel?.hasHideTotal === true && hidePanel?.checked === 'true' && hidePanel?.hasFormat === false,
                  `开关=${hidePanel?.hasHideTotal} 默认=${hidePanel?.checked} 时间格式=${hidePanel?.hasFormat} 作用对象「${hidePanel?.scope}」`)

                const pagerProbe = `(function (d) {
                  const texts = Array.from(d.querySelectorAll('span')).map((s) => (s.textContent || '').trim())
                  return {
                    combined: texts.filter((t) => /^第 \\d+ 页 \\/ 共 \\d+ 页$/.test(t)).length,
                    bare: texts.filter((t) => /^第 \\d+ 页$/.test(t)).length,
                  }
                })`
                const beforePager = await withProduct('关掉「共 N 页」之前', pagerProbe)
                const toggleE = await cdp.eval(`(() => {
                  const b = document.querySelector('[aria-label="显示总页数"]')
                  if (!b) return { ok: false }
                  b.click()
                  return { ok: true }
                })()`)
                await sleep(700)
                const afterToggleState = await cdp.eval(`(() => {
                  const b = document.querySelector('[aria-label="显示总页数"]')
                  return { checked: b ? b.getAttribute('aria-checked') : null }
                })()`)
                const afterPager = await withProduct('关掉「共 N 页」之后', pagerProbe)
                ok('【系统变量·承重】关掉「显示总页数」→ **打印产物里这一处变成只输出「第 X 页」**（「共 N 页」那半句真的没了）',
                  toggleE?.ok === true && afterToggleState?.checked === 'false' &&
                    (afterPager?.bare ?? 0) > (beforePager?.bare ?? 0) &&
                    (afterPager?.combined ?? 0) < (beforePager?.combined ?? 0),
                  `改前 合并形态 ${beforePager?.combined} 个 / 只有页码 ${beforePager?.bare} 个 → 改后 ${afterPager?.combined} 个 / ${afterPager?.bare} 个（开关 aria-checked=${afterToggleState?.checked}）`)
                // 收尾：把它还原成"显示总页数"，不给后面的用例留一个改了行为的 doc
                await cdp.eval(`(() => { const b = document.querySelector('[aria-label="显示总页数"]'); if (b) b.click(); return !!b })()`)
                await sleep(500)
              }
            }
          }
        }
      }
    }


    // ==================================================================
    console.log('\n[15] 表格工具条 / 拖边框调大小 / 智能对齐线（新增）')
    // B 批新增的三块 UI（顶栏表格工具条、拖列/行边框调大小、智能对齐线）此前**一条断言都没有**。
    // 这一节全部只看"画出来的东西"，不看按钮的样式态：
    //   · 表格入口**常驻**、未选中时**禁用并说出原因**、选中后可用；
    //   · 选中表格**不会让这一行的几何动一下**（原缺陷就是"工具行一变高，画布整体下移，
    //     用户按下的那一刻命中的已经是另一个元素"）；
    //   · 工具条上的动作真的改到画布上那张表（行 / 列数、列宽数组、总宽）；
    //   · 合并这条路**绕不过确认层**（工具条与右侧单元格面板是两个入口，必须共用同一层）；
    //   · 拖列 / 行边框改了列宽行高，且**列宽数组之和 = 元素总宽**（E-45 的硬约束）；
    //   · 行高能回到**自适应**（`TableRow.heightMm` 缺席是第三态，见 types.ts:355）——
    //     拖到下限以下与双击行边框两条路都要能回去，否则那一行再也长不回来、内容会溢出；
    //   · 对齐线只在拖动时出现、且正好画在两者重合的那条边上、松手就收。
    {
      /**
       * 页面内小工具。放 `cdp.eval` 里而不是加进 `__bp`：这一节的口径（"选中表格的几何"）
       * 只在这里用得上，塞进公共 HELPERS 会让别处的断言也能随手引用它。
       */
      const T15 = `
window.__t15 = {
  host(id) { return document.querySelector('[data-el-id="' + id + '"]') },
  tbl(id) { const h = this.host(id); return h ? h.querySelector('table.bp-el-table') : null },
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } },
  scrollTo(id) { const h = this.host(id); if (!h) return false; h.scrollIntoView({ block: 'center', inline: 'center' }); return true },
  /** 选中表格的几何快照：全从**画出来的 DOM** 上读，不碰模型 */
  geo(id) {
    const h = this.host(id); if (!h) return { missing: 'no-host' }
    const t = h.querySelector('table.bp-el-table'); if (!t) return { missing: 'no-table' }
    const cols = Array.from(t.querySelectorAll('colgroup > col')).map((c) => c.style.width)
    const trs = Array.from(t.querySelectorAll('tbody > tr'))
    const mmOf = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null }
    const paper = document.querySelector('.bp-paper')
    const inv = paper ? parseFloat(getComputedStyle(paper).getPropertyValue('--bp-inv')) : NaN
    return {
      elBox: this.box(h),
      tableBox: this.box(t),
      rows: trs.length,
      tds: t.querySelectorAll('td').length,
      rowTd: trs.map((tr) => tr.querySelectorAll('td').length),
      rowColspan: trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => Number(td.getAttribute('colspan') || 1))),
      cols,
      colMm: cols.map(mmOf),
      sumColMm: Math.round(cols.reduce((a, s) => a + (mmOf(s) || 0), 0) * 100) / 100,
      rowHeightStyle: trs.map((tr) => tr.style.height || null),
      colHandles: h.querySelectorAll('.bp-tbl-size__col').length,
      rowHandles: h.querySelectorAll('.bp-tbl-size__row').length,
      scale: Number.isFinite(inv) && inv > 0 ? 1 / inv : null,
    }
  },
  /** 顶栏几何快照：用来断言"选中表格不会让这一行 / 画布动一下" */
  bar() {
    const bar = document.querySelector('.bp-tools')
    const br = bar ? bar.getBoundingClientRect() : null
    const within = (sel) => this.box(document.querySelector('.bp-tools ' + sel))
    const scope = document.querySelector('.bp-tools__scope')
    return {
      bar: this.box(bar),
      barBottom: br ? Math.round(br.bottom) : null,
      scopeW: scope ? Math.round(scope.getBoundingClientRect().width) : null,
      undo: within('[aria-label="撤销"]'),
      redo: within('[aria-label="重做"]'),
      orient: within('button[aria-label^="纸张方向："]'),
      tableBtn: within('.bp-tools__table'),
      paper: this.box(document.querySelector('.bp-paper')),
    }
  },
  tableTrigger() {
    const b = document.querySelector('.bp-tools .bp-tools__table')
    const sel = document.querySelectorAll('.bp-el.is-selected').length
    if (!b) return { found: false, sel }
    return { found: true, sel, disabled: !!b.disabled, label: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: (b.textContent || '').trim() }
  },
  /**
   * 找一个"点下去真的命中这个元素"的屏幕点。
   *
   * 与 __bp.point 的两点不同：
   *   1. **先试那四条内边距上的点**。单元格里塞着字段 chip 时，中心点一定命中的是 chip
   *      而不是 td 本身；而"内边距"属于 td 自己的盒子，内容再多也压不到它 ——
   *      用来做"选中这一格"最稳（点内容上会把选中层级变成"这一处节点"）。
   *   2. 采样全落空时**允许命中子孙节点**（拖整表时点在表格里的 td 上也算数）。
   * 最后仍然失败就把"被谁挡住了"报出来 —— 否则只会得到一句"拖了没反应"。
   */
  hitOf(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (!(r.width >= 4 && r.height >= 4)) return { blocked: true, why: '尺寸太小', w: Math.round(r.width), h: Math.round(r.height) }
    const cands = []
    const INSET = 2.5
    cands.push([Math.round(r.left + INSET), Math.round(r.top + INSET)])
    cands.push([Math.round(r.right - INSET), Math.round(r.top + INSET)])
    cands.push([Math.round(r.left + INSET), Math.round(r.bottom - INSET)])
    cands.push([Math.round(r.right - INSET), Math.round(r.bottom - INSET)])
    for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8]) cands.push([Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy)])
    }
    for (const c of cands) if (document.elementFromPoint(c[0], c[1]) === el) return { x: c[0], y: c[1] }
    for (const c of cands) {
      const t = document.elementFromPoint(c[0], c[1])
      if (t && el.contains(t) && !t.closest('.bp-handle') && !t.closest('.bp-tbl-size')) return { x: c[0], y: c[1], inner: true }
    }
    const c = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    return { blocked: true, why: '被别的节点挡住', by: c ? (c.getAttribute('aria-label') || String(c.className) || c.tagName) : null, rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
  },
  cellHit(id, rowIdx, colIdx) {
    const t = this.tbl(id); if (!t) return null
    const tr = Array.from(t.querySelectorAll('tbody > tr'))[rowIdx]; if (!tr) return null
    const td = Array.from(tr.querySelectorAll('td'))[colIdx]; if (!td) return null
    const p = this.hitOf(td)
    if (!p || p.x === undefined) return Object.assign({ cellId: td.getAttribute('data-cell-id'), rowIdx, colIdx }, p || {})
    return { x: p.x, y: p.y, cellId: td.getAttribute('data-cell-id'), rowIdx, colIdx }
  },
  /**
   * 找一格「右边那一格**非空**」的左格：只有这种组合才会走确认层。
   * 刻意要求两格都不跨行跨列 —— 否则"td 数 -1 / colspan 变 2"这套判据会被原有的
   * 合并格搅浑，测出来的差值说不清是谁造成的。
   */
  mergePair(id) {
    const t = this.tbl(id); if (!t) return null
    const trs = Array.from(t.querySelectorAll('tbody > tr'))
    const cspan = (td) => Number(td.getAttribute('colspan') || 1)
    const rspan = (td) => Number(td.getAttribute('rowspan') || 1)
    for (let r = 0; r < trs.length; r += 1) {
      const tds = Array.from(trs[r].querySelectorAll('td'))
      for (let i = 0; i + 1 < tds.length; i += 1) {
        const a = tds[i], b = tds[i + 1]
        if (cspan(a) !== 1 || rspan(a) !== 1 || cspan(b) !== 1 || rspan(b) !== 1) continue
        const bt = (b.textContent || '').trim()
        if (bt === '') continue
        const p = this.hitOf(a)
        if (p && p.x !== undefined) return { x: p.x, y: p.y, cellId: a.getAttribute('data-cell-id'), rowIdx: r, colIdx: i, rightText: bt.slice(0, 12) }
      }
    }
    return null
  },
  /** 第 idx 个列边框手柄上真正能命中的点 */
  colHandleHit(id, idx) {
    const h = this.host(id); if (!h) return null
    const el = h.querySelectorAll('.bp-tbl-size__col')[idx]; if (!el) return null
    const p = this.hitOf(el)
    return p ? Object.assign({ w: Math.round(el.getBoundingClientRect().width) }, p) : null
  },
  rowHandleHit(id, idx) {
    const h = this.host(id); if (!h) return null
    const el = h.querySelectorAll('.bp-tbl-size__row')[idx]; if (!el) return null
    const p = this.hitOf(el)
    return p ? Object.assign({ h: Math.round(el.getBoundingClientRect().height) }, p) : null
  },
  clickIn(scope, label) {
    const b = document.querySelector(scope + ' [aria-label="' + label + '"]')
    if (!b) return { ok: false, why: '找不到', scope }
    if (b.disabled) return { ok: false, disabled: true, scope }
    b.click()
    return { ok: true, scope }
  },
  stateIn(scope, label) {
    const b = document.querySelector(scope + ' [aria-label="' + label + '"]')
    return b ? { found: true, disabled: !!b.disabled, title: b.getAttribute('title') } : { found: false }
  },
  tableDialog() {
    const d = document.querySelector('[role="dialog"][aria-label="表格"]')
    if (!d) return { open: false }
    const r = d.getBoundingClientRect()
    return { open: true, visible: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height), text: (d.innerText || '').slice(0, 220) }
  },
  hint() { const p = document.querySelector('[role="dialog"][aria-label="表格"] .bp-hint'); return p ? (p.innerText || '').trim() : null },
  /**
   * 表格工具条上的按钮在"这一格能不能合并"上的可用性。
   * 顶栏与右侧面板同名（「与右侧单元格合并」等），所以**必须按作用域取**，
   * 用全局 querySelector 会命中 DOM 里靠前的另一个，测到的就不是工具条了。
   */
  toolsState() {
    const out = {}
    for (const l of ['增加一行', '减少一行', '增加一列', '减少一列', '与右侧单元格合并', '与下方单元格合并', '拆分单元格']) out[l] = this.stateIn('[role="dialog"][aria-label="表格"]', l)
    // Seg 是 radiogroup：选中的那一档写的是 aria-checked（不是 aria-pressed）
    const seg = Array.from(document.querySelectorAll('[role="dialog"][aria-label="表格"] [aria-label="框线"] button')).map((b) => ({ text: (b.textContent || '').trim(), on: b.getAttribute('aria-checked') === 'true' }))
    return { btns: out, border: seg }
  },
  confirmCount() { return document.querySelectorAll('.bp-merge-confirm').length },
  guides() {
    return Array.from(document.querySelectorAll('.bp-guide')).map((g) => {
      const r = g.getBoundingClientRect()
      return { cls: g.className, l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    })
  },
  selectedTable() { const e = document.querySelector('.bp-el.is-selected'); return e ? e.getAttribute('data-el-id') : null },
}
true
`
      await cdp.eval(T15)

      const geo15 = async (id) => await cdp.eval(`__t15.geo(${JSON.stringify(id)})`)
      const sameBox = (a, b) => !!a && !!b && a.l === b.l && a.t === b.t && a.w === b.w && a.h === b.h

      /**
       * 带修饰键、且能在**松手之前**读一次页面的拖动。
       * 既有的 dragTo 不支持 modifiers（对齐线那条要按住 Alt 关掉网格吸附，
       * 否则落点会被吸到网格上、不一定和另一个元素对齐），也没法中途回调。
       */
      const dragSession = async (from, to, { modifiers = 0, steps = 12, onHeld = null } = {}) => {
        const mid = { x: from.x, y: from.y }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, modifiers })
        await sleep(80)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, modifiers })
        await sleep(60)
        for (let i = 1; i <= steps; i += 1) {
          mid.x = Math.round(from.x + ((to.x - from.x) * i) / steps)
          mid.y = Math.round(from.y + ((to.y - from.y) * i) / steps)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y, button: 'left', buttons: 1, modifiers })
          await sleep(40)
        }
        // 关键：还在按住的时候读一次 —— 对齐线是"拖动过程中"的东西，松手就收，
        // 只在松手后看就只能看到"没有线"，那条断言会永远为真
        if (onHeld) { await sleep(220); await onHeld(mid) }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', buttons: 0, clickCount: 1, modifiers })
        await sleep(460)
      }

      const dblClickAt = async (x, y) => {
        for (const n of [1, 2]) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n })
          await sleep(30)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n })
          await sleep(40)
        }
        await sleep(400)
      }

      // ---- 0. 先把选中态清干净，再挑一张能点到的表 ----
      await keyPress(cdp, 'Escape')
      await sleep(150)
      await keyPress(cdp, 'Escape')
      await sleep(280)

      const tables15 = (await cdp.eval(`__bp.els()`)).filter((e) => e.kind === 'table')
      // **优先挑行数最多的那张表**：拖行边框那段要求 ≥2 行（最后一条行边框不画出来，
      // 所以 1 行的表一个行手柄都没有，"拖到 6mm 以下"根本无从验起）。
      // 「通用清单」骨架里表头那张就只有 1 行 —— 顺手挑第一张就会挑到它。
      const cand15 = []
      for (const t of tables15) {
        const g = await cdp.eval(`__t15.geo(${JSON.stringify(t.id)})`)
        cand15.push({ id: t.id, rows: g?.rows ?? 0, cols: g?.colMm?.length ?? 0 })
      }
      cand15.sort((a, b) => b.rows * 100 + b.cols - (a.rows * 100 + a.cols))
      let target15 = null
      const diag15 = []
      for (const c of cand15) {
        const t = { id: c.id }
        await cdp.eval(`__t15.scrollTo(${JSON.stringify(t.id)})`)
        await sleep(280)
        await cdp.eval(`__bp.blurAll()`)
        const d = await cdp.eval(`(() => {
          const h = __t15.host(${JSON.stringify(t.id)})
          const tb = __t15.tbl(${JSON.stringify(t.id)})
          const td = tb ? tb.querySelector('tbody > tr td') : null
          const r = h ? h.getBoundingClientRect() : null
          return {
            host: !!h, table: !!tb, td: !!td,
            hostRect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
            hit: __t15.cellHit(${JSON.stringify(t.id)}, 0, 0),
          }
        })()`)
        diag15.push(Object.assign({ id: t.id }, d))
        if (d?.hit && d.hit.x !== undefined) { target15 = { id: t.id, pt: d.hit }; break }
      }
      note('[15] 靶子：画布上有几张表、挑中的是哪一张', { 表格数: tables15.length, 全部: tables15.map((t) => t.id), 选中: target15?.id ?? null, 可点位置: target15?.pt ?? null })
      note('[15] 逐张表的命中诊断（挑不中时看这里：是没画出来、还是被谁挡住了）', diag15)

      if (!target15) {
        ok('[15] 前提：画布上至少有一张能点到的表格（点不到就没法验工具条）', false,
          JSON.stringify({ 表格数: tables15.length, ids: tables15.map((t) => t.id) }))
      } else {
        const TID = target15.id

        // ============================================================
        // A. 常驻的表格入口 + 选中它不会让工具行动一下
        // ============================================================
        await cdp.eval(`document.body.click()`)
        await sleep(200)
        await keyPress(cdp, 'Escape')
        await sleep(400)

        // 一次 eval 把这一节要的读数全取回来（这台机器上一次 CDP 往返 ~0.6s，能并就并）
        const snapA = await cdp.eval(`({ trig: __t15.tableTrigger(), bar: __t15.bar() })`)
        const trigBefore = snapA?.trig
        const barU = snapA?.bar
        note('未选中表格时：表格入口的读数 + 工具行 / 右侧那一组 / 画布纸张的几何', { 入口: trigBefore, 工具行: barU?.bar, 撤销: barU?.undo, 方向: barU?.orient, 纸张: barU?.paper, 作用对象胶囊宽: barU?.scopeW })
        ok('【表格工具·常驻】没选中任何元素时这个入口**也在这一行上**（不是藏起来），而且是禁用的 —— 禁用原因写在 title 上，用户看得出来"要先选一张表"',
          trigBefore?.found === true && trigBefore?.sel === 0 && trigBefore?.disabled === true &&
            typeof trigBefore?.title === 'string' && trigBefore.title.includes('选中一张表格') &&
            typeof trigBefore?.label === 'string' && trigBefore.label.includes('未选中表格'),
          `入口=${JSON.stringify(trigBefore)}`)

        await clickAt(cdp, target15.pt.x, target15.pt.y, 1)
        await sleep(380)
        const snapB = await cdp.eval(`({ sel: __t15.selectedTable(), bar: __t15.bar(), trig: __t15.tableTrigger(), geo: __t15.geo(${JSON.stringify(TID)}) })`)
        const selNow = snapB?.sel
        const barS = snapB?.bar
        const trigAfter = snapB?.trig
        const geoA = snapB?.geo
        note('选中表格后：同一组几何', { 选中元素: selNow, 入口: trigAfter, 工具行: barS?.bar, 撤销: barS?.undo, 方向: barS?.orient, 纸张: barS?.paper, 作用对象胶囊宽: barS?.scopeW })

        const moved15 = []
        const cmpBox = (label, a, b) => { if (!sameBox(a, b)) moved15.push(`${label} ${JSON.stringify(a)}→${JSON.stringify(b)}`) }
        cmpBox('工具行', barU?.bar, barS?.bar)
        cmpBox('撤销', barU?.undo, barS?.undo)
        cmpBox('重做', barU?.redo, barS?.redo)
        cmpBox('纸张方向', barU?.orient, barS?.orient)
        cmpBox('画布纸张', barU?.paper, barS?.paper)
        // 表格入口按钮只比**尺寸**：它的横向位置会跟着左边那句「改：…」的文字长度走，
        // 而那是既有行为（胶囊宽度由文字决定），且被右侧 spacer 吸收 —— 不在这条判据里。
        // 尺寸必须不变，这正是 `.bp-tools__table { flex: none; width: 96px }` 要保证的事。
        const wHeld15 = barU?.tableBtn?.w === barS?.tableBtn?.w && barU?.tableBtn?.h === barS?.tableBtn?.h
        ok('【表格工具·零位移】选中表格前后逐项比对：**工具行的高度**、右端「撤销 / 重做 / 纸张方向」的位置、画布纸张的矩形、以及表格入口按钮自身的**尺寸**，一项都没动 —— 表格入口是定宽的，选中后多出来的 `N×M` 读数不会把这一行撑成两行、更不会把画布顶下去',
          selNow === TID && moved15.length === 0 && wHeld15,
          moved15.length || !wHeld15
            ? `动了：${moved15.join(' ｜ ')}${wHeld15 ? '' : ` ｜ 表格入口尺寸 ${JSON.stringify(barU?.tableBtn)}→${JSON.stringify(barS?.tableBtn)}`}`
            : `工具行 ${JSON.stringify(barU?.bar)}（选中后 ${JSON.stringify(barS?.bar)}，高度 ${barU?.bar?.h}px 未变）｜ 表格入口尺寸 ${JSON.stringify(barS?.tableBtn)} 未变、横向位置 ${barU?.tableBtn?.l}→${barS?.tableBtn?.l}px（作用对象那句文字从 ${barU?.scopeW}px 缩到 ${barS?.scopeW}px，这段位移被右侧 spacer 吸收，是既有行为）`)

        const geoA2 = geoA
        ok('【表格工具·选中】点中表格后入口亮起（不再禁用），按钮上直接写着**当前这张表的 行×列**（不用打开弹层就知道改的是谁）',
          trigAfter?.disabled === false &&
            typeof trigAfter?.label === 'string' &&
            trigAfter.label.includes(`${geoA2?.rows} 行 × ${geoA2?.colMm?.length} 列`),
          `入口=${JSON.stringify(trigAfter)}；画布上这张表 ${geoA2?.rows} 行 × ${geoA2?.colMm?.length} 列`)

        // ============================================================
        // B. 工具条直接增删行列 → 画布上那张表真的变了
        // ============================================================
        const openTools = await cdp.eval(`(() => { const b = document.querySelector('.bp-tools .bp-tools__table'); if (!b || b.disabled) return { ok: false }; b.click(); return { ok: true } })()`)
        await sleep(300)
        const snapC = await cdp.eval(`({ dlg: __t15.tableDialog(), tools: __t15.toolsState(), geo: __t15.geo(${JSON.stringify(TID)}), hint: __t15.hint() })`)
        const dlg15 = snapC?.dlg
        const toolsState0 = snapC?.tools
        const geo0 = snapC?.geo
        note('表格弹层里的按钮与当前几何', { 弹层: dlg15?.open === true, 按钮: toolsState0?.btns, 框线: toolsState0?.border, 行: geo0?.rows, 列: geo0?.colMm, 总宽: geo0?.elBox?.w, 提示: snapC?.hint, 开弹层: openTools })
        ok('【表格工具·面板】点开表格入口 → 弹出的层里是四个行列按钮 + 合并/拆分三个按钮 + 框线四档，且此刻「加行 / 加列」可用（说明它认的就是刚选中的那张表）',
          dlg15?.open === true && dlg15?.visible === true &&
            toolsState0?.btns?.['增加一行']?.found === true && toolsState0?.btns?.['增加一行']?.disabled === false &&
            toolsState0?.btns?.['增加一列']?.found === true && toolsState0?.btns?.['增加一列']?.disabled === false &&
            toolsState0?.btns?.['与右侧单元格合并']?.found === true && toolsState0?.btns?.['拆分单元格']?.found === true &&
            Array.isArray(toolsState0?.border) && toolsState0.border.length === 4,
          `弹层=${JSON.stringify(dlg15)} 按钮=${JSON.stringify(toolsState0?.btns)} 框线=${JSON.stringify(toolsState0?.border)}`)

        const DOC_SCOPE = '[role="dialog"][aria-label="表格"]'
        /** 点一个工具条按钮，并把**点完之后**的几何一起带回来（省一次往返） */
        const clickTool = async (label) => {
          const r = await cdp.eval(`__t15.clickIn(${JSON.stringify(DOC_SCOPE)}, ${JSON.stringify(label)})`)
          await sleep(330)
          const g = await cdp.eval(`__t15.geo(${JSON.stringify(TID)})`)
          return { ok: r?.ok === true, click: r, geo: g }
        }

        const addRowRes = await clickTool('增加一行')
        const geoR1 = addRowRes.geo
        ok('【表格工具·直改】点「增加一行」→ 画布上这张表真的多了一行（行数 +1，且新行和别的行一样宽）',
          addRowRes?.ok === true && geoR1?.rows === (geo0?.rows ?? 0) + 1 &&
            geoR1?.tds === (geo0?.tds ?? 0) + geo0.rowTd[0] &&
            geoR1?.rowTd[geoR1.rowTd.length - 1] === geo0?.rowTd?.[0],
          `行数 ${geo0?.rows} → ${geoR1?.rows}，全表 td ${geo0?.tds} → ${geoR1?.tds}（新行 ${geoR1?.rowTd?.[geoR1.rowTd.length - 1]} 格，别的行 ${geo0?.rowTd?.[0]} 格）`)

        const delRowRes = await clickTool('减少一行')
        const geoR2 = delRowRes.geo
        ok('【表格工具·直改】再点「减少一行」→ 回到原来的行数（同一份动作实现，加得上去也减得回来）',
          delRowRes?.ok === true && geoR2?.rows === geo0?.rows && geoR2?.tds === geo0?.tds &&
            JSON.stringify(geoR2?.rowTd) === JSON.stringify(geo0?.rowTd),
          `行数 ${geoR1?.rows} → ${geoR2?.rows}（原始 ${geo0?.rows}），全表 td ${geoR1?.tds} → ${geoR2?.tds}（原始 ${geo0?.tds}）`)

        const mmPerPx15 = 25.4 / (96 * (geo0?.scale || 1))
        const addColRes = await clickTool('增加一列')
        const geoC1 = addColRes.geo
        ok('【表格工具·直改】点「增加一列」→ 每一行都多出一格、列宽数组也多一项，且**元素总宽同步变宽**（E-45：列宽数组之和必须等于元素 w，工具条这条路也不能例外）',
          addColRes?.ok === true && geoC1?.rowTd?.every((n) => n === geo0.rowTd[0] + 1) &&
            geoC1?.colMm?.length === (geo0?.colMm?.length ?? 0) + 1 &&
            Math.abs(geoC1.sumColMm - (geoC1?.elBox?.w ?? 0) * mmPerPx15) <= 0.5 &&
            (geoC1?.elBox?.w ?? 0) > (geo0?.elBox?.w ?? 0),
          `列数 ${geo0?.colMm?.length} → ${geoC1?.colMm?.length}，每行格数 ${JSON.stringify(geo0?.rowTd)} → ${JSON.stringify(geoC1?.rowTd)}；列宽数组之和 ${geoC1?.sumColMm}mm，元素总宽 ${geoC1?.elBox?.w}px ≈ ${Math.round((geoC1?.elBox?.w ?? 0) * mmPerPx15 * 100) / 100}mm；画布宽 ${geo0?.elBox?.w} → ${geoC1?.elBox?.w}px`)

        const delColRes = await clickTool('减少一列')
        const geoC2 = delColRes.geo
        ok('【表格工具·直改】再点「减少一列」→ 列数、每行格数、总宽都回到原来',
          delColRes?.ok === true && geoC2?.colMm?.length === geo0?.colMm?.length &&
            JSON.stringify(geoC2?.rowTd) === JSON.stringify(geo0?.rowTd) &&
            Math.abs((geoC2?.elBox?.w ?? 0) - (geo0?.elBox?.w ?? 0)) <= 2,
          `列数 ${geoC1?.colMm?.length} → ${geoC2?.colMm?.length}（原始 ${geo0?.colMm?.length}），每行格数 ${JSON.stringify(geoC2?.rowTd)}，画布宽 ${geoC2?.elBox?.w}px（原始 ${geo0?.elBox?.w}px）`)

        // ============================================================
        // C. 合并：工具条这条路**绕不过**确认层
        // ============================================================
        const pair15 = await cdp.eval(`__t15.mergePair(${JSON.stringify(TID)})`)
        note('[15] 找一格「右边那格非空」的单元格作为合并靶子', pair15)
        if (!pair15 || pair15.x === undefined) {
          ok('【表格工具·合并】前提：表里有一格，它的右边一格非空（只有这种组合才会走确认层）', false, JSON.stringify(pair15))
        } else {
          // 先把这一格选中（真实指针点击）—— 工具条的合并按钮按的是"当前选中的那一格"
          await clickAt(cdp, pair15.x, pair15.y, 1)
          await sleep(360)
          const selSnap = await cdp.eval(`(() => { const t = __t15.tbl(${JSON.stringify(TID)}); const td = t && t.querySelector('td.is-selected'); return { cell: td ? td.getAttribute('data-cell-id') : null, geo: __t15.geo(${JSON.stringify(TID)}) } })()`)
          const cellSel = selSnap?.cell
          const geoBeforeMerge = selSnap?.geo
          const rowBefore15 = geoBeforeMerge.rowColspan[pair15.rowIdx]
          const tdsBefore15 = geoBeforeMerge.tds
          await cdp.eval(`(() => { const b = document.querySelector('.bp-tools .bp-tools__table'); if (b && !b.disabled) b.click(); return !!b })()`)
          await sleep(300)
          const mergeBtn = await cdp.eval(`__t15.stateIn('[role="dialog"][aria-label="表格"]', '与右侧单元格合并')`)

          const askRes = await clickTool('与右侧单元格合并')
          const snapD = await cdp.eval(`({ n: __t15.confirmCount(), dlg: __bp.mergeConfirm(), geo: __t15.geo(${JSON.stringify(TID)}) })`)
          const confirmN = snapD?.n
          const dlgC = snapD?.dlg
          const geoHeld = snapD?.geo
          const tdsHeld15 = geoHeld?.tds
          const rowHeld15 = geoHeld?.rowColspan?.[pair15.rowIdx]
          note('工具条点「右合并」之后（确认层还在）', { 点击: askRes?.click, 选中格: cellSel, 右合并按钮: mergeBtn, 确认层个数: confirmN, 确认层在: dlgC?.present, 此刻td数: tdsHeld15 })

          ok('【表格工具·合并】在**顶栏工具条**上点「右合并」（右边那格非空）→ 弹的是**同一个**确认层：页面里 `.bp-merge-confirm` 恰好一份，文案点名了将被丢掉的内容 —— 工具条这条路绕不过确认',
            askRes?.ok === true && confirmN === 1 && dlgC?.present === true && dlgC?.visible === true &&
              typeof dlgC?.text === 'string' && dlgC.text.includes('丢弃') &&
              dlgC.text.includes(pair15.rightText.slice(0, 2)),
            `确认层个数=${confirmN} 文案「${dlgC?.text}」；将被丢掉的那一格内容「${pair15.rightText}」；工具条上的「右合并」按钮 ${JSON.stringify(mergeBtn)}`)

          ok('【表格工具·合并·先问再合】确认层弹出来的时候表格结构**一点都没动**（全表 td 数与这一行的 colspan 都和点之前一模一样）—— 不是"先合并了再问一句"',
            tdsHeld15 === tdsBefore15 && JSON.stringify(rowHeld15) === JSON.stringify(rowBefore15),
            `td 数 ${tdsBefore15} → ${tdsHeld15}；第 ${pair15.rowIdx + 1} 行 colspan ${JSON.stringify(rowBefore15)} → ${JSON.stringify(rowHeld15)}`)

          const yesRes = await cdp.eval(`(() => { const b = __bp.confirmBtn('确认合并'); if (!b) return { ok: false }; b.click(); return { ok: true } })()`)
          await sleep(430)
          const snapE = await cdp.eval(`({ dlg: __bp.mergeConfirm(), geo: __t15.geo(${JSON.stringify(TID)}) })`)
          const geoAfterMerge = snapE?.geo
          const dlgAfterMerge = snapE?.dlg
          note('点「仍然合并」之后的几何', { 行: geoAfterMerge?.rows, td: geoAfterMerge?.tds, colspan: geoAfterMerge?.rowColspan?.[pair15.rowIdx], 确认层: dlgAfterMerge?.present })
          ok('【表格工具·合并】点「仍然合并」→ 合并真的发生（全表 td -1、被并进的那一格 colspan 变 2），确认层消失',
            yesRes?.ok === true && dlgAfterMerge?.present === false &&
              geoAfterMerge?.tds === tdsBefore15 - 1 &&
              (geoAfterMerge?.rowColspan?.[pair15.rowIdx]?.[pair15.colIdx] ?? 0) === (rowBefore15[pair15.colIdx] + 1),
            `td 数 ${tdsBefore15} → ${geoAfterMerge?.tds}；第 ${pair15.rowIdx + 1} 行 colspan ${JSON.stringify(rowBefore15)} → ${JSON.stringify(geoAfterMerge?.rowColspan?.[pair15.rowIdx])}`)

          // 还原：这一步合并 = 一步撤销，撤掉它不给后面的拖拽留一张被改过的表
          await keyPress(cdp, 'Escape')
          await sleep(250)
          await cdp.eval(`__bp.blurAll()`)
          await keyPress(cdp, 'z', { modifiers: 2 })
          await sleep(430)
          const geoUndo = await geo15(TID)
          note('撤销合并之后', { td: geoUndo?.tds, colspan: geoUndo?.rowColspan?.[pair15.rowIdx] })
          // 表格入口的弹层在撤销后仍然开着也无所谓，下面拖边框前会显式关掉它
          await cdp.eval(`__bp.blurAll()`)
        }

        // ---- 拖边框之前把弹层关掉：它是 fixed 定位、压在画布左上角，会挡住手柄的命中点 ----
        await keyPress(cdp, 'Escape')
        await sleep(230)
        await keyPress(cdp, 'Escape')
        await sleep(230)
        const dlgClosed = await cdp.eval(`__t15.tableDialog()`)
        await cdp.eval(`__t15.scrollTo(${JSON.stringify(TID)})`)
        await sleep(280)
        // 重新选一下（Escape 会把单元格选中态也清掉，手柄只在整表选中时才有）
        const reselect = await cdp.eval(`__t15.cellHit(${JSON.stringify(TID)}, 0, 0)`)
        if (reselect && reselect.x !== undefined) { await clickAt(cdp, reselect.x, reselect.y, 1); await sleep(360) }
        const selOK = (await cdp.eval(`__t15.selectedTable()`)) === TID
        note('[15] 进入拖拽阶段前的状态', { 弹层已关: dlgClosed?.open === false, 表格仍选中: selOK, 重新命中: reselect })

        // ============================================================
        // D. 拖列边框 → 列宽变化，且"列宽数组之和 = 元素总宽"
        // ============================================================
        if (!selOK) {
          ok('【拖列边框】前提：表格处于选中态（列 / 行手柄只在整表选中时才画出来）', false, `selectedTable()=${await cdp.eval(`__t15.selectedTable()`)}`)
        } else {
          const snapD0 = await cdp.eval(`({ geo: __t15.geo(${JSON.stringify(TID)}), col: __t15.colHandleHit(${JSON.stringify(TID)}, 0) })`)
          const geoD0 = snapD0?.geo
          const colPt = snapD0?.col
          note('拖列边框前：第 1 列列宽 / 手柄可点位置', { colMm: geoD0?.colMm, 手柄: colPt, 手柄数: geoD0?.colHandles, 行手柄数: geoD0?.rowHandles, 缩放: geoD0?.scale })

          if (!colPt || colPt.x === undefined) {
            ok('【拖列边框】前提：第 1 列右边框手柄能命中（不然不是"拖了没反应"，而是"根本没按到手柄"）', false, JSON.stringify(colPt))
          } else {
            const dx15 = 60
            await dragSession({ x: colPt.x, y: colPt.y }, { x: colPt.x + dx15, y: colPt.y }, { steps: 12 })
            const geoD1 = await geo15(TID)
            const expectMm = dx15 * mmPerPx15
            const dCol0 = (geoD1?.colMm?.[0] ?? 0) - (geoD0?.colMm?.[0] ?? 0)
            const dCol1 = (geoD1?.colMm?.[1] ?? 0) - (geoD0?.colMm?.[1] ?? 0)
            const dWpx = (geoD1?.elBox?.w ?? 0) - (geoD0?.elBox?.w ?? 0)
            ok('【拖列边框】把第 1 列右边框向右拖 60px → **这一列的列宽真的变大了**（mm 读数与指针位移对得上），而第 2 列一动不动',
              Math.abs(dCol0 - expectMm) <= 1.2 && Math.abs(dCol1) <= 0.05,
              `第 1 列 ${geoD0?.colMm?.[0]} → ${geoD1?.colMm?.[0]}mm（Δ${Math.round(dCol0 * 100) / 100}，按 ${geoD0?.scale} 倍缩放算应为 ${Math.round(expectMm * 100) / 100}mm）；第 2 列 ${geoD0?.colMm?.[1]} → ${geoD1?.colMm?.[1]}mm（Δ${Math.round(dCol1 * 100) / 100}）`)

            ok('【拖列边框·总宽同步】拖完之后元素总宽跟着列宽一起长（画布宽 Δ = 指针位移），且「列宽数组之和」正好等于元素总宽 —— 列宽与 w 没有脱节（E-45）',
              Math.abs(dWpx - dx15) <= 3 && Math.abs(geoD1.sumColMm - (geoD1?.elBox?.w ?? 0) * mmPerPx15) <= 0.5,
              `画布宽 ${geoD0?.elBox?.w} → ${geoD1?.elBox?.w}px（Δ${dWpx}，指针位移 ${dx15}px）；列宽数组之和 ${geoD1?.sumColMm}mm，元素总宽 ${geoD1?.elBox?.w}px ≈ ${Math.round((geoD1?.elBox?.w ?? 0) * mmPerPx15 * 100) / 100}mm`)

            // 拖回去，别把这张表的列宽留在改过的状态
            const colPt2 = await cdp.eval(`__t15.colHandleHit(${JSON.stringify(TID)}, 0)`)
            if (colPt2 && colPt2.x !== undefined) {
              await dragSession({ x: colPt2.x, y: colPt2.y }, { x: colPt2.x - dx15, y: colPt2.y }, { steps: 12 })
            }
            const geoD2 = await geo15(TID)
            note('把第 1 列拖回去之后', { colMm: geoD2?.colMm, 画布宽: geoD2?.elBox?.w })
          }
        }

        // ============================================================
        // E. 拖行边框调行高 + 第三态「自适应」
        // ============================================================
        // 行手柄**只在 ≥2 行时才画**（最后一条行边框没有"下一条边"可比，画出来只会误导）。
        // 「通用清单」这张表在画布上只有 1 行，所以先用工具条上的「增加一行」造出第二行 ——
        // 这个动作本身已经在 B 组验过，这里只是复用。收尾时会把它连带撤销掉。
        await cdp.eval(`(() => { const b = document.querySelector('.bp-tools .bp-tools__table'); if (b && !b.disabled) b.click(); return !!b })()`)
        await sleep(300)
        const rowSeed = await clickTool('增加一行')
        await keyPress(cdp, 'Escape')
        await sleep(230)
        const snapE0 = await cdp.eval(`({ geo: __t15.geo(${JSON.stringify(TID)}), row: __t15.rowHandleHit(${JSON.stringify(TID)}, 0), dlg: __t15.tableDialog() })`)
        const geoE0 = snapE0?.geo
        const rowPt0 = snapE0?.row
        note('拖行边框前：造出第二行之后的读数', { 加行: rowSeed?.ok, 行数: geoE0?.rows, 行手柄数: geoE0?.rowHandles, 行高样式: geoE0?.rowHeightStyle, 手柄: rowPt0, 弹层已关: snapE0?.dlg?.open === false })

        if (!rowPt0 || rowPt0.x === undefined) {
          ok('【拖行边框】前提：第 1 行下边框手柄能命中', false, JSON.stringify({ rowPt0, rows: geoE0?.rows, rowHandles: geoE0?.rowHandles }))
        } else {
          await dragSession({ x: rowPt0.x, y: rowPt0.y }, { x: rowPt0.x, y: rowPt0.y + 150 }, { steps: 12 })
          const snapE1 = await cdp.eval(`({ geo: __t15.geo(${JSON.stringify(TID)}), row: __t15.rowHandleHit(${JSON.stringify(TID)}, 0) })`)
          const geoE1 = snapE1?.geo
          const rowPt1 = snapE1?.row
          const h1 = parseFloat(geoE1?.rowHeightStyle?.[0] ?? '')
          ok('【拖行边框】把第 1 行下边框往下拖 150px → 这一行有了**显式行高**（`<tr>` 上真的出现了 height，而且不是被钳在 6mm 那种下限值）',
            typeof geoE1?.rowHeightStyle?.[0] === 'string' && Number.isFinite(h1) && h1 >= 6,
            `第 1 行 height 样式 ${JSON.stringify(geoE0?.rowHeightStyle?.[0])} → ${JSON.stringify(geoE1?.rowHeightStyle?.[0])}`)

          if (!rowPt1 || rowPt1.x === undefined) {
            ok('【拖行边框·第三态】前提：加高之后手柄仍能命中', false, JSON.stringify(rowPt1))
          } else {
            // 往上拖回 6mm 以下 —— 必须**换态成自适应**，而不是把行高钳到 6mm
            await dragSession({ x: rowPt1.x, y: rowPt1.y }, { x: rowPt1.x, y: rowPt1.y - 300 }, { steps: 14 })
            const snapE2 = await cdp.eval(`({ geo: __t15.geo(${JSON.stringify(TID)}), row: __t15.rowHandleHit(${JSON.stringify(TID)}, 0) })`)
            const geoE2 = snapE2?.geo
            const rowPt2 = snapE2?.row
            ok('【拖行边框·第三态】再往上拖到 6mm 以下 → 这一行**换态成「自适应」**（`<tr>` 上的 height 整个消失，而不是被钳到 6mm）—— 拖小不是把行压扁，是交还给内容撑',
              geoE2?.rowHeightStyle?.[0] === null,
              `第 1 行 height 样式 ${JSON.stringify(geoE1?.rowHeightStyle?.[0])} → ${JSON.stringify(geoE2?.rowHeightStyle?.[0])}（null = 自适应）`)

            // 再设一次显式行高，然后走"双击复位"这条路（rowPt2 是上面那次读数一并带回来的）
            if (rowPt2 && rowPt2.x !== undefined) {
              await dragSession({ x: rowPt2.x, y: rowPt2.y }, { x: rowPt2.x, y: rowPt2.y + 150 }, { steps: 12 })
              const snapE3 = await cdp.eval(`({ geo: __t15.geo(${JSON.stringify(TID)}), row: __t15.rowHandleHit(${JSON.stringify(TID)}, 0) })`)
              const geoE3a = snapE3?.geo
              const rowPt3 = snapE3?.row
              if (rowPt3 && rowPt3.x !== undefined) {
                await dblClickAt(rowPt3.x, rowPt3.y)
                const geoE3 = await geo15(TID)
                ok('【双击行边框】先把行高设成显式值，再**双击行边框** → 同样回到「自适应」（比"先拖过头再拖回来"更明确的一条路，两条路都通向同一个第三态）',
                  typeof geoE3a?.rowHeightStyle?.[0] === 'string' && geoE3?.rowHeightStyle?.[0] === null,
                  `设成显式 ${JSON.stringify(geoE3a?.rowHeightStyle?.[0])} → 双击后 ${JSON.stringify(geoE3?.rowHeightStyle?.[0])}`)
              } else {
                ok('【双击行边框】先把行高设成显式值，再**双击行边框** → 同样回到「自适应」', false, `双击前找不到手柄 ${JSON.stringify(rowPt3)}`)
              }
            } else {
              ok('【双击行边框】先把行高设成显式值，再**双击行边框** → 同样回到「自适应」', false, `找不到手柄 ${JSON.stringify(rowPt2)}`)
            }
          }
        }

        // ============================================================
        // F. 智能对齐线：拖动时出现、画在两者重合的那条边上、松手就收
        // ============================================================
        // 判定只在**同一个版式区**内做（align-guides 的调用方按 band 过滤），
        // 所以先挑一对"同版式区"的文本元素：逐个选中、读右栏「所属版式区」比对。
        await keyPress(cdp, 'Escape')
        await sleep(300)
        const texts15 = (await cdp.eval(`__bp.els()`)).filter((e) => e.kind === 'text')
        const bandOf15 = async (id) => {
          const pt = await cdp.eval(`__bp.pointEl(${JSON.stringify(id)})`)
          if (!pt || pt.x === undefined) return null
          await clickAt(cdp, pt.x, pt.y, 1)
          await sleep(310)
          let b = await cdp.eval(`__bp.activeBand()`)
          if (!b) { await keyPress(cdp, 'Escape'); await sleep(260); b = await cdp.eval(`__bp.activeBand()`) }
          return b
        }
        // 读一次版式区就是一次"点选中 + 读右栏"，不便宜 —— 按 id 缓存，命中一对就停；
        // 另外只在前 8 个文本元素里找（再往后拖着找会把整套脚本的耗时推上去，收益却很小）
        const pool15 = texts15.slice(0, 8)
        const bands15 = {}
        const bandOfCached = async (id) => {
          if (!(id in bands15)) bands15[id] = await bandOf15(id)
          return bands15[id]
        }
        let pairG = null
        for (let i = 0; i < pool15.length && !pairG; i += 1) {
          const bi = await bandOfCached(pool15[i].id)
          if (!bi) continue
          for (let j = i + 1; j < pool15.length && !pairG; j += 1) {
            const bj = await bandOfCached(pool15[j].id)
            if (bj && bj === bi) pairG = { a: pool15[i].id, b: pool15[j].id, band: bi }
          }
        }
        note('[15] 对齐线靶子：文本元素各在哪一个版式区', { 版式区: bands15, 挑中: pairG })
        if (!pairG) {
          ok('【对齐线】前提：能找到两个**同一个版式区**里的文本元素（跨版式区不做对齐判定）', false, JSON.stringify({ 文本元素: texts15.map((t) => t.id), 版式区: bands15 }))
        } else {
          await cdp.eval(`__t15.scrollTo(${JSON.stringify(pairG.a)})`)
          await sleep(280)
          // 先退掉可能还开着的就地编辑（上一轮点选若被判成双击就会进入编辑态，那样拖不动）
          await keyPress(cdp, 'Escape')
          await sleep(240)
          const aPt = await cdp.eval(`__bp.pointEl(${JSON.stringify(pairG.a)})`)
          if (!aPt || aPt.x === undefined) {
            ok('【对齐线】前提：被拖的那个文本元素能命中', false, JSON.stringify(aPt))
          } else {
            await clickAt(cdp, aPt.x, aPt.y, 1)
            await sleep(360)
            const rectAB = await cdp.eval(`({ a: __bp.rect(${JSON.stringify(pairG.a)}), b: __bp.rect(${JSON.stringify(pairG.b)}) })`)
            // 屏幕 px 与 mm 是 1:1 的（拖动换算 mmPerPx=1/(MM_TO_PX*scale)，渲染又乘回 MM_TO_PX*scale），
            // 所以把 A 往右拖 (B.left - A.left) 个屏幕像素，A 的左缘就落在 B 的左缘上。
            //
            // ⚠️ 但这只在"两者本来没对齐"时才是一次真拖动。「通用清单」里这两个文本块**都是整幅宽**，
            // 左缘本来就都在 121px —— 位移 0 的拖动连"移动"分支都进不去（阈值 3px），
            // setGuides 一次都不会被调用，于是"拖动中没有线"必然成立、这条断言会变成恒假。
            // 所以位移太小时先把它挪开 40px，再拖回来对齐 —— 让这一下一定是"真的在拖"。
            const dxG = rectAB.b.x - rectAB.a.x
            const aPt2 = await cdp.eval(`__bp.pointEl(${JSON.stringify(pairG.a)})`)
            let offPx = 0
            let rectDrag = rectAB
            let aPt3 = aPt2
            if (Math.abs(dxG) < 6) {
              offPx = 40
              await dragSession(aPt2, { x: aPt2.x + offPx, y: aPt2.y }, { modifiers: 1, steps: 8 })
              rectDrag = await cdp.eval(`({ a: __bp.rect(${JSON.stringify(pairG.a)}), b: __bp.rect(${JSON.stringify(pairG.b)}) })`)
              aPt3 = await cdp.eval(`__bp.pointEl(${JSON.stringify(pairG.a)})`)
            }
            const dxDrag = rectDrag.b.x - rectDrag.a.x
            let held = null
            // modifiers:1 = Alt → `snapMm(..., bypass=true)`，落点不被网格吸走，才可能精确对齐
            await dragSession(aPt3, { x: Math.round(aPt3.x + dxDrag), y: aPt3.y }, {
              modifiers: 1, steps: 12,
              onHeld: async () => {
                held = await cdp.eval(`({ guides: __t15.guides(), a: __bp.rect(${JSON.stringify(pairG.a)}), b: __bp.rect(${JSON.stringify(pairG.b)}) })`)
              },
            })
            const released = await cdp.eval(`__t15.guides()`)
            const gx = (held?.guides ?? []).filter((g) => g.cls.includes('bp-guide--x'))
            const onEdge = gx.some((g) => Math.abs(g.l - (held?.a?.x ?? -999)) <= 3 && Math.abs(g.l - (held?.b?.x ?? -999)) <= 3)
            note('拖动过程中读到的参考线 / 松手之后', { 先挪开: offPx, 原始位移: dxG, 本次拖动位移: dxDrag, 拖动中: held?.guides, A: held?.a, B: held?.b, 松手后: released })
            ok('【对齐线·承重】把 A 的左缘拖到与同版式区里 B 的左缘重合（差 <1mm）→ **拖动过程中**出现一条竖参考线，而且这条线正好画在两者重合的那条边上（线的 left 同时等于 A 与 B 的左缘）',
              gx.length > 0 && Math.abs((held?.a?.x ?? -1) - (held?.b?.x ?? -2)) <= 2 && onEdge,
              `拖动中竖线 ${gx.length} 条（全部参考线 ${JSON.stringify(held?.guides)}）；A 左缘 ${held?.a?.x}px、B 左缘 ${held?.b?.x}px、线 left ${JSON.stringify(gx.map((g) => g.l))}px；相差 ${Math.abs((held?.a?.x ?? -1) - (held?.b?.x ?? -2))}px（先挪开了 ${offPx}px）`)

            ok('【对齐线·收线】松手之后参考线**一条都不剩** —— 它是"当下的判定结果"，不是常驻装饰（常驻的参考底纹是网格，两者必须分得开）',
              Array.isArray(released) && released.length === 0,
              `松手后页面里 .bp-guide 个数=${(released ?? []).length}`)

            // 还原：这一步拖动 = 一步撤销
            await cdp.eval(`__bp.blurAll()`)
            await keyPress(cdp, 'z', { modifiers: 2 })
            await sleep(430)
            const backG = await cdp.eval(`__bp.rect(${JSON.stringify(pairG.a)})`)
            note('撤销对齐线那次拖动之后：A 回到', backG)
          }
        }
      }
    }

  } finally {
    try {
      if (cdp) void cdp.send('Browser.close').catch(() => {})
    } catch {}
    await sleep(300)
    child.kill()
    // 关键：Edge 真正的浏览器进程不是我们 spawn 的那个 launcher，`child.kill()` 杀不掉它，
    // 它会变成孤儿继续占着调试端口（下一次运行就会被它坑）。所以连整棵进程树一起收掉。
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 进程已退出 */
    }
    await sleep(700)
    if (await isPortBusy(PORT)) {
      console.log(`⚠️ 端口 ${PORT} 在退出后仍被占用 —— 可能有残留浏览器进程，请手动清理`)
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log('\n' + '='.repeat(56))
  // 耗时账本：sleep / CDP 往返 / 最慢的几次 eval —— 定位"这套脚本为什么慢"用
  console.log(
    `⏱ 耗时账本：总 ${secs}s ｜ 固定 sleep ${(TIMING.sleepMs / 1000).toFixed(1)}s ｜ ` +
      `CDP 往返 ${TIMING.sends} 次共 ${(TIMING.sendMs / 1000).toFixed(1)}s（其中 eval ${TIMING.evals} 次 ${(TIMING.evalMs / 1000).toFixed(1)}s，均 ${(TIMING.evalMs / Math.max(1, TIMING.evals)).toFixed(0)}ms）`,
  )
  for (const e of TIMING.slowEvals) console.log(`   · 慢 eval ${e.ms}ms ← ${e.head}`)
  if (failures.length === 0) console.log(`✅ 画布交互验证全部通过：${pass} 项（耗时 ${secs}s）`)
  else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项（耗时 ${secs}s）`)
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(56))

  // 结论行与退出码到这里已经定了，清理放在它们**之后**、而且是 best-effort：
  // rmSync 是同步的，浏览器刚被 kill 时 profile 里的文件常还被占着，带 maxRetries
  // 会逐文件重试（几百个文件 × 3 次 × 300ms）把事件循环整个卡住 —— 连结论行都打不出来。
  // profileDir 现在在 os.tmpdir() 下，删不掉也没关系。
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {}
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('画布交互验证脚本崩溃：', e)
  process.exit(1)
})
