/**
 * 专项验证：表格单元格的可选中性与可编辑性 + 画布几何四条（⑧⑨⑩⑪）。
 *
 * 为什么单独写一个：用户明确报过这两条缺陷 ——
 *   「无法对单元格内的文本做任何编辑」
 *   「点击到表格内的字段时，右侧的属性还是显示的表格的属性」
 * 而交付方自己也在汇报里标注了"单元格双击编辑、字段改绑只作了代码级核对，没做端到端手测"。
 * 这两条恰恰是用户最直接的痛点，所以必须用真实指针事件在浏览器里走一遍。
 *
 * `[4]` 一节是后加的：画布几何那四条需求（⑧ 手柄命中区 / ⑨ 允许重叠 +
 * 其余拒绝理由保留 / ⑩ 占位框常显 + 重叠区异色 / ⑪ 网格不越界）当时**只有一次性探针**
 * （`_geom-verify.mjs` / `_geom-margin.mjs`）在测，**冻结的 7 套套件里一条断言都没有**
 * ——探针是证据、不是守卫，改了不会红。这里把它们的判据升格成常驻断言。
 *
 * ⚠️ 这一节所有判据都走**渲染后的真实几何**（`getComputedStyle` / `getBoundingClientRect` /
 *    两矩形求交 / `elementFromPoint`），**不查 class 存在性** —— 本项目栽过一次
 *    "querySelector 查得到 ≠ 用户看得见"。同理，"被拒绝"要同时读**拖拽中的提示**与
 *    **松手后的 toast**，不能只看"元素数没变"（那条在"拖拽整个坏掉"时也成立）。
 *
 * 用法：node test/editor-cell-edit.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BP_BASE ?? 'http://localhost:5190'
const PORT = 9366

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

// 浏览器 profile 建在系统临时目录：项目根不再被 `.cell-profile-*` 污染。
const profileDir = join(tmpdir(), `bp-cell-${Date.now().toString(36)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`超时 ${method}`))
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
  text() { return document.body.innerText || ''; },
};
true`

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
    await sleep(60)
  }
}

async function key(cdp, name) {
  const vk = { Escape: 27 }[name] ?? 0
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await sleep(30)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(300)
}

/**
 * 真实拖动。`beforeUp` 是要在**松手之前**求值的表达式 —— 拖拽中的实时反馈只能在那一刻读。
 * ⑨⑪ 的拒绝理由都同时存在于「拖拽中的提示」和「松手后的 toast」两处，这里两处都要读。
 */
async function drag(cdp, from, to, steps = 14, beforeUp = null) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
  await sleep(80)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(60)
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      button: 'left', buttons: 1,
    })
    await sleep(35)
  }
  const snapshot = beforeUp ? await cdp.eval(beforeUp) : null
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(700)
  return snapshot
}

/**
 * 几何读数辅助（需求 ⑧⑨⑩⑪）。
 *
 * ⚠️ 这些读数的判据一律走**渲染后的真实几何**（`getBoundingClientRect` / `getComputedStyle`），
 *    不查 class 存在性。这个项目已经栽过一次"`querySelector` 查得到 ≠ 用户看得见"，
 *    所以 ⑩ 判的是 `outline` 的**计算样式**、⑨ 判的是两个矩形的**真交集**。
 */
