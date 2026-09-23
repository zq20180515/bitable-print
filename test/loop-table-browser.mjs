/**
 * 真实浏览器端到端验证：视图模板「循环区连续大表」（TableElement.rowsFromRecords）。
 *
 * 为什么单靠 Node 层的测试不够：
 *   test/loop-table-merge-test.ts 走的是 `skipMeasure` / 模拟行高 —— 分页拿到的行高
 *   是"喂进去的估计值"。真实链路是 measure.ts 的 **实测 DOM 行高**（按 <tr> 逐个量）
 *   交给 layout.ts 的 splitTable 按行拆分。这条链路只有在浏览器里跑才会被覆盖。
 *   关键风险点：measureBlocks 量不到行高时会退化成"按行数均分"的估算兜底，
 *   行高估错就会多切页 / 把行切到不该切的位置 —— 表现为丢行或重复行。
 *
 * 本脚本要证明的（每条断言都打印实测数字）：
 *   1) 记录不多时，连续大表在预览里是 1 个 <table>，行数 = 表头 + 记录数，序号 1..N 连续
 *   2) 撑过一页时，每页各有 1 个 <table> 续排片段，每页都有列头，序号串起来是 1..N 不重不漏
 *   3) 跨页后数据行合计恰好 = 打印范围内的记录数（不丢行）
 *   4) 无 console 错误 / 未捕获异常；无 loop-table-conflict；不引入新的阻断级警告
 *   5) 对照 A：同模板把开关关掉 → 必须回到"每条记录一张小表"（证明断言不是恒真的）
 *   6) 对照 B：换成记录模板骨架 → 行为与开关无关（循环区仍按记录重复）
 *
 * 运行（需要 dev server 已在 baseUrl 上跑着）：
 *   node test/loop-table-browser.mjs [baseUrl]
 *
 * 不依赖任何第三方库：Node 22 自带全局 WebSocket，CDP 直接手写。
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const BASE = process.argv[2] ?? 'http://localhost:5190'
/** 9366 / 9368 / 9369 / 9333 已被仓库里其它脚本占用 */
const PORT = 9371

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/**
 * profile 目录建在系统临时目录下。
 * 项目根已经被 65 个残留 `.e2e-profile-*` 目录污染了，不要再往里加。
 */
const profileDir = join(tmpdir(), `bp-loopbrowser-${Date.now().toString(36)}`)

const T0 = Date.now()

// ============================================================
// 断言
// ============================================================