const GEO_HELPERS = `
window.__g = {
  count: (s) => document.querySelectorAll(s).length,
  click(sel, t) { const e = Array.from(document.querySelectorAll(sel)).filter(x => (x.textContent||'').includes(t))[0]; if (!e) return false; e.click(); return true },
  tab(label) {
    const host = document.querySelector('[aria-label="插入面板"]') || document.querySelector('.bp-tabs')
    if (!host) return false
    const b = Array.from(host.querySelectorAll('button')).find(x => (x.textContent||'').trim() === label)
    if (b) b.click()
    return !!b
  },
  scale() { const p = document.querySelector('.bp-paper'); if (!p) return null; const inv = parseFloat(getComputedStyle(p).getPropertyValue('--bp-inv')); return Number.isFinite(inv) && inv > 0 ? 1/inv : null },
  rectOf(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left*100)/100, t: Math.round(r.top*100)/100, r: Math.round(r.right*100)/100, b: Math.round(r.bottom*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 } },
  /** ⑪：纸张 / 网格 / 版心框 三个矩形 + 底边关系 */
  pageGeom() {
    const paper = this.rectOf('.bp-paper'), grid = this.rectOf('.bp-grid'), box = this.rectOf('.bp-content-box')
    const marginBands = Array.from(document.querySelectorAll('.bp-margin')).map(b => { const r = b.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })
    return { paper, grid, box, marginBands, bottomMarginPx: paper && box ? Math.round((paper.b - box.b) * 100) / 100 : null }
  },
  /** ⑩：某个元素占位框的**计算样式**读数（不是 class 存在性） */
  frameOf(sel) {
    const e = document.querySelector(sel)
    if (!e) return null
    const cs = getComputedStyle(e)
    const r = e.getBoundingClientRect()
    return { sel: e.classList.contains('is-selected'), style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, w: Math.round(r.width), h: Math.round(r.height) }
  },
  /** ⑨：画出来的重叠块（含尺寸与是否吃鼠标事件） */
  overlaps() {
    return Array.from(document.querySelectorAll('.bp-overlap')).map(o => { const r = o.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), pe: getComputedStyle(o).pointerEvents } })
  },
  /**
   * ⑩ 的**读数自证**（补的）。这一整段在 GEO_HELPERS 模板串里，所以**注释里不能出现反引号**。
   *
   * 问题：pointer-events 那条断言原来是"无数值读数" —— 元素不存在时
   * ovs.map(o => o.pe).join() 读到的是空串，而"页面/模块根本没加载出来"读到的也是空串。
   * 两者在报告上长得一模一样，这正是"没测到"和"测到了某个值"不分家的形状。
   *
   * 补法：同一个表达式 getComputedStyle(node).pointerEvents 在**一定存在**的节点上再读一次。
   * · 正常     → overlap=none ／ control=auto（两个值都在，"none" 才是个有信息量的读数）
   * · 页面坏了 → overlap=null ／ control=null → **对照那条先红**，指名"是这个表达式读不到"
   *
   * 判据（team-lead 原样收下并写进交付说明）：**一条红读数必须自证** —— 要么带一个变了的数值，
   * 要么配一条未变异时的同读取值作对照。两者都没有的读数，"红了"和"没测到"读起来一样。
   */
  pointerEventsPair() {
    const ov = document.querySelector('.bp-overlap')
    const ctl = document.querySelector('.bp-paper > .bp-el')
    return {
      overlap: ov ? getComputedStyle(ov).pointerEvents : null,
      control: ctl ? getComputedStyle(ctl).pointerEvents : null,
      controlSel: ctl ? (ctl.getAttribute('data-el-id') || String(ctl.className)) : null,
      elCount: document.querySelectorAll('.bp-paper > .bp-el').length,
      overlapCount: document.querySelectorAll('.bp-overlap').length,
    }
  },
  /** ⑧：列手柄中心 vs 画出来的那条竖线的中心 */
  colHitGeom() {
    const el = document.querySelector('.bp-el.is-selected[class*="bp-el--table"]')
    if (!el) return { err: '没有选中的表格' }
    const tbl = el.querySelector('table.bp-el-table')
    const scale = this.scale() || 1
    const trs = Array.from(tbl.querySelectorAll('tbody > tr'))
    // 参照行必须没有合并格：colspan 会让这一行的 td 数少于列数，拿它当参照会整体错位（量法错，不是手柄错）
    const refTr = trs.find(tr => Array.from(tr.children).every(td => Number(td.getAttribute('colspan')||1) === 1 && Number(td.getAttribute('rowspan')||1) === 1)) || trs[0]
    const refTdEls = Array.from(refTr.children)
    const tds = refTdEls.map(td => td.getBoundingClientRect())
    const handles = Array.from(el.querySelectorAll('.bp-tbl-size__col')).map(h => { const r = h.getBoundingClientRect(); return { cx: Math.round((r.left + r.width/2)*100)/100, hitSelf: (() => { const hh = document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)); return hh === h || h.contains(hh) })() } })
    return {
      scale: Math.round(scale*1e4)/1e4,
      colgroupCols: el.querySelectorAll('colgroup > col').length,
      refRowTds: tds.length, handles: handles.length,
      // 画出来的那条竖线的**中心** = 该格 border-box 右沿 − 半个边框（border-collapse 下边框跨在两格之间）
      rows: handles.map((h, i) => tds[i] ? {
        cx: h.cx,
        drawn: Math.round((tds[i].right - 0.5*scale)*100)/100,
        d: Math.round((h.cx - (tds[i].right - 0.5*scale))*100)/100,
        // ⑧ 的 #6：**"半个边框"这个量从产品侧读，不在 helper 里自己乘。**
        //   产品代码 Canvas.tsx tableCss() 给每个格子下了 inline border
        //   （宽度 = nz(ptToPx(el.border.widthPt), 1)），所以
        //   getComputedStyle(td).borderRightWidth 就是"**产品设的**格线宽度"。
        //   · halfAssumed = 0.5*scale  —— 测试侧的假设（等价于"格线宽 1px"）
        //   · halfProduct = bw*scale/2 —— 产品 CSS 实读出来的
        //   两者相等，上面那个 drawn 才成立。
        bw: parseFloat(getComputedStyle(refTdEls[i]).borderRightWidth) || 0,
        halfAssumed: Math.round(0.5*scale*100)/100,
        halfProduct: Math.round(((parseFloat(getComputedStyle(refTdEls[i]).borderRightWidth) || 0) * scale / 2)*100)/100,
        hitSelf: h.hitSelf,
      } : { cx: h.cx, drawn: null, d: null, hitSelf: h.hitSelf }),
    }
  },
  /** ⑨：两个元素做重叠用的落点 */
  elInfo(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left*100)/100, t: Math.round(r.top*100)/100, r: Math.round(r.right*100)/100, b: Math.round(r.bottom*100)/100, w: Math.round(r.width), h: Math.round(r.height), sel: e.classList.contains('is-selected') } },
  /** 一个"点下去真能落到这个元素身上"的点（避开手柄） */
  grabPoint(sel) {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8]) for (const fy of [0.5, 0.35, 0.65]) {
      const x = Math.round(r.left + r.width*fx), y = Math.round(r.top + r.height*fy)
      const h = document.elementFromPoint(x, y)
      if (h && (h === e || e.contains(h)) && !h.closest('.bp-handle') && !h.closest('.bp-tbl-size')) return { x, y }
    }
    return null
  },
  /** 表格里某一格的中心（⑨ 的"格子装不下"反向对照要用） */
  cellPoint(row, col) {
    const td = document.querySelectorAll('.bp-el-table tbody tr')[row]?.querySelectorAll('td')[col]
    if (!td) return null
    const r = td.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) }
  },
  /** 纸张**外面**的一个点（仍在画布容器里，鼠标事件到得了） */
  offPaperPoint() {
    const paper = document.querySelector('.bp-paper')
    if (!paper) return null
    const r = paper.getBoundingClientRect()
    const cands = [
      { x: Math.round(r.left - 24), y: Math.round(r.top + r.height*0.5) },
      { x: Math.round(r.right + 24), y: Math.round(r.top + r.height*0.5) },
      { x: Math.round(r.left + r.width*0.5), y: Math.round(r.top - 18) },
    ]
    for (const c of cands) {
      if (c.x < 2 || c.y < 2 || c.x > innerWidth-2 || c.y > innerHeight-2) continue
      const h = document.elementFromPoint(c.x, c.y)
      if (!h) continue
      if (h.closest('.bp-paper')) continue
      if (!h.closest('.bp-canvas')) continue
      return { ...c, hitBy: String(h.className || h.tagName) }
    }
    return null
  },
  /** 网格内的一块空白（⑪ 的反向对照：能放下的地方 = 能打出来的地方） */
  freePoint() {
    const box = document.querySelector('.bp-content-box')
    if (!box) return null
    const r = box.getBoundingClientRect()
    const els = Array.from(document.querySelectorAll('.bp-paper .bp-el')).map(e => e.getBoundingClientRect())
    for (const fy of [0.72, 0.82, 0.6, 0.9, 0.5]) for (const fx of [0.08, 0.25, 0.5, 0.75, 0.92]) {
      const x = Math.round(r.left + r.width*fx), y = Math.round(r.top + r.height*fy)
      if (x < 2 || y < 2 || x > innerWidth-2 || y > innerHeight-2) continue
      const h = document.elementFromPoint(x, y)
      if (!h || h.closest('.bp-el') || h.closest('td')) continue
      if (els.some(b => x > b.left-10 && x < b.right+10 && y > b.top-10 && y < b.bottom+10)) continue
      return { x, y }
    }
    return null
  },
  /** 下页边距里的一个点（版心底边 与 纸张底边 之间） */
  bottomMarginPoint() {
    const paper = document.querySelector('.bp-paper'), cb = document.querySelector('.bp-content-box')
    if (!paper || !cb) return null
    const pr = paper.getBoundingClientRect(), cr = cb.getBoundingClientRect()
    const y = Math.round((cr.bottom + pr.bottom) / 2)
    const x = Math.round(pr.left + pr.width * 0.5)
    const hit = document.elementFromPoint(x, y)
    return { x, y, contentBottom: Math.round(cr.bottom), paperBottom: Math.round(pr.bottom), gapPx: Math.round(pr.bottom - cr.bottom), hitBy: hit ? String(hit.className || hit.tagName) : null }
  },
  paletteItem(text) {
    const b = Array.from(document.querySelectorAll('.bp-el-item')).find(e => (e.textContent||'').includes(text))
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  },
  /** 拖拽中的实时反馈（⑨⑪ 的"拖拽中就说清理由"） */
  liveHint() {
    const h = document.querySelector('.bp-drop-hint')
    const paper = document.querySelector('.bp-paper')
    return { hint: h ? (h.textContent||'').trim() : null, cls: h ? h.className : null, rejectRing: paper ? paper.className.includes('is-drop-reject') : null }
  },
  toast() { const t = document.querySelector('.bp-toast'); return t ? (t.textContent||'').trim() : null },
  scrollCanvasTo(where) { const c = document.querySelector('.bp-canvas'); if (!c) return null; c.scrollTop = where === 'bottom' ? c.scrollHeight : 0; return c.scrollTop },
}
true`