let pass = 0
const failures = []
const observations = []
const consoleErrors = []
const exceptions = []

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 只做记录、不断言的观察值：这类"看着不对但断言没覆盖"的东西往往比断言本身更有价值 */
function observe(title, value) {
  observations.push(`${title}：${value}`)
  console.log(`  NOTE  ${title}：${value}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ============================================================
// CDP 极简客户端
// ============================================================

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.closed = false
    ws.addEventListener('message', (ev) => {
      // 文本帧在 Node 的 WebSocket 里是 string；万一拿到其它类型，先转成字符串再解析，
      // 否则 JSON.parse 抛错会把这条响应吞掉，调用方只能干等到超时。
      let raw = ev.data
      if (typeof raw !== 'string') {
        try {
          raw = typeof raw === 'object' && raw && 'text' in raw ? String(raw.text) : String(raw)
        } catch {
          return
        }
      }
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        exceptions.push(d.exception?.description ?? d.text ?? 'unknown exception')
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const url = msg.params.entry.url ? ` <${msg.params.entry.url}>` : ''
        consoleErrors.push(`[log] ${msg.params.entry.text}${url}`)
      }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, { reject }] of this.pending) reject(new Error('CDP 连接已关闭（浏览器进程退出了？）'))
      this.pending.clear()
    })
  }

  send(method, params = {}, timeoutMs = 90000) {
    this.id++
    const id = this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          // 带上表达式片段：画布上的命中测试类 eval 偶尔会很慢，有片段才定位得到是哪一条
          const hint = typeof params.expression === 'string' ? ` :: ${params.expression.slice(0, 70)}` : ''
          reject(new Error(`CDP 超时: ${method}${hint}`))
        }
      }, timeoutMs)
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate 失败')
    return res.result?.value
  }

  /** 读类 eval：超时（多半是页面上有别的重活在跑）后再试一次，用于不会产生副作用的表达式 */
  async read(expression) {
    try {
      return await this.eval(expression)
    } catch (e) {
      if (!/超时/.test(String(e?.message))) throw e
      await sleep(2000)
      return this.eval(expression)
    }
  }
}

// ============================================================
// 页面辅助
// ============================================================

const HELPERS = `
window.__bp = {
  byText(sel, text) {
    return Array.from(document.querySelectorAll(sel))
      .filter(e => (e.textContent || '').trim() === text || (e.textContent || '').includes(text));
  },
  byExactText(sel, text) {
    return Array.from(document.querySelectorAll(sel))
      .filter(e => (e.textContent || '').trim() === text);
  },
  clickText(sel, text) {
    const el = this.byExactText(sel, text)[0] || this.byText(sel, text)[0];
    if (!el) return false;
    el.click();
    return true;
  },
  count(sel) { return document.querySelectorAll(sel).length; },
  text(sel) { const e = document.querySelector(sel); return e ? e.textContent : null; },
  /** 「记录数」这类事实卡片的读数 */
  fact(key) {
    const facts = Array.from(document.querySelectorAll('.wiz-fact'));
    for (const f of facts) {
      const k = f.querySelector('.wiz-fact-k');
      if (k && (k.textContent || '').trim() === key) {
        const v = f.querySelector('.wiz-fact-v');
        return v ? (v.textContent || '').trim() : null;
      }
    }
    return null;
  },
};
/** 读预览 iframe 里的真实纸张 DOM：逐页、逐表格、逐行 */
window.__bpProbe = function () {
  const f = document.querySelector('.wiz-prev-frame');
  if (!f || !f.contentDocument) return null;
  const d = f.contentDocument;
  const pages = Array.from(d.querySelectorAll('section.bp-page'));
  return {
    pageCount: pages.length,
    pages: pages.map(function (pg, pi) {
      const tables = Array.from(pg.querySelectorAll('.bp-el-table')).map(function (box) {
        const t = box.querySelector('table');
        if (!t) return { el: box.getAttribute('data-el'), tr: 0, thead: 0, tbody: 0, rows: [], rowMm: [] };
        const trs = Array.from(t.querySelectorAll('tr'));
        return {
          el: box.getAttribute('data-el'),
          tr: trs.length,
          thead: t.querySelectorAll('thead tr').length,
          tbody: t.querySelectorAll('tbody tr').length,
          rows: trs.map(function (tr) {
            const tds = Array.from(tr.querySelectorAll('td'));
            return {
              first: tds.length ? (tds[0].textContent || '').replace(/\\s+/g, ' ').trim() : '',
              text: (tr.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
            };
          }),
          /*
           * 逐行**实测**高度（mm）。这是本脚本的关键探针：分页用的是 measure.ts 量出来的行高，
           * 量不到时会退化成"按行数均分、每行 8mm"的估算兜底。把真实行高读回来，
           * 才能证明分页跑在真实测量值上，而不是兜底值（8mm × 30 行/页 是完全不同的形状）。
           */
          rowMm: trs.map(function (tr) {
            return Math.round((tr.getBoundingClientRect().height / (96 / 25.4)) * 100) / 100;
          }),
        };
      });
      return { page: pi + 1, tables: tables };
    }),
  };
};
/** 读向导里的检查结果面板（先展开） */
window.__bpWarnOpen = function () {
  const secs = Array.from(document.querySelectorAll('.app-section'));
  for (const s of secs) {
    const h = s.querySelector('.app-section-title');
    if (h && (h.textContent || '').includes('检查结果')) {
      const btn = s.querySelector('.wiz-alert-toggle');
      if (btn) btn.click();
      return true;
    }
  }
  return false;
};
window.__bpWarn = function () {
  const out = { blocking: null, panel: null, sections: [] };
  const bt = document.querySelector('.wiz-alert.danger .wiz-alert-title');
  if (bt) out.blocking = (bt.textContent || '').trim();
  const secs = Array.from(document.querySelectorAll('.app-section'));
  for (const s of secs) {
    const h = s.querySelector('.app-section-title');
    if (!h) continue;
    const title = (h.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!title.includes('检查结果')) continue;
    out.panel = title;
    const labels = Array.from(s.querySelectorAll('.wiz-note-label')).map(function (n) {
      return (n.textContent || '').trim();
    });
    const items = Array.from(s.querySelectorAll('.wiz-block-list li')).map(function (li) {
      return (li.textContent || '').replace(/\\s+/g, ' ').trim();
    });
    out.sections.push({ title: title, labels: labels, items: items });
  }
  return out;
};
true
`

async function waitFor(cdp, expr, timeoutMs = 15000, label = '') {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try {
      v = await cdp.eval(expr)
    } catch {
      v = false
    }
    if (v) return true
    if (Date.now() - t0 > timeoutMs) {
      console.log(`  （等待超时：${label || expr}）`)
      return false
    }
    await sleep(200)
  }
}

/** 在视口坐标处派发一次真实指针点击（Chromium 会据此合成 pointerdown/mouseup/click） */
async function dispatchClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

/** 真实指针点击：滚动到视野内 + 与视口求交，避免点到被裁掉的位置或固定底栏上 */
async function realClick(cdp, selectorExpr) {
  const pt = await cdp.eval(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right);
    const y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
    if (x1 - x0 < 3 || y1 - y0 < 3) return null;
    return { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
  })()`)
  if (!pt) return false
  await dispatchClick(cdp, pt.x, pt.y)
  return true
}

/** 优先真实指针；元素不可见（零尺寸/被裁）时退回 JS click，保证流程不因一个按钮卡死 */
async function tap(cdp, selectorExpr) {
  if (await realClick(cdp, selectorExpr)) return 'pointer'
  return (await cdp.eval(`(() => { const el = ${selectorExpr}; if (!el) return false; el.click(); return true; })()`))
    ? 'js'
    : 'miss'
}

/**
 * 在目标元素矩形内采样，返回一个**确实落在该元素上**的视口坐标。
 *
 * 为什么不能取中心点：编辑器画布里，循环区/表尾区的元素是按"版式区内部坐标"画的，
 * 会和其它版式区的元素重叠，中心点很可能被别的元素盖住（elementFromPoint 会返回别人）。
 * 所以这里撒点 + elementFromPoint 过滤，只认真正命中目标的点。
 */
async function pointInside(cdp, selectorExpr) {
  return cdp.eval(`(() => {
    const t = ${selectorExpr};
    if (!t) return null;
    try { t.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = t.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // 先试中心点（绝大多数情况一次就中）；被别的元素盖住再退化成撒点扫描
    const cands = [[0.5, 0.5]];
    for (let gy = 1; gy <= 11; gy++) for (let gx = 1; gx <= 11; gx++) cands.push([gx / 12, gy / 12]);
    for (const c of cands) {
      const x = Math.round(r.left + r.width * c[0]);
      const y = Math.round(r.top + r.height * c[1]);
      if (x < 2 || y < 2 || x > vw - 3 || y > vh - 3) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && t.contains(hit)) return { x: x, y: y };
    }
    return null;
  })()`)
}

/**
 * 在画布上选出"循环区那张表格"，并确认属性面板里出现了可用的
 * 「连续打印」开关。
 *
 * 判定标准是"面板里出现该开关且 disabled=false"（= 循环区唯一元素，正是渲染层
 * mergedLoopTableOf 的生效条件），所以这个函数同时也在验证"我点的确实是那张表"。
 */
async function selectLoopTable(cdp) {
  // 编辑器刚打开时 React 还在挂载/测量，先等画布上真的出现表格再撒点命中测试
  await waitFor(cdp, `__bp.count('.bp-canvas .bp-el--table') > 0`, 10000, '画布上出现表格')
  await sleep(300)
  const total = await cdp.eval(`__bp.count('.bp-canvas .bp-el--table')`)
  for (let i = 0; i < total; i++) {
    const pt = await pointInside(cdp, `document.querySelectorAll('.bp-canvas .bp-el--table')[${i}]`)
    if (!pt) {
      const diag = await cdp.eval(`(() => {
        const t = document.querySelectorAll('.bp-canvas .bp-el--table')[${i}];
        if (!t) return 'no-element';
        const r = t.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                 vp: [window.innerWidth, window.innerHeight],
                 hit: hit ? String(hit.className).slice(0, 50) : null,
                 hitInSelf: hit ? t.contains(hit) : null };
      })()`)
      console.log(`  （第 ${i + 1} 张表采样不到可点位置：${JSON.stringify(diag)}）`)
      continue
    }
    await dispatchClick(cdp, pt.x, pt.y)
    // 点到单元格会切到"单元格属性"面板（要等一下它渲染出来）→ 用面包屑退回整表面板。
    // 没这一步就是等一个不会出现的开关。
    await waitFor(
      cdp,
      `document.querySelector('.bp-crumb__link') != null || document.querySelector('button[aria-label="连续打印"]') != null`,
      8000,
      `第 ${i + 1} 张表的属性面板`,
    )
    await sleep(200)
    await cdp.eval(`(() => { const b = document.querySelector('.bp-crumb__link'); if (b) b.click(); return true; })()`)
    await sleep(300)
    const st = await cdp.eval(`(() => {
      const s = document.querySelector('button[aria-label="连续打印"]');
      const hints = Array.from(document.querySelectorAll('.bp-hint')).map(function (e) { return (e.textContent || '').trim(); });
      return {
        has: !!s,
        checked: s ? s.getAttribute('aria-checked') : null,
        disabled: s ? s.disabled : null,
        hint: hints.find(function (h) { return h.includes('各条记录各占一行') || h.includes('开关不生效'); }) || null,
      };
    })()`)
    if (st.has && st.disabled === false) return { index: i, total, ...st }
    console.log(`  （第 ${i + 1} 张表没命中循环区：${JSON.stringify(st)}）`)
  }
  return null
}

/**
 * 把循环区表格某一格的文本内容改成 `value`（用 React 认得的原生 setter + input 事件）。
 * 用途：通用清单骨架里有「单位」「备注」两列在本地 mock 表里找不到对应字段，
 * 骨架会**故意**留成未绑定占位符（设计如此，由用户改绑）。把它们清空，
 * 模拟"用户改完绑"，这样"无阻断级警告"这条断言才有意义、也不恒真。
 */
async function setCellText(cdp, tableIndex, rowIndex, colIndex, value) {
  const pt = await pointInside(
    cdp,
    `(() => {
      const tb = document.querySelectorAll('.bp-canvas .bp-el--table')[${tableIndex}];
      if (!tb) return null;
      const tr = tb.querySelectorAll('tr')[${rowIndex}];
      if (!tr) return null;
      return tr.querySelectorAll('td')[${colIndex}] || null;
    })()`,
  )
  if (!pt) return false
  await dispatchClick(cdp, pt.x, pt.y)
  await sleep(350)
  const res = await cdp.eval(`(() => {
    const ta = document.querySelector('textarea[aria-label="单元格内容"]');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(value)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`)
  await sleep(350)
  return res === 'ok'
}

// ============================================================
// 向导流程
// ============================================================

const BTN_NEXT_TPL = `Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '下一步：选模板')`
const BTN_NEXT_PREVIEW = `Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '下一步：预览')`
const BTN_BACK = `Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '上一步')`

async function gotoStep0(cdp) {
  for (let i = 0; i < 4; i++) {
    if (await cdp.eval(`${BTN_NEXT_TPL} != null`)) return true
    // 子面板（骨架选择器）自带按钮，底部栏让位 —— 先退出来
    await cdp.eval(`__bp.clickText('button', '返回')`)
    await sleep(200)
    await cdp.eval(`__bp.clickText('button', '上一步')`)
    await sleep(500)
  }
  return await cdp.eval(`${BTN_NEXT_TPL} != null`)
}

async function gotoStep1(cdp) {
  await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
  return waitFor(cdp, `${BTN_NEXT_PREVIEW} != null`, 12000, '步骤②（选模板）')
}

async function gotoPreview(cdp) {
  await cdp.eval(`__bp.clickText('button', '下一步：预览')`)
  const seen = await waitFor(
    cdp,
    `(() => { const p = __bpProbe(); return !!p && p.pageCount > 0; })()`,
    40000,
    '预览产物渲染完成',
  )
  // 让 iframe 的 onLoad 后置测量跑完（PreviewFrame 里 120ms / 600ms 补量）
  await sleep(400)
  return seen
}

async function createFromSkeleton(cdp, skeletonName, kindLabel) {
  await cdp.eval(`__bp.clickText('button', '＋ 新建模板')`)
  await waitFor(cdp, `__bp.count('.sk-item') > 0`, 10000, '骨架列表')
  if (kindLabel) {
    await cdp.eval(`__bp.clickText('button', '${kindLabel}')`)
    await sleep(400)
  }
  const picked = await cdp.eval(`(() => {
    const item = Array.from(document.querySelectorAll('.sk-item'))
      .find(e => (e.textContent || '').includes('${skeletonName}'));
    if (!item) return false;
    item.click();
    return true;
  })()`)
  if (!picked) return false
  await sleep(300)
  await cdp.eval(`__bp.clickText('button', '创建并编辑')`)
  return waitFor(cdp, `__bp.byText('button','完成').length > 0`, 20000, '编辑器打开')
}

/** 从步骤②（选模板）用模板卡片上的「···」→「在侧边栏编辑」重新进编辑器 */
async function openEditorFromStep1(cdp) {
  const menu = await tap(cdp, `document.querySelector('.wiz-tpl [aria-label="更多操作"]')`)
  await sleep(350)
  const edit = await cdp.eval(`__bp.clickText('button', '在侧边栏编辑')`)
  if (edit !== true) return false
  return waitFor(cdp, `__bp.byText('button','完成').length > 0`, 20000, '编辑器打开')
}

/** 读完当前预览页的所有指标（含检查结果面板） */
async function readPreview(cdp) {
  // 预览步（step 2）的读数在 .wiz-sum-title / .wiz-sum-meta 上；
  // 「记录数」事实卡片只出现在步骤①与输出步，所以这里以预览摘要为准，事实卡片兜底。
  const sum = await cdp.eval(`({
    title: (document.querySelector('.wiz-sum-title') || {}).textContent || null,
    meta: (document.querySelector('.wiz-sum-meta') || {}).textContent || null,
    factRecords: __bp.fact('记录数'),
    factPages: __bp.fact('页数'),
  })`)
  const probe = await cdp.eval(`__bpProbe()`)
  await cdp.eval(`__bpWarnOpen()`)
  await sleep(250)
  const warn = await cdp.eval(`__bpWarn()`)
  const recordCount =
    Number(String(sum?.factRecords ?? '').replace(/[^\d]/g, '')) ||
    Number((String(sum?.meta ?? '').match(/(\d+)\s*条记录/) ?? [])[1] ?? 0)
  const pageCount =
    Number(String(sum?.factPages ?? '').replace(/[^\d]/g, '')) ||
    Number((String(sum?.title ?? '').match(/共\s*(\d+)\s*页/) ?? [])[1] ?? 0)
  return { sum, recordCount, pageCount, probe, warn }
}

/**
 * 勾选列表里勾上前 n 条。
 * 注意：切到「手动勾选」时向导会自动预选"多维表格里当前停留的那条"（mock 固定第 3 条），
 * 所以不能盲点前 n 个复选框 —— 会把预选的那条又点掉。这里逐个确认"第 i 行已勾上"。
 */
async function pickFirstN(cdp, n) {
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const isOn = await cdp.eval(
        `(() => { const r = document.querySelectorAll('.wiz-pick-row')[${i}]; return !!r && r.classList.contains('on'); })()`,
      )
      if (isOn) break
      await tap(cdp, `document.querySelectorAll('.wiz-pick-row input[type=checkbox]')[${i}]`)
      await sleep(180)
    }
  }
  return cdp.eval(`__bp.count('.wiz-pick-row.on')`)
}