async function main() {
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

  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1500,950',
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
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    })

    console.log('\n[1] 打开插件并建一个带表格的模板（通用单据）')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tab=wizard` })
    await sleep(3000)
    await cdp.eval(HELPERS)
    await cdp.eval(GEO_HELPERS)

    await cdp.eval(`__bp.click('button','下一步：选模板')`)
    await sleep(900)
    await cdp.eval(`__bp.click('button','＋ 新建模板')`)
    await sleep(800)
    // 切到记录模板，选「通用单据」（它含一个 4 列信息表）
    await cdp.eval(`__bp.click('button','记录模板（一条记录一份）')`)
    await sleep(400)
    const picked = await cdp.eval(`(() => {
      const it = Array.from(document.querySelectorAll('.sk-item')).find(e => (e.textContent||'').includes('通用单据'))
      if (it) it.click(); return !!it
    })()`)
    ok('选到「通用单据」骨架', picked === true)
    await sleep(300)
    await cdp.eval(`__bp.click('button','创建并编辑')`)
    await sleep(3200)

    const editorReady = await cdp.eval(`__bp.count('.bp-el-table') > 0`)
    ok('编辑器打开且画布上有表格', editorReady === true, `表格数 ${await cdp.eval(`__bp.count('.bp-el-table')`)}`)

    // ------------------------------------------------------------
    console.log('\n[2] 点选表格内的单元格 → 属性面板要切到「单元格」而不是停在「表格」')
    const HINT = '在画布上点选某个单元格'
    const beforeHint = await cdp.eval(`__bp.text().includes(${JSON.stringify(HINT)})`)

    // 取一个单元格的中心点（用非表头、非标签的那一格更接近用户会点的位置）
    const cellPt = await cdp.eval(`(() => {
      const tds = Array.from(document.querySelectorAll('.bp-el-table td'))
      if (tds.length === 0) return null
      // 优先挑第二列（值列），更接近"用户想编辑字段"的位置
      const target = tds.find((td, i) => i % 4 === 1) || tds[0]
      const r = target.getBoundingClientRect()
      if (!r.width || !r.height) return null
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
               idx: tds.indexOf(target), total: tds.length }
    })()`)
    ok('能在画布上定位到一个单元格', Boolean(cellPt), JSON.stringify(cellPt))

    if (cellPt) {
      const beforeCell = await cdp.eval(`({
        hasHint: __bp.text().includes(${JSON.stringify(HINT)}),
        cellTextarea: !!document.querySelector('textarea[aria-label="单元格内容"]'),
        mergeBtn: !!document.querySelector('button[aria-label="与右侧单元格合并"]'),
        selectedCells: __bp.count('td.bp-el-cell.is-selected')
      })`)
      await clickAt(cdp, cellPt.x, cellPt.y, 1)
      await sleep(700)
      const afterCell = await cdp.eval(`({
        hasHint: __bp.text().includes(${JSON.stringify(HINT)}),
        cellTextarea: !!document.querySelector('textarea[aria-label="单元格内容"]'),
        mergeBtn: !!document.querySelector('button[aria-label="与右侧单元格合并"]'),
        selectedCells: __bp.count('td.bp-el-cell.is-selected'),
        text: __bp.text()
      })`)
      // ⚠️ 原来这条只判 `hasHint === false` —— 一条**否定式**证据。
      //    审计实测：把 Inspector 里那句"在画布上点选某个单元格"的引导整段删掉
      //    （变异 hint-gone）之后它**依然是绿的**：否定式证据在"引导从来没出现过"时也成立。
      //
      //    也不能简单改成"点击前引导必须在"：本脚本进编辑器时什么都没选中，面板停在
      //    「页面属性」，那句引导本来就不在（实测 beforeHint=false，一改就把基线弄红了）。
      //    真正不恒真的判据是"**点击前后变了**"：单元格专属的「单元格内容」输入框由无到有、
      //    画布上该格由未高亮变高亮。这两样都由 onSelectCell 驱动 ——
      //    把 onClick 里那句 onSelectCell 拿掉（变异 cell-select-off）就都不成立。
      ok(
        '点单元格后面板切到单元格上下文（「单元格内容」输入框与画布高亮由无到有；原有的"请点选单元格"引导消失）',
        beforeCell?.cellTextarea === false &&
          (beforeCell?.selectedCells ?? 0) === 0 &&
          afterCell?.cellTextarea === true &&
          (afterCell?.selectedCells ?? 0) >= 1 &&
          afterCell?.hasHint === false,
        `点击前 ${JSON.stringify(beforeCell)}（刚进编辑器时引导在不在=${beforeHint}）｜ 点击后 cellTextarea=${afterCell?.cellTextarea} 高亮格=${afterCell?.selectedCells} 引导仍在=${afterCell?.hasHint}`,
      )
      // ⚠️ 同样被打穿的是这条：原来判的是 `/合并|拆分|内边距|单元格底纹/.test(整页文本)`。
      //    把 Canvas 里 onClick 的 `onSelectCell` 拿掉（变异 cell-select-off，面板根本不会
      //    切到单元格）之后它**依然是绿的** —— 因为"表格"上下文的面板里本来就有
      //    「内边距」和「多记录合并」，而正则是扫**整个页面**的文本。
      //    改成只认**单元格上下文独有**的三样：内容输入框 / 与右格合并按钮 / 画布上该格高亮。
      //    （合并按钮只有 aria-label「与右侧单元格合并」，文字是图标 + 「右合并」，
      //      所以按 aria-label 取，不能按文字取。）
      ok(
        '面板里出现单元格专属控件（「单元格内容」输入框 + 「与右侧单元格合并」按钮 + 画布上该格被高亮）',
        afterCell?.cellTextarea === true && afterCell?.mergeBtn === true && (afterCell?.selectedCells ?? 0) >= 1,
        JSON.stringify({
          cellTextarea: afterCell?.cellTextarea,
          mergeBtn: afterCell?.mergeBtn,
          selectedCells: afterCell?.selectedCells,
        }),
      )
    }

    // ------------------------------------------------------------
    console.log('\n[3] 双击单元格 → 出现就地编辑输入')
    if (cellPt) {
      const boxesBefore = await cdp.eval(`__bp.count('.bp-inline-edit')`)
      await clickAt(cdp, cellPt.x, cellPt.y, 2)
      await sleep(800)
      const editState = await cdp.eval(`({
        cellEditBox: __bp.count('.bp-inline-edit--cell'),
        anyEditBox: __bp.count('.bp-inline-edit'),
        inputsAnywhere: __bp.count('input:not([type=hidden])') + __bp.count('textarea'),
        contentEditable: __bp.count('[contenteditable="true"]')
      })`)
      // ⚠️ 原来判的是"整页有没有 input / textarea / contenteditable"。
      //    审计实测：把双击处理里的 `beginEditing(...)` 拿掉（变异 cell-edit-off，
      //    双击根本不会进入就地编辑）之后它**依然是绿的** —— 属性面板自己就有一堆
      //    input/textarea，不管有没有进编辑态，计数都 > 0。断言跑在"缺陷看不见的层级"上。
      //    改成只认画布上的就地编辑框：Canvas.tsx 里 `cellEditing` 为真时才渲染的
      //    `<textarea class="bp-inline-edit bp-inline-edit--cell">`；
      //    并且要求"双击之前画布上一个编辑框都没有"，排除掉恒真。
      ok(
        '双击后出现就地编辑控件（画布上的 .bp-inline-edit--cell，不是"整页随便找得到 input"）',
        (boxesBefore ?? 0) === 0 && (editState?.cellEditBox ?? 0) > 0,
        `双击前画布上的编辑框=${boxesBefore} ｜ 双击后 ${JSON.stringify(editState)}`,
      )
      // 关掉编辑态，避免影响后续
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(400)
    }

    // ------------------------------------------------------------
    // [4] 画布几何：网格不越界（⑪）/ 占位框常显（⑩）/ 手柄命中区（⑧）/ 重叠被接受（⑨⑩）
    //
    // 为什么这四条挤在"单元格编辑"这个脚本里：它们和 `[2][3]` 是同一条用户路径上的
    // 兄弟问题（都是"在画布上点/拖"），而**冻结的 7 套套件里一条断言都没有** ——
    // 实现断言当时只存在于一次性探针 `_geom-verify.mjs` / `_geom-margin.mjs`。
    // 探针是证据、不是守卫：改了不会红。这里把它们升格成常驻断言。
    //
    // 判据一律走**渲染后的真实几何**（getComputedStyle / getBoundingClientRect /
    // 两个矩形的交集），不查 class 存在性 —— 本项目已经栽过一次
    // "querySelector 查得到 ≠ 用户看得见"。
    //
    // ## 一条红读数必须**自证**（本节的判据，也是压红时踩出来的）
    //
    // 要么它**带着一个变了的数值**（数值不可能由"页面崩了/模块没加载"伪造），
    // 要么它**配一条未变异时的同读取值作对照**。
    // **两者都没有的读数，"红了"和"没测到"读起来是一样的。**
    //
    // 这条不是推出来的，是压红时撞出来的两条实测教训 —— 它们形状相同：
    //
    // · **M10b**（不再渲染 `.bp-overlap`）：第一版变异写的是 `className="bp-overlap is-off"`，
    //   跑出来 **26 项全绿**。乍看像"断言是装饰"，其实是**变异没生效** ——
    //   `.bp-overlap` 这个选择器照样匹配得到。
    //   ⇒ **改动后仍全绿，先排除"变异没打上"，再怀疑断言。**
    //     （那段注释就挂在 `_mut-geom.mjs` 的 `M10b` 条目上。）
    //
    // · **B1**（撤销 `bodyOf` 的"参数表之后必须是 `=>`/`:`/`{`"判据）：第一版合成输入只写了
    //   一行 `const cols = (…)`，判据删掉后 `matchPair` 找不到 `{` 仍返回 `null`
    //   → **断言怎么写都能过**，看着像"这条规则被覆盖了"。
    //   ⇒ 合成输入必须**两段式**（后面跟一个真函数）才会红。
    //
    // · **M6**（⑧ #6 的"半个边框"改从产品侧读）—— **同一个形状第二次栽在同一个地方**：
    //   第一版变异改的是 `finite(el.border.widthPt, 0.75)` 里的**默认值**，而骨架自己设了
    //   `border.widthPt`，默认值根本不参与计算 ⇒ 格线宽度没变 ⇒ **27 项全绿**。
    //   （注释挂在 `_mut-geom.mjs` 的 `M6` 条目上。）
    //   ⇒ 说明这条不是"一次小心就行了"，而是**每次都要先排除"变异没生效"**。
    //
    // 两条合起来就是本节判据的那句话：**不要问"它红了没"，要问"它为什么红的 / 它凭什么红"。**
    //
    // ───────────────────────────────────────────────────────────────────────
    // `[4]` 的**覆盖账**：本节 17 条独立断言 = 10 条有专门压红它的变异 + 7 条没有
    //
    // 为什么写进文件：这份账原来**只在汇报消息里**，仓库里搜不到（独立验证实测 0 命中），
    // 下一个人只能自己重建。写成台账的另一个理由（team-lead 原话）：
    // **「不是实质断言」会被读成"不用管"；「未覆盖」是待办。** 两者在台账里的后果不同。
    //
    // 数法（可复算）：本节里 **ok 调用**（ok 紧跟左括号）共 **24 处**，其中
    //   · **1 处在注释里**（⑧ 那段"改过口径"的历史说明里引用了被删掉的旧写法）⇒ 真调用 **23 处**；
    //   · 真调用里 **6 处是失败兜底分支** = **2 处** `if (…) { … }`（`!pair` / `!grab`）+ **4 处** `} else { … }`
    //     —— 它们只在上面的分支失败时补一条 FAIL，**不是独立断言**。
    //     数法（**别记绝对行号**：注释一增删就会漂）—— `if (…) {` 或 `} else {` 的**下一行**是 ok 调用
    //     的那条就是兜底分支；本节实测 **2 + 4 = 6**。（本版在 716 / 725 与 782 / 798 / 814 / 834。）
    // ⇒ **独立断言 = 23 − 6 = 17 条**。下面按**源码顺序**编号（#1 = 本节第一条独立断言）。
    //   （独立验证给的"23 处"是真调用数；差的 1 处就是那行注释。两个数都对，只是口径不同。）
    //
    // ── (A) 有变异覆盖的 10 条 ──────────────────────────────────────────────
    //   #4  ⑪ 网格不越出版心                     ← M11（网格高 content.h + margin.bottom）  1 红
    //   #5  ⑩ 未选中元素也画占位框                ← M10a（.bp-el outline: none）             1 红
    //   #7  ⑧ 手柄中心 vs 竖线 偏差 ≤0.25px       ← M8（+0.5px 修正）／M6（格线 ×4）—— 两条都能压
    //   #8  ⑧ "半个边框"假设 == 产品实读的格线宽   ← M6b（格线去掉）**1 红且只有它红**；M6 时与 #7 同红
    //   #9  ⑩ 占位框不恒为同一样式                ← M7（.bp-el.is-selected 的 outline 退化）  1 红
    //   #10 ⑨ 拖到另一个元素上被接受              ← M9a（移动路径加回重叠限制）         与 #11/#12 同红
    //   #11 ⑩ 真有 .bp-overlap 且尺寸=交集        ← M10b（重叠块 class 改掉）／M9a   ┐ 两条变异都让它们
    //   #12 ⑩ 重叠区不吃鼠标事件                  ← M10b／M9a                        ┘ 同时红，从未单独红过
    //   #13 ⑩ 自证对照（对照节点必须读到真实值）   ← _teeth-control（对照选择器取不到）         1 红
    //   #16 ⑨⑪ 下页边距反向对照③                  ← M9b（删下页边距拒绝分支）                1 红
    //
    // ── (B) 没有变异覆盖的 7 条（两类，后果不同）────────────────────────────
    //   (B1) **前置 / 装置 · 同样未覆盖**，4 条 —— 它们**不直接声称用户需求，而是下游断言的前提**：
    //        #1 画布有网格层 ／ #2 画布有纸张节点 ／
    //        #3 纸张底部有下页边距（它自己的标题就写着"否则下面两条是空转"）／
    //        #6 手柄数 = colgroup 列数 = 参照行格数（下标一一对应的前提）
    //        ⚠️ 「前置 / 装置」是**用途**标签，不是豁免：这 4 条**同样是产品 DOM 读数**
    //           （网格层 / 纸张节点 / 下页边距宽度 / 手柄数与列数），条件不成立时**同样会红**，
    //           判据形式与 (B2) 无异 —— 它们缺的只是"专门压红它们的变异"。
    //           ⇒ 状态与 (B2) 一样是**未覆盖**，只是**理由不同**（(B1) 是前提，(B2) 是没打得到）。
    //   (B2) **实质断言，但未覆盖**，3 条 —— 断言的是产品行为，只是没有变异打得到：
    //        #14 ⑨ 投到纸张外 → 仍被拒且当场说出理由
    //        #15 ⑨ 投进表格单元格 → 仍被拒且理由说清"装不下"
    //        #17 ⑨ 正向对照：网格内空白处 → 正常落位（元素数 +1）
    //        它们测的是"取消重叠限制**没有顺手把别的拒绝理由一起取消**"，
    //        而 ⑨ 这组目前只有 M9a / M9b 两条变异，**打不到这三条**。
    //        ⇒ **未覆盖 ≠ 不是实质断言。** 独立验证第 12 组实测：删掉下页边距拒绝分支时
    //          **#16 单红、#14/#15/#17 纹丝不动** ⇒ 它们此刻是**未判定**，是**待办**。
    //
    // ── (C) 两处如实标注（不写就等于下一个人会踩）───────────────────────────
    //   · **#11 与 #12 的独立性未证**：M9a 与 M10b 两条变异都让它们**一起红**，
    //     从来没有一条变异只红其中一个 ⇒ 形态③门槛（压红 A 的变异不该同时压红 B）**未达成**。
    //   · **#13 的牙来自 `_teeth-control`**，而它**不在** `_mut-geom.mjs` 的默认清单里
    //     （`_teeth-*` 是牙口证明，跑它们必然退出码 4；混进"跑全部"只会带噪）。
    //     ⇒ 按默认清单跑一遍，**看不到 #13 红过** —— 证据来源在此标明，免得被当成装饰。
    //
    // ── (D) 判据的**环境余量**（与"被谁压红过"是**两条不同的可信度轴**）──────────
    //   只写"被压红过"，会让下面这两类**长得一样**，但它们的可信度差两个数量级：
    //     · `#7` 偏差 ≤0.25px  —— 实测基线 `0 / 0 / 0.02 / 0.02` ⇒ 余量 ≈ **12×**（阈值是量出来的，不是拍的）
    //     · `#4` 网格越界 ≤1px —— 实测 `0`                        ⇒ 余量 **1px**
    //     · `#14 / #15 / #17`（判据最后一跳是读 toast 文本）：
    //         **读太晚**方向 ≈ **300×** —— 产品侧 `EditorShell.tsx:223` 是 `setTimeout(() => setToast(null), 3200)`，
    //                                   而这条在松手后 ~10ms 就读；
    //         **读太早**方向 ≈ **283–421×**（**第 2 轮** N=8 实测，读数 `_geom/repeat-cell.txt`）——
    //           这三条的读发生在松手后 **~715ms**（`drag()` 结尾那句固定的 `sleep(700)` + 一次 CDP 往返），
    //           而 `.bp-toast` 真的进 DOM 实测 **1.7–2.5ms**（p50 2.2ms）
    //           ⇒ **下限余量 = `280×`**。（另有第 1 轮的一组数：`244–398×` / 下限 `241×` / `commit 1.8–2.9ms`
    //             / p50 2.3ms —— 但那一轮的原始 JSON 被**同名文件覆盖**了，**内容已失、只剩 `size=16952`**
    //             ⇒ 那组数**来自已失证据，不作独立证据，也不并入下限**。两轮冻结件只差这段注释，
    //             `_geom/_r17-e-mid.mjs` 与当时盘上那份规范化后逐字等价 ⇒ 同一份代码，别把"两次"当"两个版本"。）
    //           ⚠️ 但第 2 轮那 24 次实测也证明那 700ms 是**唯一**的等待：把读提前到 pointerup 的**同一刻**
    //             （捕获阶段同步读），**24/24 次全读错**（8 次读到空、16 次读到**上一条理由留下的旧 toast**
    //             —— 非 null、长得像个合理答案，比"读到空"更容易骗过眼睛）。
    //             ⇒ 「读太早」**不是假想的失效模式**，它只是正被那句 `sleep(700)` 挡着。
    //           （量法：`_geom/repeat-cell.mjs`，走"只加行、不碰冻结件"的临时仪器件，
    //             跑完逐字节核对原文件未动；装置本身另带 `--negctl` 阴性对照，实测 exit=3「没测到」。）
    //   ⇒ 这一块就是把**判据 10**（"测阈值的同时要钉住这个阈值不可能是虚设"）落到本账上。
    //     来源：render-fit 查自己第 13 节的墙钟门闩，发现 `dt >= 30` 而实测 **min 恰好 = 30（零余量）**，
    //     受控负载下 1/300 变红。我照同族形状查了本账 17 条 —— **负结果**：没有零余量的。
    //
    // ── (E) 本节全部变异的实测读数（本轮重取，逐条落 `_geom/_r16-rec-<id>.txt`）──
    //   M11→`❌ 1 项失败 / 共 27 项`   M10a→1   M8→1   M6→2   M6b→1
    //   M7→1   M9a→3（#10/#11/#12）   M9b→1   M10b→2（#11/#12）   _teeth-control→1（#13）
    //   十条全部 `已还原：内容逐字一致 = true`，且闸门 token 一律 `[已过闸门]`。
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n[4] 画布几何：网格 / 占位框 / 命中区 / 重叠 / 拒绝理由')
    await key(cdp, 'Escape')
    await key(cdp, 'Escape')
    await sleep(300)

    const canvasState = await cdp.eval(`({
      gridLayers: __bp.count('.bp-grid'),
      paper: __bp.count('.bp-paper, .bp-canvas-page, [class*="paper"]'),
      sizeText: (__bp.text().match(/\\d+\\s*[×x]\\s*\\d+\\s*mm/) || [null])[0]
    })`)
    ok('画布有网格层', (canvasState?.gridLayers ?? 0) > 0, JSON.stringify(canvasState))
    ok('画布有纸张节点', (canvasState?.paper ?? 0) > 0, JSON.stringify(canvasState))

    // ---- ⑪ 网格不越界：网格底边 = 版心底边（能放下的地方 = 能打印出来的地方）----
    const page = await cdp.eval(`__g.pageGeom()`)
    ok(
      '⑪ 纸张底部真的有一段下页边距（否则下面两条是空转）',
      (page?.bottomMarginPx ?? 0) > 4,
      `纸张底 ${page?.paper?.b} − 版心底 ${page?.box?.b} = ${page?.bottomMarginPx}px`,
    )
    const gridOut = page ? Math.round(Math.max(page.grid.b - page.box.b, page.box.t - page.grid.t) * 100) / 100 : null
    ok(
      '⑪ 网格不越出版心：底边贴版心底边、上边不低于版心上边（网格不许铺进下页边距）',
      gridOut !== null && gridOut <= 1,
      `网格 ${JSON.stringify(page?.grid)} ｜ 版心 ${JSON.stringify(page?.box)} ｜ 越界量 ${gridOut}px`,
    )

    // ---- ⑩ 占位框常显（读计算样式，不查 class；并与"选中"对照，证明不是恒为同一个样式）----
    const unselSel = await cdp.eval(`(() => {
      const e = Array.from(document.querySelectorAll('.bp-paper > .bp-el')).find(x => !x.classList.contains('is-selected'))
      return e ? '[data-el-id="' + e.getAttribute('data-el-id') + '"]' : null
    })()`)
    const fUn = unselSel ? await cdp.eval(`__g.frameOf(${JSON.stringify(unselSel)})`) : null
    ok(
      '⑩ 未选中的元素也画占位框（outlineStyle 非 none、宽度 > 0，且元素本身有尺寸）',
      !!fUn && fUn.sel === false && fUn.style !== 'none' && parseFloat(fUn.width) > 0 && fUn.w > 0,
      `未选中元素 ${unselSel} → outline=${fUn?.style} ${fUn?.width} ${fUn?.color}；尺寸 ${fUn?.w}×${fUn?.h}`,
    )

    // ---- ⑧ 手柄的**指针命中区**：手柄元素的中心必须压在画出来的那条竖线上 ----
    await cdp.eval(`__g.scrollCanvasTo('top')`)
    await sleep(400)
    const tblCellPt = await cdp.eval(`__g.cellPoint(0, 0)`)
    if (tblCellPt) {
      await clickAt(cdp, tblCellPt.x, tblCellPt.y, 1)
      await sleep(500)
      await key(cdp, 'Escape')
      await sleep(300)
    }
    const hit = await cdp.eval(`__g.colHitGeom()`)
    const ds = (hit?.rows ?? []).map((r) => r.d).filter((d) => d !== null).map(Math.abs)
    const maxD = ds.length ? Math.max(...ds) : null
    ok(
      '⑧ 每条列手柄都有对应的那条线（手柄数 = colgroup 列数 = 参照行格数，下标才一一对应）',
      !!hit && hit.handles === hit.colgroupCols && hit.colgroupCols === hit.refRowTds && hit.handles > 0,
      `手柄 ${hit?.handles} / <col> ${hit?.colgroupCols} / 参照行 td ${hit?.refRowTds}｜${JSON.stringify(hit?.err ?? null)}`,
    )
    // 阈值 0.25px 是**量出来的**，不是拍的：修完之后逐条是 0 / 0 / 0.02 / 0.02；
    // 而"不做那半个边框的修正"会带来 0.5×scale ≈ 0.56px 的偏移 —— 见下面那条反向读数。
    ok(
      `⑧ 缩放 ${hit?.scale}× 下，列表柄的中心与画出来的那条竖线的偏差 ≤ 0.25px`,
      maxD !== null && maxD <= 0.25,
      `最大偏差 ${maxD}px；逐条 ${JSON.stringify(hit?.rows)}`,
    )
    // ★ 这条**改过口径**（team-lead 裁的）。原来是：
    //     `ok(… (hit?.rows?.[0]?.halfBorder ?? 0) > 0.4 …)` 而 halfBorder = `0.5*scale` ——
    //   那是**测试自己乘出来的常数**，对任何 scale > 0.8 恒真 ⇒ **它测的东西不在产品里**
    //   （不是"还没被压红"，是"跟产品无关"，属于恒真/装饰那一族，只是披着"防阈值虚设"的外衣）。
    //   实测依据（`_geom/_r12-rec-M8.txt`）：改坏产品（M8）时它**仍然绿**。
    //
    //   改成**从产品侧读**：产品代码 `Canvas.tsx tableCss()` 给每个格子下了 inline border
    //   （宽度 = `nz(ptToPx(el.border.widthPt), 1)`），所以
    //   `getComputedStyle(td).borderRightWidth` 就是**产品设的**格线宽度，
    //   `halfProduct = bw × scale ÷ 2`。
    //   断言于是变成「**测试侧假设的半个边框 == 产品实际的半个边框**」——
    //   这才守得住 #7：`drawn = td.right − 0.5*scale` 是拿 `0.5*scale` 当"半个边框"用的。
    //
    // ⚠️ 这里原写的**存在理由**是：「一旦产品把格线改粗（bw ≠ 1px），`drawn` 就错了，
    //    而 **#5 自己看不见**（手柄与 drawn 一起没动，偏差仍是 0）。实测：变异 M6 只有这条红、#5 仍绿。」
    //    ⛔（以上为**被撤回的原文**，勿引用 —— 实测见下一段的留档：
    //       `_geom/_r16-rec-M6.txt` 与 `_geom/_r16-rec-M6b.txt`。原文保留不删，是为了留下"我们曾经写错过"的证据。）
    //    —— **这两句与实测相反，而且我自己的留档就能否证它**（独立验证抓到的）。已按实测改写：
    //      · **M6（格线 ×4）→ `❌ 2 项失败 / 共 27 项`：#7 也红**（最大偏差 1.7px）。
    //        原因：**格线变粗把 `td.right` 一起推走了**，`drawn` 跟着动 ⇒ #7 看得见。
    //        ⇒ "上面那条看不见"**不能**用 M6 立论。
    //      · **M6b（把格线整个去掉：mode==='all' → border: none）→ `❌ 1 项失败 / 共 27 项`，
    //        唯一 FAIL 就是这条**（bw=0px → halfProduct=0px，与 halfAssumed=0.56px 差 0.56px），
    //        而 **#7 仍绿**。这条"仍绿"**不是猜的**：计数本身就是证据 —— 27 项里只失败 1 项，
    //        而那 1 项是 #8；若 #7 也红，这里会是 2。（`_geom/_r16-rec-M6b.txt`）
    //    ⇒ **#8 的存在理由用 M6b 立论**：格线宽度一变，`halfProduct` 就失配 → 红，而 #7 在同一次里是绿的。
    //      它**不需要**靠"#7 看不见"来立论 —— "测试侧假设 == 产品实读"本身就有独立价值。
    //    编号：本条在**上面**的覆盖账里是 **#8**，它守的那条（偏差 ≤0.25px）是 **#7**；
    //    本条标题里那个 "#5" 是**本轮之前的旧编号**，按 team-lead"名字冻结"的要求**保留不改**，
    //    以覆盖账为准（两套编号并存，正是这里被读成"自相矛盾"的来源之一）。
    const r0 = hit?.rows?.[0]
    const halfGap = r0 && r0.halfProduct != null ? Math.abs(r0.halfProduct - r0.halfAssumed) : null
    ok(
      '⑧ #5 依赖的"半个边框"假设与**产品实际的格线宽度**一致（产品侧读数，不是 helper 常数）',
      halfGap !== null && halfGap <= 0.05 && (r0?.halfProduct ?? 0) > 0.4,
      `产品格线 borderRightWidth=${r0?.bw}px（scale=${hit?.scale}）→ halfProduct=${r0?.halfProduct}px；` +
        `测试侧假设 halfAssumed=0.5×scale=${r0?.halfAssumed}px；两者差 ${halfGap}px（阈值 ≤0.05）`,
    )
    // ⑩ 的反向读数：占位框**不是恒为同一个样式** —— 选中的那个（此刻是表格）必须与未选中的不同。
    // 没有这一条的话，"常显"可以靠"所有元素都画同一个框"糊过去，而那就分不出选中了谁。
    const fSel = await cdp.eval(`__g.frameOf('.bp-el.is-selected')`)
    ok(
      '⑩ 占位框不是"恒为同一个样式"：选中（表格）与未选中（文字元素）的 outline 读数确实不同',
      !!fUn && !!fSel && (fSel.style !== fUn.style || fSel.width !== fUn.width || fSel.color !== fUn.color),
      `未选中 ${fUn?.style}/${fUn?.width}/${fUn?.color} ｜ 选中 ${fSel?.style}/${fSel?.width}/${fSel?.color}`,
    )

    // ---- ⑨ + ⑩ 把一个元素拖到另一个元素上：允许交叠，且交叠处画出来 ----
    const pair = await cdp.eval(`(() => {
      const all = Array.from(document.querySelectorAll('.bp-paper > .bp-el'))
      const texts = all.filter(e => e.getAttribute('data-el-id') && /bp-el--text/.test(String(e.className)))
      const pick = (texts.length >= 2 ? texts : all.filter(e => e.getAttribute('data-el-id'))).slice(0, 2)
      return pick.length >= 2 ? pick.map(e => e.getAttribute('data-el-id')) : null
    })()`)
    if (!pair) {
      ok('⑨ 画布上有两个可拖元素（做交叠用例的前置条件）', false, '找不到两个带 data-el-id 的元素')
    } else {
      const [srcId, dstId] = pair
      const srcSel = `[data-el-id="${srcId}"]`
      const dstSel = `[data-el-id="${dstId}"]`
      const ovBefore = await cdp.eval(`__g.count('.bp-overlap')`)
      const grab = await cdp.eval(`__g.grabPoint(${JSON.stringify(srcSel)})`)
      const dstC = await cdp.eval(`__g.grabPoint(${JSON.stringify(dstSel)})`)
      if (!grab || !dstC) {
        ok('⑨ 两个元素都拿得到一个能按下去的点（做交叠用例的前置条件）', false, JSON.stringify({ grab, dstC }))
      } else {
        await drag(cdp, grab, dstC, 14)
        const a = await cdp.eval(`__g.elInfo(${JSON.stringify(srcSel)})`)
        const b = await cdp.eval(`__g.elInfo(${JSON.stringify(dstSel)})`)
        const ix = a && b ? Math.round((Math.min(a.r, b.r) - Math.max(a.l, b.l)) * 100) / 100 : 0
        const iy = a && b ? Math.round((Math.min(a.b, b.b) - Math.max(a.t, b.t)) * 100) / 100 : 0
        ok(
          '⑨ 把一个元素拖到另一个元素上 → **被接受**（没被弹回，两个矩形真的相交了）',
          ix > 2 && iy > 2,
          `交叠 ${ix}×${iy}px；拖前重叠块 ${ovBefore} 个；src=${JSON.stringify(a)} dst=${JSON.stringify(b)}`,
        )
        await sleep(400)
        const ovs = await cdp.eval(`__g.overlaps()`)
        ok(
          '⑩ 两元素交叠时画布上**真有** .bp-overlap，且尺寸 = 两个矩形的**交集**（±2px）',
          ovBefore === 0 && ovs.length >= 1 && Math.abs(ovs[0].w - ix) <= 2 && Math.abs(ovs[0].h - iy) <= 2,
          `重叠块 ${ovs.length} 个 ${JSON.stringify(ovs)} vs 交集 ${ix}×${iy}px`,
        )
        // ⚠️ 这条原来是**无数值读数**：detail 只有 `pointer-events=${ovs.map(o=>o.pe).join()}`
        //    —— 元素不存在时读到的是**空串**，而"页面/模块没加载出来"读到的也是空串。
        //    按判据（一条红读数必须自证）补上：① 主断言 detail 里带上**同表达式的对照读数**；
        //    ② 对照单独成一条断言 —— 页面坏了时是**对照那条**先红，指名"是读数本身读不到"。
        const pePair = await cdp.eval(`__g.pointerEventsPair()`)
        ok(
          '⑩ 重叠区不吃鼠标事件（pointer-events:none，否则压在下面的那个元素点不中）',
          ovs.length >= 1 && ovs.every((o) => o.pe === 'none'),
          `pointer-events=${ovs.map((o) => o.pe).join()}；重叠块 ${ovs.length} 个 ${JSON.stringify(ovs)}；` +
            `同表达式对照读数（取一定存在的元素节点）=${JSON.stringify(pePair?.control)}`,
        )
        ok(
          '⑩ 上面那条读数的自证对照：同一表达式在**一定存在**的节点上必须读到真实值（"读到空"≠"模块没加载"）',
          pePair?.control === 'auto' && pePair?.elCount >= 1,
          `对照节点 ${pePair?.controlSel} → pointer-events=${JSON.stringify(pePair?.control)}（应为 "auto"）；` +
            `画布元素 ${pePair?.elCount} 个；重叠块节点读数 ${JSON.stringify(pePair?.overlap)}；重叠块 ${pePair?.overlapCount} 个`,
        )
      }
    }

    // ---- ⑨ 三条**反向对照**：取消重叠限制，**没有**顺手把别的拒绝理由一起取消 ----
    await key(cdp, 'Escape')
    await cdp.eval(`__g.tab('元素')`)
    await sleep(500)
    const n0 = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)

    const off = await cdp.eval(`__g.offPaperPoint()`)
    const itTable = await cdp.eval(`__g.paletteItem('表格')`)
    if (off && itTable) {
      const live = await drag(cdp, itTable, { x: off.x, y: off.y }, 14, `__g.liveHint()`)
      const n1 = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)
      const toast = await cdp.eval(`__g.toast()`)
      ok(
        '⑨ 反向对照①：投到**纸张外** → 仍然被拒，并当场把理由说出来（"不在纸张上"这条还在）',
        n1 === n0 && /不在纸张上/.test(toast ?? ''),
        `元素数 ${n0} → ${n1}；落点 ${JSON.stringify(off)}；拖拽中 ${JSON.stringify(live)}；toast=${JSON.stringify(toast)}`,
      )
    } else {
      ok('⑨ 反向对照①：投到纸张外 → 仍然被拒（"不在纸张上"这条还在）', false, `找不到纸张外的落点或面板项：${JSON.stringify({ off, itTable })}`)
    }

    const n1b = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)
    const cellP = await cdp.eval(`__g.cellPoint(0, 0)`)
    const itTable2 = await cdp.eval(`__g.paletteItem('表格')`)
    if (cellP && itTable2) {
      await drag(cdp, itTable2, { x: cellP.x, y: cellP.y }, 14)
      const n2 = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)
      const toast2 = await cdp.eval(`__g.toast()`)
      ok(
        '⑨ 反向对照②：把表格投进**表格单元格** → 仍然被拒，理由说清"装不下"（这条还在）',
        n2 === n1b && /装不下/.test(toast2 ?? ''),
        `元素数 ${n1b} → ${n2}；落点 ${JSON.stringify(cellP)}；toast=${JSON.stringify(toast2)}`,
      )
    } else {
      ok('⑨ 反向对照②：把表格投进表格单元格 → 仍然被拒（"格子装不下"这条还在）', false, `找不到单元格或面板项：${JSON.stringify({ cellP, itTable2 })}`)
    }

    const n2b = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)
    const bm = await cdp.eval(`__g.bottomMarginPoint()`)
    const itTable3 = await cdp.eval(`__g.paletteItem('表格')`)
    if (bm && itTable3) {
      const live3 = await drag(cdp, itTable3, { x: bm.x, y: bm.y }, 14, `__g.liveHint()`)
      const n3 = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)
      const toast3 = await cdp.eval(`__g.toast()`)
      ok(
        '⑨⑪ 反向对照③：投到**下页边距** → 拖拽中就是禁止态并说明理由，松手被拒（这条还在）',
        n3 === n2b && /下页边距/.test(toast3 ?? '') && live3?.rejectRing === true && /下页边距/.test(live3?.hint ?? ''),
        `元素数 ${n2b} → ${n3}；下页边距 ${JSON.stringify(bm)}；拖拽中 ${JSON.stringify(live3)}；toast=${JSON.stringify(toast3)}`,
      )
    } else {
      ok('⑨⑪ 反向对照③：投到下页边距 → 被拒并说明理由', false, `找不到下页边距里的点或面板项：${JSON.stringify({ bm, itTable3 })}`)
    }

    // 正向对照：能放下的地方（网格内空白）必须真的放得下 —— 否则上面三条"被拒"可能只是"整个投放都坏了"
    const n3b = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)
    const fp = (await cdp.eval(`__g.freePoint()`)) ?? (await (async () => {
      await cdp.eval(`__g.scrollCanvasTo('bottom')`)
      await sleep(500)
      return cdp.eval(`__g.freePoint()`)
    })())
    const itText = await cdp.eval(`__g.paletteItem('文本')`)
    if (fp && itText) {
      await drag(cdp, itText, { x: fp.x, y: fp.y }, 14)
      const n4 = await cdp.eval(`__g.count('.bp-paper > .bp-el')`)
      ok(
        '⑨ 正向对照：投到网格内的空白处 → 正常落位（元素数 +1）',
        n4 === n3b + 1,
        `元素数 ${n3b} → ${n4}；落点 ${JSON.stringify(fp)}`,
      )
    } else {
      ok('⑨ 正向对照：投到网格内的空白处 → 正常落位', false, `找不到空白落点或面板项：${JSON.stringify({ fp, itText })}`)
    }
    await key(cdp, 'Escape')
    await cdp.eval(`__g.scrollCanvasTo('top')`)
    await sleep(300)

    // ------------------------------------------------------------
    console.log('\n[5] 二维码 / 条形码 / 打印时间 是否真的在左栏里')
    await cdp.eval(`__bp.click('button','元素')`)
    await sleep(600)
    const paletteText = await cdp.eval(`__bp.text()`)
    ok('元素面板有「二维码」', /二维码/.test(paletteText))
    ok('元素面板有「条形码」', /条形码/.test(paletteText))
    ok('系统变量里有「打印时间」', /打印时间/.test(paletteText))

    // ------------------------------------------------------------
    console.log('\n[6] 「完成」能正常返回（不再卡在编辑器）')
    await cdp.eval(`__bp.click('button','完成')`)
    await sleep(1500)
    const back = await cdp.eval(`({
      backToList: __bp.byText('button','下一步：预览').length > 0,
      stillEditor: __bp.byText('button','完成').length > 0
    })`)
    ok('点「完成」后回到向导（不在编辑器里卡住）', back?.backToList === true, JSON.stringify(back))
  } finally {
    try {
      if (cdp) void cdp.send('Browser.close').catch(() => {})
    } catch {}
    await sleep(300)
    child.kill()
    await sleep(600)
  }

  console.log('\n' + '='.repeat(52))
  if (failures.length === 0) console.log(`✅ 单元格编辑专项全部通过：${pass} 项`)
  else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(52))

  // 结论行与退出码已经定了，清理放在它们**之后**且 best-effort：rmSync 是同步的，
  // 浏览器刚被 kill 时 profile 里的文件常还被占着，带 maxRetries 会把事件循环卡住，
  // 反而连结论行都打不出来。profileDir 在 os.tmpdir() 下，删不掉也无妨。
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {}
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('专项验证脚本崩溃：', e)
  process.exit(1)
})