/**
 * 点一个 role=switch 的按钮并**确认它真的翻转了**。
 * 不写成"点一下再断言"是因为页面偶发卡顿时点击可能落空；
 * 这里以"读到的状态"为准，没翻就再点一次（最多 3 次），避免偶发一次点击丢掉整个用例。
 */
async function toggleSwitch(cdp, ariaLabel, expect) {
  const sel = `document.querySelector('button[aria-label="${ariaLabel}"]')`
  for (let i = 0; i < 3; i++) {
    const cur = await cdp.read(`(() => { const b = ${sel}; return b ? b.getAttribute('aria-checked') : null; })()`)
    if (cur === expect) return expect
    await tap(cdp, sel)
    await waitFor(
      cdp,
      `(() => { const b = ${sel}; return !!b && b.getAttribute('aria-checked') === '${expect}'; })()`,
      4000,
      `${ariaLabel} → ${expect}`,
    )
  }
  return cdp.read(`(() => { const b = ${sel}; return b ? b.getAttribute('aria-checked') : null; })()`)
}

/** 把预览结果整理成"页级/表格级"的统计 */
function analyze(probe) {
  const pages = probe?.pages ?? []
  const flat = []
  for (const p of pages) for (const t of p.tables) flat.push({ ...t, page: p.page })

  // 每页重复区里的"列头表"：通用清单 / 巡检台账把列头做在页眉区，1 行、内容就是 6 个列名
  const HEAD_KEYS = ['序号', '名称', '规格型号', '单位', '数量', '备注']
  const isHeadTable = (t) =>
    t.tr === 1 && t.rows.length === 1 && HEAD_KEYS.every((k) => String(t.rows[0].text).includes(k))

  const headByPage = new Map()
  const loopByPage = new Map()
  for (const p of pages) {
    headByPage.set(p.page, [])
    loopByPage.set(p.page, [])
  }
  for (const t of flat) {
    if (isHeadTable(t)) headByPage.get(t.page).push(t)
    else loopByPage.get(t.page).push(t)
  }

  const loopEls = new Set()
  for (const [, list] of loopByPage) for (const t of list) loopEls.add(t.el)

  const perPage = pages.map((p) => {
    const head = headByPage.get(p.page)
    const loop = loopByPage.get(p.page)
    const rows = loop.reduce((s, t) => s + t.tr, 0)
    const seq = loop.flatMap((t) => t.rows.map((r) => r.first))
    const thead = loop.reduce((s, t) => s + t.thead, 0)
    const tbody = loop.reduce((s, t) => s + t.tbody, 0)
    return {
      page: p.page,
      loopTables: loop.length,
      headTables: head.length,
      dataRows: rows,
      seq,
      loopThead: thead,
      loopTbody: tbody,
    }
  })

  const allSeq = perPage.flatMap((x) => x.seq)
  const totalDataRows = perPage.reduce((s, x) => s + x.dataRows, 0)
  const loopTableTotal = perPage.reduce((s, x) => s + x.loopTables, 0)

  // 循环表数据行的实测高度（跳过表头行）。分页若走了"估算兜底"会得到恒定的 8mm。
  const dataRowMm = []
  for (const t of flat) {
    if (isHeadTable(t)) continue
    dataRowMm.push(...(t.rowMm ?? []).slice(t.thead))
  }
  const sorted = [...dataRowMm].sort((a, b) => a - b)
  const medianRowMm = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0

  return {
    pageCount: pages.length,
    loopEls: [...loopEls],
    perPage,
    allSeq,
    totalDataRows,
    loopTableTotal,
    medianRowMm,
    maxRowsPerPage: perPage.reduce((m, p) => Math.max(m, p.loopTbody || p.dataRows), 0),
    maxRowsInOneTable: flat.filter((t) => !isHeadTable(t)).reduce((m, t) => Math.max(m, t.tr), 0),
    allLoopTables: flat.filter((t) => !isHeadTable(t)),
    allTables: flat.length,
  }
}

function seqSummary(seq) {
  if (seq.length === 0) return '（空）'
  return `${seq[0]}..${seq[seq.length - 1]}（${seq.length} 个）`
}

/** 序号串是否恰好是 1..n 且不重不漏 */
function isContiguousFrom1(seq) {
  const nums = seq.map((s) => Number(s))
  if (nums.some((n) => !Number.isFinite(n))) return false
  for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return false
  return true
}

/** 取出所有阻断级警告的原文，用于跨次比对 */
function warnItems(w) {
  const out = []
  for (const s of w?.sections ?? []) for (const it of s.items ?? []) out.push(it)
  return out
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p))
  if (!edge) {
    console.log('❌ 找不到 Edge / Chrome，无法做浏览器验证')
    process.exit(2)
  }

  try {
    const r = await fetch(BASE, { method: 'HEAD' })
    if (!r.ok) throw new Error(String(r.status))
  } catch (e) {
    console.log(`❌ dev server 不可达（${BASE}）：${e.message}`)
    process.exit(2)
  }

  mkdirSync(profileDir, { recursive: true })
  console.log(`启动浏览器：${edge}`)
  console.log(`profile：${profileDir}`)
  const child = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=420,940',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp = null
  let exitCode = 1

  try {
    let target = null
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find((t) => t.type === 'page')
        if (target?.webSocketDebuggerUrl) break
      } catch {
        /* 还没起来 */
      }
      await sleep(300)
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('无法连接浏览器调试端口')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Log.enable')

    // ------------------------------------------------------------
    console.log('\n[0] 打开插件（mock 模式）')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tab=wizard` })
    await sleep(2600)
    await cdp.eval(HELPERS)
    const shell = await waitFor(cdp, `__bp.count('.app-tabs') > 0`, 15000, '插件外壳')
    ok('插件外壳渲染完成', shell === true)

    // ------------------------------------------------------------
    // 第一轮：手动勾选 6 条 → 单页
    console.log('\n[1] 造模板：通用清单（循环区连续大表默认开启）')
    await cdp.eval(`__bp.clickText('button', '手动勾选')`)
    await waitFor(cdp, `__bp.count('.wiz-pick-row') > 0`, 10000, '勾选列表')
    const SINGLE_N = 6
    const pickedCount = await pickFirstN(cdp, SINGLE_N)
    ok('手动勾选了记录', pickedCount === SINGLE_N, `勾选 ${pickedCount} 条`)

    await gotoStep1(cdp)
    const opened = await createFromSkeleton(cdp, '通用清单', null)
    ok('用「通用清单」骨架创建并进入编辑器', opened === true)
    await cdp.eval(`__bp.clickText('button', '完成')`)
    const backTo1 = await waitFor(cdp, `${BTN_NEXT_PREVIEW} != null`, 15000, '返回向导')
    ok('编辑器「完成」后回到向导', backTo1 === true)

    console.log('\n[2] 单页情形（合并开关开启，6 条记录）')
    const singleOk = await gotoPreview(cdp)
    ok('预览产物已渲染', singleOk === true)
    const single = await readPreview(cdp)
    const s = analyze(single.probe)
    const singleRec = single.recordCount
    console.log(
      `  （界面读数：${single.sum?.title} · ${single.sum?.meta}；iframe 里 ${s.pageCount} 页 / 共 ${s.allTables} 张 <table>）`,
    )
    ok('单页：预览只有 1 页', s.pageCount === 1, `实际 ${s.pageCount} 页`)
    ok(
      '单页：循环区元素下 <table> 数 = 1（合并成一张大表；旧行为会是 N 张）',
      s.loopTableTotal === 1,
      `实际 ${s.loopTableTotal} 张，elementId=${s.loopEls.join(',')}`,
    )
    ok(
      `单页：该表数据行 = 记录数 ${singleRec}（且确实是"少量"记录）`,
      s.totalDataRows === singleRec && singleRec >= 3 && singleRec <= 12,
      `数据行 ${s.totalDataRows} / 记录数 ${singleRec}`,
    )
    ok(
      '单页：序号列 = 1..N 连续',
      isContiguousFrom1(s.allSeq),
      `序号 ${seqSummary(s.allSeq)}`,
    )
    ok(
      '单页：页级列头表（每页重复区）1 张',
      s.perPage[0]?.headTables === 1,
      `实际 ${s.perPage[0]?.headTables} 张`,
    )
    observe('单页观测', `循环表自带 <thead> 行数 ${s.perPage[0]?.loopThead}，页级列头表 ${s.perPage[0]?.headTables} 张`)
    const singleWarnItems = warnItems(single.warn)
    observe('单页警告清单', singleWarnItems.length ? singleWarnItems.join(' | ') : '（无）')

    // ------------------------------------------------------------
    console.log('\n[3] 清掉骨架里两列"在本地 mock 表里找不到字段"的占位符')
    // 通用清单骨架把「单位」「备注」两列留成**未绑定占位符**（骨架设计如此：候选名匹配不上就留给用户改绑）。
    // 不清理的话，"无阻断级警告"这条断言会被这两个跟本功能无关的占位符恒定打成 FAIL。
    // 这里模拟用户改绑（清空内容），并先用"清理前确实有 2 条"证明这条断言不是恒真的。
    ok(
      '清理前：未绑定占位符恰好 2 条（证明"清理后为 0"这条断言有区分度）',
      singleWarnItems.filter((m) => /未绑定字段/.test(m)).length === 2,
      `${singleWarnItems.filter((m) => /未绑定字段/.test(m)).length} 条`,
    )
    await gotoStep0(cdp)
    await gotoStep1(cdp)
    const reopened = await openEditorFromStep1(cdp)
    ok('重新进入编辑器做清理', reopened === true)
    const cleared3 = await setCellText(cdp, 1, 0, 3, '')
    const cleared5 = await setCellText(cdp, 1, 0, 5, '')
    ok('清空循环表「单位」列单元格', cleared3 === true)
    ok('清空循环表「备注」列单元格', cleared5 === true)
    await cdp.eval(`__bp.clickText('button', '完成')`)
    await waitFor(cdp, `${BTN_NEXT_PREVIEW} != null`, 15000, '返回向导')

    // ------------------------------------------------------------
    // 全部 60 条 → 跨页
    console.log('\n[4] 切到「全部」记录，制造跨页')
    await gotoStep0(cdp)
    await cdp.eval(`__bp.clickText('button', '全部')`)
    await sleep(600)
    await gotoStep1(cdp)
    const crossOk = await gotoPreview(cdp)
    ok('跨页预览产物已渲染', crossOk === true)
    const cross = await readPreview(cdp)
    const c = analyze(cross.probe)
    const crossRec = cross.recordCount
    console.log(`  （界面读数：${cross.sum?.title} · ${cross.sum?.meta}；iframe 里 ${c.pageCount} 页）`)
    for (const p of c.perPage) {
      console.log(
        `      第 ${p.page} 页：循环 <table> ${p.loopTables} 张 / 数据行 ${p.dataRows} / 序号 ${seqSummary(p.seq)} / 自带宽表头 ${p.loopThead} 行 / 页级列头表 ${p.headTables} 张`,
      )
    }

    ok('跨页：预览确实超过 1 页', c.pageCount > 1, `实际 ${c.pageCount} 页`)
    ok(
      '跨页：每页各有 1 个循环 <table> 续排片段（同一 elementId）',
      c.perPage.every((p) => p.loopTables === 1) && c.loopEls.length === 1,
      `每页 ${c.perPage.map((p) => p.loopTables).join('/')} 张；elementId 种类 ${c.loopEls.length}`,
    )
    ok(
      '跨页：循环 <table> 总数 = 页数（不是"每条记录一张"）',
      c.loopTableTotal === c.pageCount && c.loopTableTotal < crossRec,
      `循环表 ${c.loopTableTotal} 张 / 页数 ${c.pageCount} / 记录数 ${crossRec}`,
    )
    ok(
      '跨页：每页都有列头行（页级重复区列头表）',
      c.perPage.every((p) => p.headTables === 1),
      `每页列头表 ${c.perPage.map((p) => p.headTables).join('/')}`,
    )
    ok(
      '跨页：序号串起来 = 1..N 连续、不重复、不缺失',
      isContiguousFrom1(c.allSeq),
      `序号 ${seqSummary(c.allSeq)}；重复/缺失 ${c.allSeq.length - new Set(c.allSeq).size} 处`,
    )
    ok(
      '跨页：不丢行 —— 数据行合计 = 打印范围内的记录数',
      c.totalDataRows === crossRec && crossRec > SINGLE_N,
      `数据行合计 ${c.totalDataRows} / 记录数 ${crossRec}`,
    )

    // ---- 这两条是为了证明"分页跑在真实 DOM 实测行高上"，而不是 measure 失败后的估算兜底 ----
    // 兜底逻辑：量不到行高时按 `each = hMm > 0 ? hMm/行数 : 8` 均分，本模板 h 为 auto → 恒定 8mm/行，
    // 于是每页能塞下 floor(257/8) ≈ 32 行。实测行高与每页行数都能把这个形状区分开。
    const CAP = 257 // A4 纵向 297 - 上下页边距 20×2（骨架默认页边距）
    console.log(
      `  （实测：循环表数据行行高中位数 ${c.medianRowMm}mm，单页最多 ${c.maxRowsPerPage} 行；` +
        `若走 8mm 估算兜底则每页约 ${Math.floor(CAP / 8)} 行）`,
    )
    ok(
      '跨页：行高来自真实 DOM 测量（中位行高 ≠ 估算兜底的 8mm）',
      c.medianRowMm > 8,
      `中位行高 ${c.medianRowMm}mm`,
    )
    ok(
      '跨页：每页确实填满到接近版心高度（与实测行高自洽）',
      c.maxRowsPerPage * c.medianRowMm > CAP * 0.75 && c.maxRowsPerPage * c.medianRowMm <= CAP + 5,
      `单页最多 ${c.maxRowsPerPage} 行 × ${c.medianRowMm}mm = ${Math.round(c.maxRowsPerPage * c.medianRowMm)}mm（版心 ${CAP}mm）`,
    )
    const crossWarnItems = warnItems(cross.warn)
    observe('跨页警告清单', crossWarnItems.length ? crossWarnItems.join(' | ') : '（无）')

    console.log('\n[5] 警告与异常（跨页那一次）')
    const conflictWarn = crossWarnItems.filter((m) => /按记录铺行|loop-table-conflict|相对位置/.test(m))
    const missingWarn = crossWarnItems.filter((m) => /不存在（可能已被删除）/.test(m))
    const unboundWarn = crossWarnItems.filter((m) => /未绑定字段/.test(m))
    ok('不出现 loop-table-conflict（本用例是合法配置）', conflictWarn.length === 0, conflictWarn.join(' | '))
    ok('不出现 field-missing（字段被删除）', missingWarn.length === 0, missingWarn.join(' | '))
    ok(
      '不出现 field-unbound（未绑定占位符）',
      unboundWarn.length === 0,
      `${unboundWarn.length} 条：${unboundWarn.join(' | ')}`,
    )
    // 渲染层在"一块都没量到"时会出这条提示并整篇按估算分页 —— 它出现就意味着上面那两条
    // "真实测量"的结论不成立，所以单独断言一次。
    const estimateFallback = crossWarnItems.filter((m) => /无法测量元素真实高度|按估算高度分页/.test(m))
    ok('未走"测量失败→估算高度分页"兜底', estimateFallback.length === 0, estimateFallback.join(' | '))
    if (unboundWarn.length > 0) {
      observe(
        'field-unbound 明细（来自骨架本身的候选名匹配，不是本次改动引入）',
        `${unboundWarn.length} 条：${unboundWarn.join(' | ')}`,
      )
    }

    // ------------------------------------------------------------
    // 对照 A：同一模板，把「连续打印」关掉
    console.log('\n[6] 对照 A：关掉「连续打印」→ 必须回到每条记录一张小表')
    await gotoStep0(cdp)
    await gotoStep1(cdp)
    // 从模板列表重新进编辑器
    const openedEdit = await openEditorFromStep1(cdp)
    ok('可重新进入编辑器', openedEdit === true)

    const found = await selectLoopTable(cdp)
    ok(
      '属性面板出现「连续打印」开关、且作用在循环区那张表上',
      !!found && found.checked === 'true' && found.disabled === false,
      found
        ? `画布 ${found.total} 张表，第 ${found.index + 1} 张命中；aria-checked=${found.checked} disabled=${found.disabled}`
        : '未找到可用的开关',
    )
    observe('开关旁的说明文案', String(found?.hint))
    if (!found) throw new Error('对照 A 失败：找不到循环区表格的「连续打印」开关')

    await tap(cdp, `document.querySelector('button[aria-label="连续打印"]')`)
    await sleep(350)
    const after = await cdp.eval(
      `(document.querySelector('button[aria-label="连续打印"]') || {}).getAttribute ? document.querySelector('button[aria-label="连续打印"]').getAttribute('aria-checked') : null`,
    )
    ok('开关已切换为关闭', after === 'false', `aria-checked=${after}`)

    await cdp.eval(`__bp.clickText('button', '完成')`)
    await waitFor(cdp, `${BTN_NEXT_PREVIEW} != null`, 15000, '返回向导')
    await gotoPreview(cdp)
    const off = await readPreview(cdp)
    const o = analyze(off.probe)
    const offRec = off.recordCount
    console.log(`  （界面读数：${off.sum?.title} · ${off.sum?.meta}；iframe 里 ${o.pageCount} 页）`)
    console.log(
      `      （循环区 <table> 共 ${o.loopTableTotal} 张，单表最大行数 ${o.maxRowsInOneTable}，数据行合计 ${o.totalDataRows}）`,
    )
    ok(
      '对照 A：循环区 <table> 数 = 记录数（每条记录一张小表）',
      o.loopTableTotal === offRec && offRec > 1,
      `循环表 ${o.loopTableTotal} 张 / 记录数 ${offRec}`,
    )
    ok(
      '对照 A：每张小表都只有 1 行（不存在跨记录的大表）',
      o.maxRowsInOneTable === 1,
      `单表最大 <tr> ${o.maxRowsInOneTable}`,
    )
    ok('对照 A：序号列仍为 1..N 连续', isContiguousFrom1(o.allSeq), `序号 ${seqSummary(o.allSeq)}`)
    const offWarnItems = warnItems(off.warn)
    ok(
      '对照 A：警告清单与合并版逐条一致（开关不引入/消除警告）',
      JSON.stringify(offWarnItems) === JSON.stringify(crossWarnItems),
      `off=${offWarnItems.length} 条 / merged=${crossWarnItems.length} 条`,
    )
    observe('对照 A 警告清单', offWarnItems.length ? offWarnItems.join(' | ') : '（无）')

    // ------------------------------------------------------------
    // F2-29 在新形状下：把表格自己的表头行打开并"每页重复"，看续排片段是否每页都带表头。
    // 通用清单把列头做在每页重复区里，循环表自身没有表头行，所以上面那一轮测不到
    // "表格内表头跨页克隆"这条路径。这里就地补一个：把第一行设为表头 + 表头每页重复 +
    // 再补 3 个空数据行（让总高度撑过一页）。
    console.log('\n[7] F2-29：合并大表自身的表头行是否每页重复（在本模板上就地改造后验证）')
    await gotoStep0(cdp)
    await gotoStep1(cdp)
    const reopened2 = await openEditorFromStep1(cdp)
    ok('再次进入编辑器', reopened2 === true)
    const found2 = await selectLoopTable(cdp)
    ok('选中循环区表格（开关仍可用）', !!found2 && found2.disabled === false, found2 ? `checked=${found2.checked}` : '未找到')
    if (!found2) throw new Error('F2-29 补测失败：找不到循环区表格')
    if (found2.checked === 'false') {
      await tap(cdp, `document.querySelector('button[aria-label="连续打印"]')`)
      await sleep(300)
    }
    for (let i = 0; i < 3; i++) {
      await tap(cdp, `document.querySelector('button[aria-label="增加一行"]')`)
      await sleep(200)
    }
    await tap(cdp, `document.querySelector('button[aria-label="首行作为表头"]')`)
    await sleep(250)
    await tap(cdp, `document.querySelector('button[aria-label="表头每页重复"]')`)
    await sleep(250)
    const shape = await cdp.eval(`(() => {
      const on = (l) => { const b = document.querySelector('button[aria-label="' + l + '"]'); return b ? b.getAttribute('aria-checked') : null; };
      const p = Array.from(document.querySelectorAll('.bp-hint')).map(function (e) { return (e.textContent || '').trim(); })
        .find(function (h) { return h.startsWith('当前 ') && h.includes(' 行 × '); });
      return { merge: on('连续打印'), header: on('首行作为表头'), repeat: on('表头每页重复'), shape: p };
    })()`)
    observe('改造后的表格形状', JSON.stringify(shape))
    ok(
      '改造生效：合并开 + 首行是表头 + 表头每页重复',
      shape.merge === 'true' && shape.header === 'true' && shape.repeat === 'true',
      JSON.stringify(shape),
    )
    await cdp.eval(`__bp.clickText('button', '完成')`)
    await waitFor(cdp, `${BTN_NEXT_PREVIEW} != null`, 15000, '返回向导')
    await gotoPreview(cdp)
    const hdr = await readPreview(cdp)
    const h = analyze(hdr.probe)
    console.log(`  （iframe 里 ${h.pageCount} 页）`)
    for (const p of h.perPage) {
      console.log(
        `      第 ${p.page} 页：循环 <table> ${p.loopTables} 张 / 表头行 ${p.loopThead} / 数据行 ${p.loopTbody}`,
      )
    }
    ok('F2-29：预览超过 1 页（确实发生了表格拆分）', h.pageCount > 1, `实际 ${h.pageCount} 页`)
    ok(
      'F2-29：每一页的续排片段都带表头行（表头每页重复）',
      h.perPage.every((p) => p.loopThead === 1),
      `每页表头行 ${h.perPage.map((p) => p.loopThead).join('/')}`,
    )
    ok(
      'F2-29：数据行合计 = 每记录 3 行 × 60 条 = 180（跨页不丢行）',
      h.perPage.reduce((s, p) => s + p.loopTbody, 0) === 180,
      `实际 ${h.perPage.reduce((s, p) => s + p.loopTbody, 0)} 行（每页 ${h.perPage.map((p) => p.loopTbody).join('/')}）`,
    )

    // ------------------------------------------------------------
    // 对照 B：记录模板骨架 通用单据
    console.log('\n[8] 对照 B：记录模板「通用单据」不受该开关影响')
    await gotoStep0(cdp)
    await cdp.eval(`__bp.clickText('button', '手动勾选')`)
    await waitFor(cdp, `__bp.count('.wiz-pick-row') > 0`, 8000, '勾选列表')
    await cdp.eval(`__bp.clickText('button', '清空')`)
    await sleep(300)
    const DOC_N = 3
    await pickFirstN(cdp, DOC_N)
    await cdp.eval(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === '记录模板');
      if (b) b.click();
      return true;
    })()`)
    await sleep(400)
    await gotoStep1(cdp)
    const openedB = await createFromSkeleton(cdp, '通用单据', '记录模板（一条记录一份）')
    ok('用「通用单据」骨架创建并进入编辑器', openedB === true)
    await cdp.eval(`__bp.clickText('button', '完成')`)
    await waitFor(cdp, `${BTN_NEXT_PREVIEW} != null`, 15000, '返回向导')
    await gotoPreview(cdp)
    const rec = await readPreview(cdp)
    const r = analyze(rec.probe)
    const recCount = rec.recordCount
    const perPageTables = r.perPage.map((p) => p.loopTables)
    const perPageRows = r.perPage.map((p) => {
      const t = r.allLoopTables.filter((x) => x.page === p.page)
      return t.length ? t[0].tr : 0
    })
    console.log(`  （界面读数：${rec.sum?.title} · ${rec.sum?.meta}；iframe 里 ${r.pageCount} 页）`)
    console.log(`      （每页 <table> 数 ${perPageTables.join('/')}；每页表行数 ${perPageRows.join('/')}）`)
    ok('对照 B：一条记录一页（页数 = 记录数）', r.pageCount === recCount && recCount === DOC_N, `页数 ${r.pageCount} / 记录数 ${recCount}`)
    ok(
      '对照 B：每页恰有 1 张表、行数固定为模板定义（不随记录数铺行）',
      perPageTables.every((n) => n === 1) && perPageRows.every((n) => n === perPageRows[0]) && perPageRows[0] === 3,
      `每页表数 ${perPageTables.join('/')}，每页行数 ${perPageRows.join('/')}`,
    )
    const firstRows = r.allLoopTables.map((t) => t.rows.map((x) => x.text).join('|'))
    ok('对照 B：各页表格内容各不相同（确实按记录各渲染一份）', new Set(firstRows).size === firstRows.length, `去重后 ${new Set(firstRows).size} / 共 ${firstRows.length}`)
    const bWarnItems = warnItems(rec.warn)
    observe('对照 B 警告清单', bWarnItems.length ? bWarnItems.join(' | ') : '（无）')

    // ------------------------------------------------------------
    console.log('\n[9] 运行期错误检查')
    const realErrors = consoleErrors.filter((m) => !/favicon|Download the React DevTools/i.test(m))
    const realExceptions = exceptions.filter((m) => !/favicon/i.test(m))
    ok('无 console 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
    ok('无未捕获异常', realExceptions.length === 0, realExceptions.slice(0, 3).join(' | '))

    // ------------------------------------------------------------
    // 结论必须在清理之前打印（清理里任何同步重试都可能把事件循环卡住）
    console.log('\n' + '='.repeat(64))
    if (failures.length === 0) {
      console.log(`✅ 浏览器端到端：全部通过 ${pass} 项`)
    } else {
      console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
      for (const f of failures) console.log(`   · ${f}`)
    }
    if (observations.length) {
      console.log('\n观察（未做断言，供人工判断）：')
      for (const o of observations) console.log(`   · ${o}`)
    }
    if (realErrors.length || realExceptions.length) {
      console.log('\n运行期错误明细：')
      for (const e of [...realErrors, ...realExceptions].slice(0, 10)) console.log(`   · ${String(e).split('\n')[0]}`)
    }
    console.log(`\n耗时 ${((Date.now() - T0) / 1000).toFixed(1)}s`)
    console.log('='.repeat(64))

    exitCode = failures.length === 0 ? 0 : 1
  } catch (e) {
    console.error('浏览器验证脚本崩溃：', e)
    exitCode = 1
  } finally {
    // 尽力而为地收尾：不要 await Browser.close（浏览器一关响应就回不来），
    // 也不要给 rmSync 加 maxRetries —— 逐文件同步重试会把事件循环卡死（本项目踩过）。
    try {
      if (cdp) void cdp.send('Browser.close').catch(() => {})
    } catch {
      /* 忽略 */
    }
    await sleep(300)
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    await sleep(400)
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 残留目录在 tmp 里，不影响结果 */
    }
  }

  process.exit(exitCode)
}

main().catch((e) => {
  console.error('脚本崩溃：', e)
  process.exit(1)
})
