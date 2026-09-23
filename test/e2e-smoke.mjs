/**
 * 端到端冒烟测试：用真实 Chromium（Edge）驱动插件，完整走一遍四步流程。
 *
 * 为什么需要它：单元测试覆盖不到"浏览器里真的渲染出来了吗" ——
 * 渲染引擎依赖真实 DOM 测量，预览依赖 iframe，这些在 Node 里全是盲区。
 * 本脚本通过 CDP 直连浏览器，全程收集 console 错误与未捕获异常，
 * 只要有任何一条报错，或某一步的产物没出现，就判定失败。
 *
 * 运行（需要先起 dev server）：
 *   node test/e2e-smoke.mjs [baseUrl]
 *
 * 不依赖任何第三方库：Node 22 自带全局 WebSocket，CDP 直接手写。
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ⚠️ 这里的取值顺序**必须与另外 4 个脚本一致**（`process.env.BP_BASE ?? argv[2] ?? 默认`）。
 *
 * 原来只认 `argv[2]`，于是经 `assertion-audit.mjs` 的代理跑变异时**静默空转**：
 * 代理是按 `BP_BASE` 指路的，脚本却直连 5190（上游），变异一次都没生效 ——
 * 结果是 `代理命中 0 次 / 47 项全绿`，**看着像"这些断言没有牙"，其实是刀没打上**。
 * 验证者已经踩过一次。`BP_BASE` 优先是因为"经代理跑"是更具体的意图：
 * 代理审计会同时给 env 和 argv，而人工跑只给 argv。
 */
const BASE = process.env.BP_BASE ?? process.argv[2] ?? 'http://localhost:5190'
const PORT = 9333
/**
 * 选图守卫用的真实图片（`test/fixtures/photo.png`，240×160、0.5KB）。
 * ⚠️ 必须是一个**真文件**：`DOM.setFileInputFiles` 走的就是"用户从资源管理器挑了一个文件"。
 */
const FIXTURE_PHOTO = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'photo.png')

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

// 浏览器 profile 建在系统临时目录：项目根不再被 `.e2e-profile-*` 污染。
const profileDir = join(tmpdir(), `bp-e2e-${Date.now().toString(36)}`)

/**
 * 清理必须是尽力而为：Windows 上浏览器进程可能还攥着文件句柄，删不掉不该让整个测试崩。
 *
 * **不要加 maxRetries / retryDelay**：rmSync 是同步的，浏览器刚被 kill 时 profile 里
 * 几百个文件的句柄常还没释放，逐文件重试会把事件循环整个卡住 —— 定时器不跑、
 * 结论行与 process.exit 都到不了，外面看到的就是"跑完不退出 / 被 SIGTERM 杀掉"。
 * profileDir 在 os.tmpdir() 下，删不掉也无所谓。
 */
function cleanupProfile() {
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* 残留目录在系统临时目录里，最终由 OS 回收，不影响结果 */
  }
}

// ============================================================
// 断言
// ============================================================

let pass = 0
const failures = []
const skips = []
const consoleErrors = []
const exceptions = []

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * 跳过一条断言（**不算失败，但必须写明原因和"谁在别处守着"**）。
 *
 * 为什么需要它（2026-09-19 加的）：这个脚本里有一段（编辑器 → 预览 → 输出）
 * 原先**默认**走"弹窗被拦 → 侧边栏内联编辑器"这条路。产品改过之后那条路不存在了
 * （用户原话："建议直接留在（模板列表）这个界面，底部给点提示就行"），
 * 于是那十几条一次性全红 —— 而红色的原因**不是功能坏了，是脚本走错了分支**。
 *
 * 那种红是最坏的：它会让人以为"预览坏了"，从而忽略旁边真正红的那几条。
 * 所以分支不对时应该**说清楚**并跳过，而不是假装失败。
 * ⚠️ 但滥用 `skip` 等于把门禁拆掉 —— 只有"本环境物理上到不了、且有别处覆盖"才准用，
 *   而且 `why` 里必须点名那个覆盖它的套件。
 *
 * ⚠️ **2026-09-21 更正**：上面说的"那条路不存在了"指的是**回退分支**；
 * 现在连**独立窗口本身**也已经整体删除（飞书代理 `window.open`，三条回传通道全断），
 * 编辑器只剩"插件内全屏浮层"一支。所以 `skip` 的**剩余用途也变了** ——
 * 它现在只用于"编辑器没渲染出来"这种**异常降级**（而那种情况会被 ④d 判红），
 * 不再是"产品本来就不支持，所以跳过"。
 * ⇒ 换句话说：**正常情况下这个脚本一条都不该 skip**。看到 SKIP 就该先怀疑是不是坏了。
 */
function skip(name, why) {
  skips.push(`${name} — ${why}`)
  console.log(`  SKIP  ${name} — ${why}`)
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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
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
        /**
         * ⚠️ **过滤掉浏览器扩展自己的异常**（2026-09-21）。
         *
         * 现象：`Error: Could not establish connection. Receiving end does not exist.`
         * 栈顶指向 `chrome-extension://pdffkfellgipmhklpdmokmckkkfcopbh/pages/content-script-start.js`
         * —— 那是 Edge 自带的扩展（每次用临时 profile 启动时它都可能刚装好、还连不上自己的
         * background 页），**与我们这一页的代码毫无关系**。
         *
         * 为什么必须过滤而不是"偶尔红就重跑"：这条断言是"无未捕获异常"，一旦它被环境噪音
         * 随机打红，就变成了**不可信的哨兵** —— 真出异常时大家也会习惯性认为是噪音。
         * 判据用栈里有没有 `chrome-extension://`（而不是匹配那句话），
         * 因为报错文案会随浏览器版本变，而"异常来自扩展协议"这件事不会变。
         */
        const desc = d.exception?.description ?? d.text ?? 'unknown exception'
        const fromExtension =
          /chrome-extension:\/\//.test(String(desc)) ||
          (d.stackTrace?.callFrames ?? []).some((f) => /^(chrome-extension|extension):/.test(String(f.url ?? '')))
        if (!fromExtension) exceptions.push(desc)
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        // 带上 URL，否则 404 这类错误看不出是哪个资源
        const url = msg.params.entry.url ? ` <${msg.params.entry.url}>` : ''
        consoleErrors.push(`[log] ${msg.params.entry.text}${url}`)
      }
    })
  }

  send(method, params = {}) {
    this.id++
    const id = this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 20000)
    })
  }

  /** 在当前页面执行表达式并返回值 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate 失败')
    }
    return res.result?.value
  }
}

// ============================================================
// 页面辅助：按可见文字点击 / 查询
// ============================================================

const HELPERS = `
window.__bp = {
  byText(sel, text) {
    return Array.from(document.querySelectorAll(sel))
      .filter(e => (e.textContent || '').trim() === text || (e.textContent || '').includes(text));
  },
  /** 文案完全匹配，用于「运行」这类到处都是的短词 */
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
};
true
`

async function waitFor(cdp, expr, timeoutMs = 12000, label = '') {
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

/** 取元素中心点（视口坐标） */
/**
 * 等提示条（toast）自己消失。
 *
 * ⚠️ 它浮在底部中间，**会正好盖住面板里的项**（实测诊断：`chip-not-hittable, hit: "bp-toast"`）。
 * 面板拖拽起手点在 toast 上 ⇒ 那一下不是拖拽 ⇒ 后面整段断言跟着假红。
 * 这不是"加个 sleep 更稳"，是"起手点必须真的是那个项"。
 */
async function waitNoToast(cdp) {
  for (let i = 0; i < 20; i += 1) {
    const n = await cdp.eval(`document.querySelectorAll('[class*="toast"]').length`)
    if (!n) return true
    await sleep(350)
  }
  return false
}

async function centerOf(cdp, selectorExpr) {
  return cdp.eval(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(r.top), h: Math.round(r.height) };
  })()`)
}

/**
 * 挑一个**真的点得到**的单元格中心。
 *
 * ⚠️ 为什么要用 `elementFromPoint` 反验：底部的面板抽屉会盖住下半屏，
 *    只按 `getBoundingClientRect` 过滤（"bottom < innerHeight - 90"）**挡不住它** ——
 *    点下去命中的是抽屉，于是"选中了格子"这件事根本没发生，
 *    后面一整串断言（悬浮层、框选、拆分）全部连坐假红。
 *    2026-09-23 实测：⑫k/⑫l 两条新守卫共 9 条断言就是这么红的，
 *    全部是"测试没点到东西"，不是产品回归。
 */
/**
 * 把表格滚到视口中间。
 *
 * 为什么要有这一步：画布是可滚动的，而底部还有面板抽屉 —— 前几段（⑫h/⑫i/⑫j 的拖动与滚动）
 * 之后，表格可能整块落在抽屉后面 ⇒ `pickClickableCell` 一个都点不到 ⇒ 守卫**整段跳过**。
 * 跳过比失败更危险（本项目已写进纪律），所以先在**布置现场**这一步上把它解决掉。
 */
async function ensureTableVisible(cdp) {
  /*
   * ⚠️ 先收掉**可能残留的确认层**（`.bp-fs-confirm` = 「确定退出编辑？」）。
   *
   * 2026-09-23 实测：⑫j 结尾用 Esc 关右键菜单，而编辑器的 Esc 是"退出编辑" ⇒ 确认层被弹出来盖住整屏，
   * 于是 ⑫k/⑫l 四条守卫全部**跳过**（诊断里 `firstHit: "bp-fs-confirm"` 才看出来）。
   * 产品侧已经修了（`ContextMenu` 的 Esc 现在 `stopPropagation`）；
   * 这里再兜一道：**守卫不能依赖前一段的状态**，布置现场时把挡路的东西收掉。
   */
  await cdp.eval(`(() => {
    const box = document.querySelector('.bp-fs-confirm');
    if (box) {
      const stay = Array.from(box.querySelectorAll('button')).find((b) => /继续编辑/.test(b.textContent || ''));
      if (stay) stay.click();
    }
    return !!box;
  })()`)
  await sleep(350)
  await cdp.eval(`(() => {
    const td = document.querySelector('td[data-cell-id]');
    if (td) td.scrollIntoView({ block: 'center', inline: 'nearest' });
    return !!td;
  })()`)
  await sleep(450)
}

async function pickClickableCell(cdp) {
  return cdp.eval(`(() => {
    const all = Array.from(document.querySelectorAll('td[data-cell-id]'));
    const rects = all.map((t) => t.getBoundingClientRect());
    /* 只看"完整落在视口里"的格子；能不能点**由 elementFromPoint 说了算**（不再猜抽屉的高度） */
    const inView = rects.filter((r) => r.width > 40 && r.height > 12 && r.top > 60 && r.bottom < window.innerHeight - 4);
    for (const r of inView) {
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (hit && hit.closest && hit.closest('td[data-cell-id]')) return { x, y };
    }
    /*
     * ⚠️ 失败时必须**说清缺什么**：SKIP 比 FAIL 更危险（这条在本项目里已经写进纪律了）。
     *    所以把"有几个格子 / 几个在视口内 / 视口多大 / 最靠前的那个点上是什么"一起带回去。
     */
    const probe = inView[0] || rects[0] || null;
    const hit0 = probe ? document.elementFromPoint(Math.round(probe.x + probe.width / 2), Math.round(probe.y + probe.height / 2)) : null;
    return {
      diag: {
        total: all.length,
        inView: inView.length,
        viewport: [window.innerWidth, window.innerHeight],
        firstHit: hit0 ? (hit0.className || hit0.tagName) : null,
      },
    };
  })()`)
}

/**
 * 挑一对**都点得到**的单元格，且第二个在第一个的右下（用于"左键拖过一片格子"）。
 * 两个端点都要反验：只验起点的话，终点落在抽屉上就会拖出一个空选区。
 */
async function pickCellPair(cdp) {
  return cdp.eval(`(() => {
    const cands = Array.from(document.querySelectorAll('td[data-cell-id]'))
      .map((t) => t.getBoundingClientRect())
      .filter((r) => r.width > 40 && r.height > 12 && r.top > 60 && r.bottom < window.innerHeight - 4)
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const center = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    const hittable = (p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return !!(hit && hit.closest && hit.closest('td[data-cell-id]'));
    };
    for (const a of cands) {
      const pa = center(a);
      if (!hittable(pa)) continue;
      for (const b of cands) {
        if (b.left <= a.left + 2 || b.top <= a.top + 2) continue;
        const pb = center(b);
        if (hittable(pb)) return { from: pa, to: pb };
      }
    }
    return { diag: { cands: cands.length, viewport: [window.innerWidth, window.innerHeight] } };
  })()`)
}

/**
 * 「⑦b 闭环观测装置」——**在页面里**给 `MockDataSource` 的原型挂 create/update/listTemplateRows 三个钩子。
 *
 * ⚠️ 为什么提成常量、而不是写在用它的那一段里（2026-09-21）：
 * `Page.navigate` 会**清掉页面里的全部 JS 状态**（原型补丁也在内），而 [8e] 段是新导航之后才跑的
 * ⇒ 钩子必须**能在任意时刻重装**。留一份内联、再抄一份给 [8e] 用，两份迟早漂移
 * （这个文件里"同一件事写两遍"的坑已经踩过）。所以抽出来，谁需要谁 `cdp.eval(INSTALL_TPL_HOOKS)`。
 * 重入是安全的：`window.__tplPatched` 保证原型只被包一次。
 *
 * ⚠️ 为什么必须从 `bootstrap.ts` 的编译产物里把 specifier 抠出来，而不是直接
 * `import('/src/lib/mock-source.ts')`：Vite 给页面里的每个 import 都加了
 * `?t=<mtime>` 查询串，**带 query 与不带 query 是两个不同的模块实例**
 * （ESM 注册表按完整 URL 做键）。拿不带 query 的那份去改 prototype，
 * 改的是 App **没在用**的另一个类，钩子会一条都收不到 —— 那种"装了但没收着"最难查。
 *
 * ⚠️ 本字符串里**一个反引号都不能有**（会截断外层模板字面量）。
 */
const INSTALL_TPL_HOOKS = `(async () => {
  window.__tplWrites = window.__tplWrites || []
  window.__tplHookErr = null
  try {
    const boot = await (await fetch('/src/lib/bootstrap.ts')).text()
    const at = boot.indexOf('/src/lib/mock-source.ts')
    if (at < 0) { window.__tplHookErr = 'bootstrap.ts 里找不到 mock-source 的 specifier'; return false }
    const end = boot.indexOf('"', at)
    if (end < 0) { window.__tplHookErr = 'specifier 结束引号没找到'; return false }
    const spec = boot.slice(at, end)
    window.__tplSpec = spec
    const mod = await import(spec)
    const P = mod.MockDataSource.prototype
    if (window.__tplPatched) return true
    window.__tplPatched = true
    const oc = P.createTemplateRow
    const ou = P.updateTemplateRow
    // 顺带把**读**方法也挂上：原来 window.__tplDS 只在 create/update 里赋值，
    // 于是一旦"一条都没建"，就永远拿不到实例、读数变 -1，那条断言会因为
    // 观测装置自己的副作用变红 —— 假红同样有害。loadTemplates 一定会调它，所以这里补一个捕获点。
    const ol = P.listTemplateRows
    P.listTemplateRows = async function () {
      window.__tplDS = this
      return ol.apply(this, arguments)
    }
    P.createTemplateRow = async function (tableId, payload) {
      const id = await oc.apply(this, arguments)
      window.__tplWrites.push({ op: 'create', recordId: id, name: payload.name, docLen: String(payload.docJson || '').length })
      window.__tplDS = this
      return id
    }
    P.updateTemplateRow = async function (tableId, recordId, payload) {
      const r = await ou.apply(this, arguments)
      window.__tplWrites.push({ op: 'update', recordId: String(recordId), name: payload.name, docLen: String(payload.docJson || '').length })
      window.__tplDS = this
      return r
    }
    return true
  } catch (e) { window.__tplHookErr = String((e && e.message) || e); return false }
})()`

/**
 * 模拟真实指针拖放。
 * 编辑器用的是 Pointer Events（不是 HTML5 DnD），所以必须走 mousePressed → mouseMoved… → mouseReleased
 * 这条链路，Chromium 会据此合成 pointer 事件。直接调 element.click() 是**不会**触发插入的。
 */
async function pointerDrag(cdp, from, to, modifiers = 0) {
  /*
   * `modifiers`：Alt=1 / Ctrl=2 / Meta=4 / Shift=8（CDP 的位掩码）。
   * 2026-09-22 加：规格四的「矩形框选」在真机反馈后改成 **Shift + 拖**（不按 Shift 的拖动恢复成
   * "移动整个元素"——那才是最高频的动作），所以框选那几条 e2e 必须带 Shift 派发。
   */
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers,
  })
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      button: 'left',
      buttons: 1,
      modifiers,
    })
    await sleep(45)
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers,
  })
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p))
  if (!edge) {
    console.log('❌ 找不到 Edge / Chrome，跳过端到端测试')
    process.exit(0)
  }

  // dev server 得先活着
  try {
    const r = await fetch(BASE, { method: 'HEAD' })
    if (!r.ok) throw new Error(String(r.status))
  } catch (e) {
    console.log(`❌ dev server 不可达（${BASE}）：${e.message}`)
    console.log('   请先 npm run dev')
    process.exit(1)
  }

  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  console.log(`启动浏览器：${edge}`)
  const child = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=390,900',
      /**
       * ⚠️ **必须关掉后台节流**（2026-09-21 加的，代价是排查了整整一轮"渲染卡住"）。
       *
       * 现象：预览页的排版进度停在 `正在排版 18/420`，25 秒纹丝不动；而同一个流程在
       * **一次性的短命浏览器**里（探针脚本）只要 0.5 秒就跑完。
       *
       * 根因：排版是**分片让出主线程**的（`pipeline.ts` 每 BATCH 个块 `await yieldToHost()`），
       * 而那个 yield 依赖定时器/rAF。无头 + 窗口被系统判定为"被遮挡"时，Edge 会把渲染进程
       * 降级成后台 ⇒ **定时器被节流到几乎不走** ⇒ 分片循环爬行。
       * 这四条是自动化场景的标准解法（关掉原生遮挡检测 + 后台节流 + 渲染进程降级）。
       *
       * ⚠️ 别删：删了不会报错，只会让"包含大量记录的排版"在 e2e 里变成随机超时 —— 最难查的那种。
       */
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp = null
  try {
    // 等调试端口起来
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
    /**
     * ⚠️ **把页面提到最前**（2026-09-21 加）。
     *
     * 为什么需要：无头里这个页面会被判成 `visibilityState === "hidden"`（已实测打印过），
     * 而隐藏页里 `requestAnimationFrame` **不触发** ⇒ `yieldToHost()` 不 resolve
     * ⇒ 分批排版**永久停住**（症状：卡在"正在排版 18/420"）。
     * 产品侧已经改成"隐藏时退回 setTimeout"（见 `measure.ts` 的 `yieldToHost`），
     * 但后台定时器会被节流到约 1s/次，420 个块会跑得很慢。
     * ⇒ 这里把页面提成前台，让 rAF 正常工作，整段回到秒级。
     *
     * 失败不影响测试（老版本 CDP 可能没有这个方法）：吞掉异常即可。
     */
    try {
      await cdp.send('Page.bringToFront')
    } catch {
      /* 老浏览器没有这个方法：不影响，只是排版会慢一些 */
    }

    // ------------------------------------------------------------
    // ⚠️ 这里**故意不带 `&tab=`**：需求④ 的原话是"打开插件第一页必须是打印向导"。
    // 而本脚本原先（以及其它冒烟脚本）都是用 `?mock=1&tab=wizard` **显式指定** tab 进来的，
    // 于是"第一页是不是向导"这件事**零断言** —— 把 readInitialTab 的默认值改成 probe，
    // 所有脚本照样全绿。裸 `?mock=1` 才真的在压那个默认值。
    console.log('\n[1] 加载插件（裸 ?mock=1，不指定 tab —— 压"第一页是向导"这个默认值）')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1` })
    await sleep(2500)
    await cdp.eval(HELPERS)

    ok('插件外壳渲染', (await cdp.eval(`__bp.count('.app-tabs') > 0`)) === true)
    ok('未进入错误页', (await cdp.eval(`__bp.count('.app-error') === 0`)) === true)

    await waitFor(cdp, `__bp.byText('button', '下一步：选模板').length > 0`, 15000, '向导第 1 步出现')
    const step1 = await cdp.eval(`({
      hasKind: __bp.byText('button','记录模板').length > 0,
      hasRange: __bp.byText('button','全部').length > 0,
      /*
       * ⚠️ 这里原来读的是第一处 .wiz-hint（"范围内 N 条记录"那句话）。
       *    2026-09-21 第二次降噪把那句话并进了**统计条** ⇒ 改读统计条。
       *    （注意：模板串里不能写反引号，所以上面的类名都没加引号 —— 第 5 次踩的教训。）
       */
      statText: (document.querySelector('.wiz-stat')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      statCells: document.querySelectorAll('.wiz-stat-cell').length,
    })`)
    /**
     * ⚠️ 断言**反过来**了（2026-09-19 修正）。
     *
     * 原来这里是 `ok('步骤① 有模板类型选择', hasKind === true)` —— 它守的是**已经被删掉的功能**。
     * 用户原话："移除『打印什么』的选项，勾选完数据后，用户再选择打印模板，
     * **可以选择所有类型的模板**，当前这个方式有问题。"
     * ⇒ 类型不再在第①步问，改由**所选模板**决定（`selectTemplate` 会一起写 `kind`）。
     *
     * 所以这条现在守的是"**别再问第二遍**"：第①步不该再出现类型选择。
     * 留着旧写法的话，一条早就作废的断言会永远红着，把真回归淹掉。
     */
    ok('步骤① 不再重复问「打印什么」类型（类型由所选模板决定）', step1?.hasKind === false)
    ok('步骤① 有打印范围选择', step1?.hasRange === true)
    /*
     * 统计条（2026-09-21 第二次降噪）：两句事实（范围内记录 / 预计产出）合进一条 34px 的横条，
     * 取代原来的两张事实卡 + 一行"范围内 N 条记录"的说明。守两件事：**两格**、**两个标签都在**。
     */
    ok(
      '步骤① 统计条给出「范围内记录」与「预计产出」两格（取代两张事实卡 + 一行说明）',
      step1?.statCells === 2 && /范围内记录/.test(String(step1?.statText)) && /预计产出/.test(String(step1?.statText)),
      `格数=${step1?.statCells} 文案=${JSON.stringify(step1?.statText)}`,
    )

    // ------------------------------------------------------------
    // ---- ④(a) 第一页 = 向导第 1 步 ----
    // 判据必须是"渲染出来的东西"，不能是 body 里有没有「数据自检」这四个字 ——
    // 那四个字**永远在 DOM 里**（开发者菜单的条目），验证者实测过：
    // 在向导页上 `hasSanity=true && hasProbe=true`。用菜单文字去判页面 = 假绿。
    const landed = await cdp.eval(`({
      activeTab: (document.querySelector('.app-tab.active')||{}).textContent || null,
      hasWizard: __bp.count('.wiz') > 0,
      hasNextToTemplate: __bp.byText('button','下一步：选模板').length > 0,
      hasNextToPreview: __bp.byText('button','下一步：预览').length > 0,
      probePanelInDom: __bp.count('.probe') > 0,
    })`)
    ok(
      '④a 第一页就是打印向导的第 1 步（裸 ?mock=1，不带 tab）',
      landed?.activeTab === '打印向导' &&
        landed?.hasWizard === true &&
        landed?.hasNextToTemplate === true &&
        landed?.hasNextToPreview === false,
      `激活的 tab=${JSON.stringify(landed?.activeTab)}；向导渲染=${landed?.hasWizard}；` +
        `有"下一步：选模板"=${landed?.hasNextToTemplate}；有"下一步：预览"=${landed?.hasNextToPreview}`,
    )
    ok(
      '④a 默认态没有把探针面板渲染出来（排障页不占用户第一屏）',
      landed?.probePanelInDom === false,
      `探针面板在 DOM=${landed?.probePanelInDom}`,
    )

    // ---- ④(b) 开发者菜单：默认对用户不可见 ----
    // 判据用**真实占位 0×0 + display:none**，而不是"DOM 里有没有这个节点"：
    // 节点一直在（见 App.tsx 的注释），只查存在性 100% 为真 = 假绿。
    const dev = await cdp.eval(`(() => {
      const m = document.querySelector('.app-dev-menu');
      if (!m) return { exists: false };
      const r = m.getBoundingClientRect();
      const cs = getComputedStyle(m);
      const probeBtn = Array.from(m.querySelectorAll('button'))
        .find(b => (b.textContent||'').trim() === '探针');
      const pr = probeBtn ? probeBtn.getBoundingClientRect() : null;
      return {
        exists: true,
        hiddenAttr: m.hasAttribute('hidden'),
        display: cs.display,
        rectW: Math.round(r.width),
        rectH: Math.round(r.height),
        probeRectW: pr ? Math.round(pr.width) : null,
        probeRectH: pr ? Math.round(pr.height) : null,
        items: Array.from(m.querySelectorAll('button')).map(b => (b.textContent||'').trim()),
      };
    })()`)
    ok(
      '④b 开发者菜单默认对用户不可见（hidden 属性 + display:none + 真实占位 0×0）',
      dev?.exists === true &&
        dev?.hiddenAttr === true &&
        dev?.display === 'none' &&
        dev?.rectW === 0 &&
        dev?.rectH === 0,
      `hidden=${dev?.hiddenAttr} display=${dev?.display} 占位=${dev?.rectW}×${dev?.rectH} 条目=${JSON.stringify(dev?.items)}`,
    )
    ok(
      '④b 菜单里的「探针」条目自身占位也是 0×0 —— "在 DOM 里"≠"用户点得到"',
      dev?.probeRectW === 0 && dev?.probeRectH === 0,
      `探针条目占位=${dev?.probeRectW}×${dev?.probeRectH}`,
    )

    /**
     * ---- ⑤ 「打印什么」两张卡**已移除**（2026-09-19 修正）----
     *
     * 原来这一整段量的是 `.wiz-choices .wiz-choice` 两张卡的几何（同排 / 并排 / 宽度相当）。
     * 但那两张卡**在产品里已经没有了**：用户要求"移除『打印什么』的选项，
     * 勾选完数据后，用户再选择打印模板，可以选择所有类型的模板"。
     * ⇒ 这段从此永远 `实测卡片=[]` 红着 —— 一条追着幽灵的断言比没有断言更糟，
     *   它会让人以为"布局坏了"，从而忽略旁边真正红的那几条。
     *
     * 现在它守"**确实删干净了**"。同一件事的新守卫（模板卡片一排两个）
     * 搬到了 [3b]，那里才真的有卡片可量。
     */
    const ghost = await cdp.eval(`({
      choices: __bp.count('.wiz-choices .wiz-choice'),
      step1HasKindWord: __bp.byText('button','记录模板').length > 0,
    })`)
    ok(
      '⑤ 步骤① 已移除「打印什么」两张卡（类型改由所选模板决定）',
      ghost?.choices === 0 && ghost?.step1HasKindWord === false,
      `残留卡片=${ghost?.choices} 仍问类型=${ghost?.step1HasKindWord}`,
    )

    /**
     * ---- ⑤e 「预计产出」在没有模板时**不下断言**（2026-09-19 补）----
     *
     * "一份文档装几条记录"由**模板**决定，而步骤①在选模板之前。
     * `kind` 平时可信，是因为加载完模板会自动选中第一条 ⇒ `active` 非空。
     * 只有"一个模板都没有"时 `active` 才是 null，而那时 `kind` 只是初始默认值 `view`，
     * 显示"一份多页文档"就是**对着不存在的模板下断言**。
     * 默认 mock（`?mock=1`，0 个模板）正好就是这一态 ⇒ 在这里守。
     */
    const outputFact = await cdp.eval(`(() => {
      /*
       * ⚠️ 读的是**统计条**（.wiz-stat 那一族类名，2026-09-21 第二次降噪后才有），
       *    不再是两张"事实卡" .wiz-fact —— 那批卡现在只留在第④步。
       *    断言守的契约没变：没模板时不下断言。
       * ⚠️ 这段注释在模板字符串里，**一个反引号都不能有**（见 _check-eval-backticks.mjs，第 5 次踩）。
       */
      const cells = Array.from(document.querySelectorAll('.wiz-stat-cell'));
      const c = cells.find((x) => (x.querySelector('.wiz-stat-k')?.textContent || '').includes('预计产出'));
      return { text: c ? (c.querySelector('.wiz-stat-v')?.textContent || '').trim() : null,
               templates: document.querySelectorAll('.wiz-tpl').length };
    })()`)
    ok(
      '⑤e 一个模板都没有时，「预计产出」如实说"取决于所选模板"（不拿默认 kind 当结论）',
      outputFact?.text === '取决于所选模板',
      `模板数=${outputFact?.templates} 文案=${outputFact?.text}`,
    )

    // ------------------------------------------------------------
    /**
     * ---- ⑤d 记录卡片：两行 × 三字段 + 字段名 + 整页滚动 ----------------
     *
     * 两次要求叠在一起，都要守：
     *   · 2026-09-19："每个卡片只显示两行，一行显示三个字段"（原来是每个字段占一行）；
     *   · 2026-09-21 UI 重设计："筛选结果改成**记录卡片**：一条记录一张卡
     *     （白底 + 1px 灰边 + 圆角 10），卡内 3 列网格；每格 = 字段名 + 取值。"
     *
     * ⚠️ 这里量的仍然是**几何事实**（列数 / 卡高 / 有没有内嵌滚动），不是"元素在不在"。
     * ⚠️ 两条旧数字**已被重设计作废**，别再按老值写回去：
     *     · 「行高 ≤ 56px」——那是"无边框的裸行"时代的数字。加了 1px 边框 + 10px 内边距
     *       + 每格两行文字（字段名 10px / 取值 12px）之后，一张卡天然就是 85~96px；
     *     · 「一屏能看 ≥ 8 条」——它靠的是 `.wiz-pick` 自己那层 `max-height: clamp(...)` 内嵌滚动。
     *       重设计把内嵌滚动**取消**了（改成整页滚动 + 底栏常驻），"一屏几条"这个量
     *       不再有确定的含义（取决于面板高度）。⇒ 换成守"**没有内嵌滚动**"这条，
     *       它才是用户要的"内容区滚动、主按钮永远钉在底部"的实现前提。
     */
    const listGeo = await cdp.eval(`(() => {
      const box = document.querySelector('.wiz-pick');
      const row = document.querySelector('.wiz-pick-row');
      const txt = document.querySelector('.wiz-pick-text');
      if (!box || !row || !txt) return null;
      const cs = getComputedStyle(row);
      const boxCs = getComputedStyle(box);
      const cols = getComputedStyle(txt).gridTemplateColumns.split(' ').filter((s) => s && s !== '0px');
      const rowH = row.getBoundingClientRect().height;
      const body = document.querySelector('.app-body');
      const foot = document.querySelector('.wiz-foot');
      const gapAt = () => (foot ? Math.round(window.innerHeight - foot.getBoundingClientRect().bottom) : null);
      /*
       * ⚠️ 量底部栏之前**必须先把滚动容器拉回顶部**，再滚下去量一次。
       *
       * 只量一次是**没有区分度的**：position: sticky + bottom: 0 只在"元素本该在滚动口下方"
       * 时才把它钉住 —— 于是"粘住了"（滚过一段）与"本来就贴着底边"（内容短、没有剩余空间）
       * 读数**都是 0**。第一版我就是这么写的，把子面板底栏的 margin-top: auto 删掉之后
       * 它**照样绿**（实测：删掉后底栏离底边 128px）。
       * 正确写法：在**滚动位置为 0** 时量（这份量能分出"底栏没有被推到面板底部"），
       * 再滚下去一段量（这份量能分出"sticky 有没有生效"）。
       *
       * ⚠️ 本段在 cdp.eval 的模板字符串里，**注释中也不许出现反引号** —— 写这段时又踩了一次
       * （第 4 次），是 node --check 拦下来的。改完记得跑一次语法检查。
       */
      if (body) body.scrollTop = 0;
      const gapTop = gapAt();
      let scrolled = 0;
      if (body) {
        const max = Math.max(0, body.scrollHeight - body.clientHeight);
        body.scrollTop = Math.min(240, max);
        scrolled = body.scrollTop;
      }
      const gapMid = gapAt();
      if (body) body.scrollTop = 0;
      return {
        colCount: cols.length,
        rowH: Math.round(rowH),
        cells: row.querySelectorAll('.wiz-pick-cell').length,
        named: row.querySelectorAll('.wiz-pick-k').length,
        valued: row.querySelectorAll('.wiz-pick-v').length,
        border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
        radius: cs.borderRadius,
        innerScroll: boxCs.maxHeight === 'none' && boxCs.overflowY === 'visible',
        rows: document.querySelectorAll('.wiz-pick-row').length,
        footPos: foot ? getComputedStyle(foot).position : null,
        footBottom: foot ? getComputedStyle(foot).bottom : null,
        gapTop,
        gapMid,
        scrolled,
      };
    })()`)
    ok(
      '⑤d 记录卡是**一行 × 三字段**（2026-09-21："只显示前三个字段，一行显示，不然卡片太大了"）',
      listGeo?.colCount === 3,
      `文本栅格的列数=${listGeo?.colCount}（期望 3）`,
    )
    ok(
      '⑤d 每格都是「字段名 + 取值」（用户"分不清哪个值属于哪个字段"那个反馈的解）',
      listGeo?.cells === 3 && listGeo?.named === 3 && listGeo?.valued === 3,
      `单元格=${listGeo?.cells} 字段名=${listGeo?.named} 取值=${listGeo?.valued}（期望各 3）`,
    )
    ok(
      '⑤d 记录是**卡片**（1px 实线边框 + 圆角 10；原来是无边框裸行）',
      listGeo?.border === '1px solid' && listGeo?.radius === '10px',
      `边框=${listGeo?.border} 圆角=${listGeo?.radius}`,
    )
    /**
     * ⚠️ 这条上限**跟着 "一行三字段" 收紧**（2026-09-21）：一行 = 字段名 13px + 取值 16px
     *    + 上下内边距 20px + 边框 2px ≈ 51~55px。
     *    上一轮"两行 6 字段"时这里是 60–110px —— 那个数字是**旧版式的度量**，
     *    照着改回 6 字段后这条会立刻红，正是它该有的作用。
     */
    ok(
      '⑤d 卡片压到一行的高度（40–70px；两行版式是 91px，一屏少看三四条）',
      (listGeo?.rowH ?? 0) >= 40 && (listGeo?.rowH ?? 999) <= 70,
      `卡高=${listGeo?.rowH}px`,
    )
    ok(
      '① 列表改成**整页滚动**（取消内嵌滚动区）⇒ 底栏能真正常驻面板底部',
      listGeo?.innerScroll === true,
      `maxHeight=${listGeo?.innerScroll === true ? 'none' : '被限制'}（共 ${listGeo?.rows} 条）`,
    )
    ok(
      '① 底部操作栏是 sticky + bottom:0，滚动位置为 0 时也**紧贴面板底边**（内容再少也不悬在半空）',
      listGeo?.footPos === 'sticky' && listGeo?.footBottom === '0px' && (listGeo?.gapTop ?? 99) <= 1,
      JSON.stringify({ pos: listGeo?.footPos, bottom: listGeo?.footBottom, gapTop: listGeo?.gapTop }),
    )
    ok(
      '① 内容滚下去之后底栏**仍然**贴底（这就是"内容区在它上方滚动"）',
      (listGeo?.gapMid ?? 99) <= 1 && (listGeo?.scrolled ?? 0) > 0,
      `滚动量=${listGeo?.scrolled}px 滚后离底=${listGeo?.gapMid}px`,
    )

    // ------------------------------------------------------------
    console.log('\n[2] 切到手动勾选，验证 50 条上限逻辑可达')
    await cdp.eval(`__bp.clickText('button', '手动勾选')`)
    await sleep(600)
    const manual = await cdp.eval(`({
      hasPicker: __bp.count('.wiz-pick') > 0,
      rows: __bp.count('.wiz-pick-row'),
      cells: document.querySelectorAll('.wiz-pick-row .wiz-pick-cell').length,
      named: document.querySelectorAll('.wiz-pick-row .wiz-pick-k').length,
      // 统计条（2026-09-21 取代两张事实卡）：手动勾选下第一格是"已勾选 x/50"
      stripCells: document.querySelectorAll('.wiz-stat-cell').length,
      stripText: (document.querySelector('.wiz-stat')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      // 两个读取入口必须**并排等宽**（设计稿）
      readRow: (() => {
        const b = Array.from(document.querySelectorAll('.wiz-read-row button'));
        const w = b.map((x) => Math.round(x.getBoundingClientRect().width));
        return { n: w.length, equal: w.length === 2 && Math.abs(w[0] - w[1]) <= 2, w };
      })(),
      // 「筛选条件」整块必须**彻底不在**（功能已按用户要求移除）
      condUI: document.querySelectorAll('.wiz-cond, .wiz-cond-add, .wiz-cond-grid, .wiz-cond-head').length,
      condWords: Array.from(document.querySelectorAll('.app-section-title, .wiz-group-title, button'))
        .filter((x) => (x.textContent || '').includes('筛选条件')).length,
    })`)
    ok('手动勾选打开插件内勾选列表', manual?.hasPicker === true)
    ok('勾选列表有记录行', (manual?.rows ?? 0) > 0, `行数 ${manual?.rows}`)
    /*
     * 勾选列表与筛选结果**共用同一套卡片结构**（`.wiz-pick*`，见 Wizard.tsx 的注释）。
     * ⚠️ 这条断言是**突变逼出来的**：原来只在筛选结果那边数 `.wiz-pick-cell`，
     *    于是把 `className="wiz-pick-cell"` 改回旧类名时 —— 因为 `.replace` 只命中第一处
     *    （即勾选列表那处）—— 断言照样绿。两处都数，才真的是"两处都在说同一件事"。
     */
    ok(
      '⑤d 勾选列表用的是**同一套卡片结构**（字段名 + 取值成对，不是裸值）',
      (manual?.cells ?? 0) === (manual?.rows ?? 0) * 3 && (manual?.named ?? 0) === (manual?.cells ?? 0) && (manual?.cells ?? 0) > 0,
      `行数=${manual?.rows} 单元格=${manual?.cells} 字段名=${manual?.named}（每行 3 格）`,
    )
    /**
     * ---- 统计条（2026-09-21 第二次降噪）----
     *
     * 用户给的设计稿：手动勾选下这一条是「**已勾选 0/50**」+「范围内记录 345 条」两格。
     * 它同时承担了三件事：
     *   · 取代原来两张"事实卡"（各 38px）⇒ 一屏多出约 40px 的记录展示空间；
     *   · 把原来挂在「要打印的记录」标题上的 `0/50` 徽标收进来 ⇒ 同一个数字不在一屏出现两遍；
     *   · 仍然让"单次最多 50 条"这个上限**看得见**（原来那条 `提示了 50 条上限` 断言的继任者）。
     */
    ok(
      '⑤d 手动勾选：统计条两格 =「已勾选 x/50」+「范围内记录 N 条」（含 50 条上限，设计稿口径）',
      manual?.stripCells === 2 &&
        /已勾选\s*\d+\/50/.test(String(manual?.stripText)) &&
        /范围内记录\s*\d+\s*条/.test(String(manual?.stripText)),
      `格数=${manual?.stripCells} 文案=${JSON.stringify(manual?.stripText)}`,
    )
    ok(
      '⑤d 两个读取入口**并排等宽**（设计稿；原来是一大一小的 28px 小按钮挤在左边）',
      manual?.readRow?.n === 2 && manual?.readRow?.equal === true,
      JSON.stringify(manual?.readRow),
    )
    /**
     * ---- 「筛选条件」必须**彻底移除**（2026-09-21）----
     *
     * 用户原话："**直接移除筛选条件这个功能吧**，因为用户完全可以在新视图里，
     * 手动筛选需要打印的内容。"
     * ⚠️ 这里同时守两件事：**DOM 里没有那套控件**、**正文里连"筛选条件"四个字都没有**。
     *    只守 DOM 的话，将来谁把标题留着、只是藏起按钮，这条就会假绿 ——
     *    而用户要的是"这一页不该再有这个东西"。
     * ⚠️ 档位名「**视图筛选**」不算：那是"用视图自己的筛选"，与插件里的条件编辑器是两回事，
     *    所以只查完整的"筛选条件"四个字。
     */
    ok(
      '② 插件里**没有**「筛选条件」这块（功能已移除：条件卡 / 添加按钮 / 标题行一个都不该在）',
      (manual?.condUI ?? 1) === 0 && manual?.condWords === 0,
      `控件数=${manual?.condUI} 含"筛选条件"的标题或按钮数=${manual?.condWords}`,
    )

    await cdp.eval(`__bp.clickText('button', '视图筛选')`)
    await sleep(400)

    // ------------------------------------------------------------
    console.log('\n[3] 进入步骤②，用骨架新建模板 → 进编辑器')
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(900)
    const step2 = await cdp.eval(`({
      hasEmpty: __bp.count('.wiz-empty') > 0,
      hasAddCard: __bp.count('.wiz-tpl-add') > 0,
      addCardText: (document.querySelector('.wiz-tpl-add')?.textContent || '').trim(),
      hasWord: __bp.byText('.wiz-io-menu button','从 Word 导入').length > 0,
      // 收起要看**计算样式**（见下面 ⑤l 那段注释：下拉自带 display:grid，
      // 作者样式会盖掉 [hidden] 的 display:none ⇒ 只看 hidden 属性会假绿）
      ioMenuClosed: (() => { const m = document.querySelector('.wiz-io-menu'); return m ? getComputedStyle(m).display === 'none' : null })(),
      ioTrigger: __bp.byText('button','导入 / 导出').length > 0,
      panelTitle: (document.querySelector('.app-section-title')?.textContent || '').trim(),
    })`)
    ok('步骤② 显示空状态（新表无模板）', step2?.hasEmpty === true)
    /**
     * ⚠️ 「新建模板」的入口在 UI 重设计（2026-09-21）里**换了位置和文案**：
     * 原来是页面底部按钮组里的「新建模板（选骨架）」，现在是模板卡网格最后那一格
     * **虚线卡「＋ 新建模板」**（其余三个入口搬进标题右侧的「导入 / 导出」下拉）。
     * 断言跟着改的是**入口的名字**，不是"入口该不该在" —— 新建模板这条路必须一直可达。
     */
    ok(
      '步骤② 有「＋ 新建模板」入口（网格里的虚线卡）',
      step2?.hasAddCard === true && String(step2?.addCardText || '').includes('新建模板'),
      `虚线卡=${JSON.stringify(step2?.addCardText)}`,
    )
    ok(
      '步骤② 标题右侧有「导入 / 导出」入口，且下拉默认收起（Word 导入挂在里面）',
      step2?.ioTrigger === true && step2?.hasWord === true && step2?.ioMenuClosed === true,
      JSON.stringify({ trigger: step2?.ioTrigger, word: step2?.hasWord, closed: step2?.ioMenuClosed }),
    )
    /**
     * 标题带**当前数据表名**（设计稿的句式「当前xxx的模板」）。
     * 这条不只是文案：插件会跟着用户切表重载，标题不写表名的话，
     * 用户看到列表变了也不知道自己现在在哪张表上。
     */
    ok(
      '步骤② 标题写明"当前「表名」的模板"',
      /^当前.+.的模板$/.test(String(step2?.panelTitle || '')),
      `标题=${JSON.stringify(step2?.panelTitle)}`,
    )

    /**
     * 下拉的**开合**要有出口（点空白即收起）—— 本项目在这类菜单上栽过两次
     * （模板卡的「…」、App 的开发者菜单都是"只能再点一次才收"）。
     * 这里正面验一次：点开 → 真的展开；点正文 → 自动收起。
     */
    await cdp.eval(`__bp.clickText('button', '导入 / 导出')`)
    await sleep(300)
    /*
     * ⚠️ 判"收起没收起"必须看**计算样式**，不能看 `hidden` 属性。
     *
     * 本项目里 `.wiz-io-menu` 显式写了 `display: grid`，作者样式会盖掉 `[hidden]` 自带的
     * `display: none` —— 所以"DOM 上 hidden=true"完全可能"屏幕上照样看得见"。
     * 第一版断言读的就是 `element.hidden`，把补的那条 `.wiz-io-menu[hidden]{display:none}`
     * 删掉之后它**照样绿**（实测）。看 `display` 才有牙。
     */
    const ioOpen = await cdp.eval(`(() => {
      const m = document.querySelector('.wiz-io-menu');
      return {
        display: m ? getComputedStyle(m).display : null,
        items: Array.from(document.querySelectorAll('.wiz-io-menu button')).map((b) => (b.textContent || '').trim()),
      };
    })()`)
    ok(
      '⑤l 点「导入 / 导出」真的展开（计算样式不是 none），且三个入口都在',
      ioOpen?.display === 'grid' && (ioOpen?.items ?? []).length === 3,
      JSON.stringify(ioOpen),
    )
    await cdp.eval(`document.querySelector('.wiz-content')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    await sleep(300)
    const ioClosed = await cdp.eval(`(() => { const m = document.querySelector('.wiz-io-menu'); return m ? getComputedStyle(m).display : null })()`)
    ok('⑤l 点空白处下拉自动收起（不是"必须再点一次按钮"）', ioClosed === 'none', `display=${ioClosed}`)

    // ---- 骨架选择器 ----
    // ⚠️ 2026-09-19 起这里**不再有「记录/视图」切换段**：类型由所选骨架决定。
    // 那一段曾经被删（修"同一个问题问两遍"）、又导致"记录模板根本建不出来"这个死局
    // （第①步的类型选择也被删了 ⇒ 两处都没有 ⇒ kind 永远停在 view）——
    // 所以这一节现在守两件事：**两个分组都在**（不是被过滤掉一类）、**没有类型开关**。
    await cdp.eval(`__bp.clickText('button', '新建模板')`)
    await waitFor(cdp, `__bp.count('.sk-item') > 0`, 8000, '骨架列表出现')

    const READ_SK = `(() => ({
      tabs: Array.from(document.querySelectorAll('.sk-tab')).map((t) => ({
        kind: t.querySelector('.wiz-kind')?.textContent ?? null,
        count: Number((t.querySelector('.sk-tab-count')?.textContent ?? '0').trim()),
        active: t.getAttribute('aria-selected') === 'true',
      })),
      shown: Array.from(document.querySelectorAll('.sk-item-name')).map((e) => e.textContent),
      total: __bp.count('.sk-item'),
      shownGroups: __bp.count('.sk-list'),
      // 面板正文里的"分段控件"个数 —— 类型开关没了就该是 0
      segCount: document.querySelectorAll('.app-section-body .seg').length,
      hasCreate: __bp.byText('button','创建并编辑').length > 0,
      headButtons: document.querySelectorAll('.app-section-head button').length,
      footButtons: Array.from(document.querySelectorAll('.wiz-foot button')).map((b) => (b.textContent || '').trim()),
      footPos: (() => { const f = document.querySelector('.wiz-foot'); return f ? getComputedStyle(f).position : null })(),
      nameH: (() => { const n = document.querySelector('.sk-name'); return n ? Math.round(n.getBoundingClientRect().height) : null })(),
      thumb: (() => { const t = document.querySelector('.sk-thumb'); const r = t?.getBoundingClientRect(); return r ? Math.round(r.width) + 'x' + Math.round(r.height) : null })(),
    }))()`
    const skAll = await cdp.eval(READ_SK)
    const skNames = skAll?.shown ?? []
    const tabOf = (label) => (skAll?.tabs ?? []).find((t) => t.kind === label)

    ok('骨架面板有「创建并编辑」按钮', skAll?.hasCreate === true)
    ok(
      '骨架面板**不再问**类型（没有切换段，类型由所选骨架决定）',
      skAll?.segCount === 0,
      `面板内分段控件数=${skAll?.segCount}`,
    )
    /**
     * ---- 子面板的悬浮底栏（UI 重设计 2026-09-21，用户点名要求的第一条）----
     *
     * 用户原话："底栏悬浮：**不管数据、骨架有多少个，主按钮永远钉在面板最底部**，
     * 内容区在它上方滚动。"
     *
     * 骨架面板这条特别要守：`WizardFooter` 在子面板展开时**整块 return null**
     * （否则两套"下一步"会打架）⇒ 它**必须自带一组**按钮，而且必须停在面板底部 ——
     * 否则骨架一多（记录 7 条 + 视图 3 条），"创建并编辑"就被挤到列表底下，
     * 得滚很久才看得见（那正是用户抱怨的场景）。
     *
     * ⚠️⚠️ **必须临时把视口调高**再量，否则这条断言没有区分度（这是突变逼出来的）。
     *
     * 默认视口（390×900）下，骨架面板的内容本来就比可用高度高 ⇒ 底栏在底部是因为
     * "它是最后一个元素 + sticky 把它钉住了"，**跟"有没有被推到面板底部"无关**：
     * 把 `.wiz-block > .wiz-foot` 的 `margin-top: auto` 删掉，这里仍然读到 0（实测 GREEN）。
     * 调高到 1200 之后内容明显短于可用高度，剩余空间才存在 —— 此时：
     *   · 有 `margin-top: auto` ⇒ `gap = 0`、块内底栏下方无空白；
     *   · 删掉它 ⇒ 底栏悬在半空（实测差 128px @900 视口），断言才有牙。
     */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 400,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(500)
    const skFoot = await cdp.eval(`(() => {
      const body = document.querySelector('.app-body');
      if (body) body.scrollTop = 0;
      const f = document.querySelector('.wiz-foot');
      const b = document.querySelector('.wiz-block');
      if (!f || !b) return null;
      const fr = f.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return {
        pos: getComputedStyle(f).position,
        bottom: getComputedStyle(f).bottom,
        gap: Math.round(window.innerHeight - fr.bottom),
        freeBelowInBlock: Math.round(br.bottom - fr.bottom),
        scrollable: body ? body.scrollHeight - body.clientHeight : null,
      };
    })()`)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(400)
    ok(
      '④ 骨架面板自带悬浮底栏：返回 + 创建并编辑，且**就钉在面板底边**（视口调高、内容显短时也不悬空）',
      (skAll?.footButtons ?? []).join('/') === '返回/创建并编辑' &&
        skFoot?.pos === 'sticky' &&
        skFoot?.bottom === '0px' &&
        (skFoot?.gap ?? 99) <= 1 &&
        (skFoot?.freeBelowInBlock ?? 99) <= 1,
      JSON.stringify({ buttons: skAll?.footButtons, ...(skFoot ?? {}) }),
    )
    ok(
      '④ 标题行**不再**放"返回"（同一个动作两个入口，用户会怀疑两者不一样）',
      skAll?.headButtons === 0,
      `标题行按钮数=${skAll?.headButtons}`,
    )
    ok(
      '④ 骨架行 = 56×44 缩略图 + 16px 单选圈；模板名称输入框 36px 高',
      skAll?.thumb === '56x44' && skAll?.nameH === 36,
      JSON.stringify({ thumb: skAll?.thumb, nameH: skAll?.nameH }),
    )
    /**
     * ⚠️ 改成标签页之后，"两类都可达"要用**标签页的数量徽标之和**来验 ——
     * 那两个数字来自真实数据（groups 过滤后的 items.length），少一组会直接现形。
     * 只看当前页渲染出的 `.sk-item` 是验不出来的（另一组被折叠了）。
     */
    ok(
      '两类骨架**都可达**（"记录模板建不出来"那个死局的守卫）：标签页为 2 个且数量之和 ≥ 10',
      (skAll?.tabs ?? []).length === 2 &&
        (tabOf('记录模板')?.count ?? 0) >= 7 &&
        (tabOf('视图模板')?.count ?? 0) >= 3,
      `标签页=${JSON.stringify(skAll?.tabs)}`,
    )
    ok('默认停在「记录模板」这一页，且只渲染这一组（一屏看完，不用往下滑）', tabOf('记录模板')?.active === true && skAll?.shownGroups === 1, `渲染出的组数=${skAll?.shownGroups}`)
    ok(
      '记录页里是单据类骨架（不是把视图骨架混进来）',
      skNames.some((x) => String(x).includes('通用单据')) && skNames.some((x) => String(x).includes('入库单')),
      skNames.join(' / '),
    )
    const expected = ['通用单据', '入库单', '出库单', '验收单', '领料单', '巡检记录']
    const missing = expected.filter((n) => !skNames.some((x) => String(x).includes(n)))
    ok('包含用户点名的各类单据骨架', missing.length === 0, `缺少：${missing.join('、')}；实际：${skNames.join(' / ')}`)

    // ---- 切到「视图模板」页：内容必须真的换掉（新结构顺手补上的一条覆盖）----
    await cdp.eval(`(() => {
      const t = Array.from(document.querySelectorAll('.sk-tab')).find((x) => (x.textContent || '').includes('视图模板'));
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(400)
    const skView = await cdp.eval(READ_SK)
    ok(
      '⑤g 点「视图模板」标签页会真的换页（内容变了、记录类骨架不再出现在这一页）',
      (skView?.shown ?? []).length > 0 &&
        !(skView?.shown ?? []).some((x) => String(x).includes('入库单')) &&
        (skView?.shown ?? []).some((x) => String(x).includes('清单')) &&
        skView?.shownGroups === 1,
      `视图页内容=${JSON.stringify(skView?.shown)}`,
    )
    // 切回记录页，后面"选骨架→定类型"那几条断言依赖它
    await cdp.eval(`(() => {
      const t = Array.from(document.querySelectorAll('.sk-tab')).find((x) => (x.textContent || '').includes('记录模板'));
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(400)

    // 选中一个**记录类**骨架：类型必须跟着它走（"选骨架即定类型"的最小证据）
    await cdp.eval(`(() => {
      const it = Array.from(document.querySelectorAll('.sk-item')).find((e) => (e.textContent||'').includes('入库单'));
      if (it) it.click();
      return !!it;
    })()`)
    await sleep(300)
    const skPick = await cdp.eval(`({
      active: document.querySelector('.sk-item.on .sk-item-name')?.textContent ?? null,
      hint: Array.from(document.querySelectorAll('.wiz-hint')).map((n) => n.textContent.trim()).find((t) => t.includes('类型随所选骨架')) ?? null,
    })`)
    ok(
      '选「入库单」后类型跟着变成记录模板',
      String(skPick?.active ?? '') === '入库单' && /记录模板/.test(String(skPick?.hint ?? '')),
      `高亮=${skPick?.active}；提示=${skPick?.hint}`,
    )

    /**
     * ⑦b 闭环观测装置 —— 装在**产品代码外面**，产品一行都不改。
     *
     * 要守的那句话（PRD F6 / 需求⑦）：**开窗编辑 → 完成 → 模板表里那一条的内容真的被改写**。
     * 为什么不能靠 DOM 文本：内联编辑回来后，模板卡片只显示 `t.name` 与 `t.paperLabel`
     * （`Wizard.tsx:1050/1053`），而编辑动的是 `docJson`；名字没变、纸张没变，
     * 于是"内容变了"在 DOM 上**根本不可见** —— 这跟"DOM 里那格是空的"是两类问题，
     * 必须换一层观测点。
     *
     * 观测点选在 `DataSource` 接口上（`MockDataSource.updateTemplateRow` / `createTemplateRow`），
     * 理由：**模板内容只有在这一步才落到"模板表"里**，是链路最末端的事实；
     * 而且接口层的 `(recordId, docJson)` 能同时回答两件事 ——
     *   ① 写的是**同一条**记录（recordId 相同）还是**又插了一条**（新 recordId）；
     *   ② 写进去的内容跟建的时候**不一样**（docJson 变长 = 用户拖进去的元素被记下了）。
     *
     * ⚠️ 为什么必须从 `bootstrap.ts` 的编译产物里把 specifier 抠出来，而不是直接
     * `import('/src/lib/mock-source.ts')`：Vite 给页面里的每个 import 都加了
     * `?t=<mtime>` 查询串，**带 query 与不带 query 是两个不同的模块实例**
     * （ESM 注册表按完整 URL 做键）。拿不带 query 的那份去改 prototype，
     * 改的是 App **没在用**的另一个类，钩子会一条都收不到 —— 那种"装了但没收着"
     * 最难查，所以这里宁可多四行去读真实 specifier。
     * （本文件里 `B7`/`B8` 那种 `import('/src/lib/mock-source.ts')` 只取常量与纯函数，
     * 不要求同实例，所以它们不受这条影响。）
     */
    // 装置本体已提成 `INSTALL_TPL_HOOKS` 常量（见文件上方）：`Page.navigate` 会清掉页面里的
    // JS 状态（原型补丁在内），所以 [8e] 段在导航之后必须**再装一次**。两处共用同一份，不抄第二遍。
    const hookInstalled = await cdp.eval(INSTALL_TPL_HOOKS)

    // 选「验收单」并创建
    await cdp.eval(`(() => {
      const item = Array.from(document.querySelectorAll('.sk-item'))
        .find(e => (e.textContent||'').includes('验收单'));
      if (item) item.click();
      return !!item;
    })()`)
    await sleep(300)
    const picked = await cdp.eval(`__bp.count('.sk-item.on')`)
    ok('骨架可选中', (picked ?? 0) === 1, `选中数 ${picked}`)

    await cdp.eval(`__bp.clickText('button', '创建并编辑')`)
    await waitFor(cdp, `__bp.byText('button','完成').length > 0`, 15000, '编辑器打开')

    /**
     * ⚠️ **本节 2026-09-21 第二次重写** —— 它守的契约又换了一次。
     *
     * 演变史（每一版都对应一个真实故障，留着是为了不再走回头路）：
     *   ① 最初断言"走的是「弹窗被拦 → 侧边栏内联编辑器」分支" —— 那条分支后来被删了；
     *   ② 接着改守"窗口返回 null 时不接管整页、底部给提示、一条都不落库"；
     *   ③ **现在窗口那条路整体不存在了**（飞书代理 `window.open` ⇒ 父窗口拿不到句柄也没有
     *      opener ⇒ postMessage / localStorage / window.name 三条回传通道同时断）。
     *      ⚠️ 后果很隐蔽：②那三条断言的前提（"窗口被拦"）**永远不会再发生**，
     *      于是它们变成了**永不执行的死分支** —— 看着还在守，其实一行都没跑过。
     *      （这正是本项目反复吃的那个亏："一条永远不会红的断言等于没有"。）
     *
     * ⇒ 现在改成守**新契约**，每条都对应一个真出现过的故障：
     *   · 点「创建并编辑」后编辑器是**插件内全屏浮层**（`.bp-fs`）——
     *     它与数据源在同一个文档里，保存直接走 SDK 落库，不存在"结果回不来"这回事；
     *   · **没有任何独立窗口状态条残留**（`.wz-winbar` 连同 `WindowNotice` 组件已从代码里删除）
     *     —— 这是"那套东西真的清干净了"的守卫，不是装饰；
     *   · **一条模板都不落库**：用户还没点「完成」，表里就不该多出东西。
     *     守的是用户报过的原始 bug："即使没有成功打开，但模板列表中却成功创建了空白模板"。
     */
    const branch = await cdp.eval(`(() => {
      const fs = document.querySelector('.bp-fs');
      return {
        overlayInPage: !!fs,
        winbarInPage: __bp.count('.wz-winbar') > 0,
        hasDone: __bp.byText('button','完成').length > 0,
      };
    })()`)
    const editorOpen = branch?.overlayInPage === true && branch?.hasDone === true

    ok(
      '④d 用骨架创建后进入**插件内全屏画布**（编辑器与数据源同一个文档，保存直接走 SDK）',
      editorOpen,
      JSON.stringify(branch),
    )
    ok(
      '④d 独立窗口的痕迹**彻底消失**（没有状态条残留 —— 那套组件与样式已从代码里删掉）',
      branch?.winbarInPage === false,
      `同页有状态条=${branch?.winbarInPage}`,
    )

    /**
     * ---- ⑫ 画布分区带 + 右键菜单（2026-09-22）------------------------------------
     *
     * 用户原话："当前的画布不太好区域（区分），**只能靠右侧的属性 tab 去猜**，
     * 做画布分区可视化：A4 纸上直接画了三条分区带 —— 每页重复区（灰）、循环区（橙色高亮，
     * 因为现在在循环区）、表尾区（灰），左侧竖排小标签"；
     * 以及"**全屏画布增加右键菜单**，现在按右键弹出的是飞书的兜底宿主菜单，只有个重新加载"。
     *
     * ⚠️ 这两条必须在**编辑器开着**的时候验（画布只在编辑器里），所以放在这一段。
     */
    const canvasUi = await cdp.eval(`(() => {
      const bands = Array.from(document.querySelectorAll('.bp-band'));
      const gutters = Array.from(document.querySelectorAll('.bp-band__gutter .bp-band__chip')).map((c) => (c.textContent || '').trim());
      const rects = bands.map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      return { bandCount: bands.length, gutters, active: bands.filter((b) => b.classList.contains('is-active')).length, rects };
    })()`)
    ok(
      '⑫a 三条分区都有**左侧竖排标签**（每页重复区 / 循环区 / 表尾区），不用再去右侧面板猜',
      /* 2026-09-22 改名：每页重复区 → 表头区（真机反馈：用户的心智模型是 Word 的页眉） */
      ['表头区', '循环区', '表尾区'].every((n) => (canvasUi?.gutters ?? []).includes(n)),
      `竖排标签=${JSON.stringify(canvasUi?.gutters)}`,
    )
    ok(
      '⑫a 当前所在分区**恰好一条高亮**（用户原话："循环区橙色高亮，因为现在在循环区"）',
      canvasUi?.active === 1,
      `带内标签条=${canvasUi?.bandCount} 高亮条数=${canvasUi?.active}`,
    )
    ok(
      '⑫a 标签条是**细横条**（≤40px），不是铺满整区的底色 —— 铺满会盖住正文，历史上因此回退过一次',
      (canvasUi?.rects ?? []).length > 0 && (canvasUi?.rects ?? []).every((r) => r.h <= 40),
      JSON.stringify(canvasUi?.rects),
    )
    /*
     * ⚠️ 必须**先派发、等一帧、再读菜单**：菜单是 React 状态驱动的，
     *    `setCtx(...)` 之后要到下一次渲染才有 DOM —— 在同一个 eval 里读永远是 null。
     */
    const ctxPrevented = await cdp.eval(`(() => {
      const el = document.querySelector('.bp-canvas');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: Math.round(r.x + 30), clientY: Math.round(r.y + 30) });
      // dispatchEvent 的返回值 = 事件有没有被 preventDefault 掉
      return !el.dispatchEvent(ev);
    })()`)
    await sleep(300)
    const ctxRead = await cdp.eval(`(() => {
      const menu = document.querySelector('.bp-ctx');
      return { hasMenu: !!menu, items: menu ? Array.from(menu.querySelectorAll('.bp-ctx__item')).map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()) : [] };
    })()`)
    const ctx = { prevented: ctxPrevented, hasMenu: ctxRead?.hasMenu, items: ctxRead?.items }
    ok(
      '⑫b 画布右键**被我们接管**（preventDefault 掉了飞书宿主菜单）并弹出自己的菜单',
      ctx?.prevented === true && ctx?.hasMenu === true,
      JSON.stringify({ prevented: ctx?.prevented, menu: ctx?.hasMenu }),
    )
    ok(
      '⑫b 菜单项**按命中对象给**（空白处给"粘贴 / 网格吸附"，不该出现元素那套删除）',
      (ctx?.items ?? []).some((t) => t.includes('粘贴')) && !(ctx?.items ?? []).some((t) => t.includes('删除')),
      JSON.stringify(ctx?.items),
    )
    /*
     * 关菜单用**点空白**（组件监听的就是 pointerdown，与真人点一下完全同路）。
     * ⚠️ 这里**故意不派发 Escape**：编辑器自己也吃 Escape（取消选中 / 退出就地编辑），
     *    一按下去后面几段的状态就变了 —— 实测代价是**整段级联红**（切元素面板 / 拖放 / ⑦b 全挂）。
     *    Esc 出口值得验，但该放在不影响后续步骤的地方（画布交互套件更合适）。
     */
    await cdp.eval(`(() => {
      const el = document.querySelector('.bp-canvas');
      if (el) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    })()`)
    await sleep(250)
    const ctxClosed = await cdp.eval(`!document.querySelector('.bp-ctx')`)
    ok(
      '⑫b 右键菜单**关得掉**（点空白即收）—— 本项目在"菜单只能再点一次才关"上栽过两次',
      ctxClosed === true,
    )

    /**
     * ---- ⑫c 单元格右键：插入 / 删除行列**接上了没有**（2026-09-22）------------------
     *
     * 纯函数（`insertRowAt` / `deleteRowAt` …）由 `table-actions` 单测覆盖，
     * 这里只验一件事：**菜单点下去真的改了那张表**。分工明确 ——
     * 单测管"算得对不对"，e2e 管"接上了没有"。
     */
    const cellCtx = await cdp.eval(`(() => {
      const td = document.querySelector('td[data-cell-id]');
      const tbl = td ? td.closest('table') : null;
      if (!td || !tbl) return null;
      const r = td.getBoundingClientRect();
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) });
      const prevented = !td.dispatchEvent(ev);
      return { prevented, rows: tbl.querySelectorAll('tr').length, tds: tbl.querySelectorAll('td').length };
    })()`)
    await sleep(300)
    const cellMenu = await cdp.eval(`(() => {
      const menu = document.querySelector('.bp-ctx');
      return menu ? Array.from(menu.querySelectorAll('.bp-ctx__item')).map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()) : [];
    })()`)
    ok(
      '⑫c 单元格右键给出**增删行列**这一组（用户规格 一·二：插入上/下行、插入左/右列、删行、删列）',
      ['在上方插入行', '在下方插入行', '在左侧插入列', '在右侧插入列'].every((t) => (cellMenu ?? []).some((x) => x.includes(t))) &&
        (cellMenu ?? []).some((x) => x.includes('删除当前行')) &&
        (cellMenu ?? []).some((x) => x.includes('删除当前列')),
      JSON.stringify(cellMenu),
    )
    const inserted = await cdp.eval(`(() => {
      const b = Array.from(document.querySelectorAll('.bp-ctx__item')).find((x) => (x.textContent || '').includes('在下方插入行'));
      if (!b) return false;
      b.click();
      return true;
    })()`)
    await sleep(600)
    const afterInsert = await cdp.eval(`(() => {
      const tbl = document.querySelector('td[data-cell-id]')?.closest('table');
      return tbl ? { rows: tbl.querySelectorAll('tr').length, tds: tbl.querySelectorAll('td').length } : null;
    })()`)
    ok(
      '⑫c 点「在下方插入行」真的多出一行（不是"菜单点了没反应"）',
      inserted === true && (afterInsert?.rows ?? 0) === (cellCtx?.rows ?? -1) + 1,
      `点中=${inserted} 行数 ${cellCtx?.rows} → ${afterInsert?.rows}；格数 ${cellCtx?.tds} → ${afterInsert?.tds}`,
    )
    /* 撤销回去（后面几段还要用这张表；也顺带验了新动作进了撤销栈） */
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
    await sleep(400)
    const afterUndo = await cdp.eval(`(() => {
      const tbl = document.querySelector('td[data-cell-id]')?.closest('table');
      return tbl ? tbl.querySelectorAll('tr').length : null;
    })()`)
    ok(
      '⑫c 这个动作**进了撤销栈**（Ctrl+Z 之后行数回到原样）',
      (afterUndo ?? 0) === (cellCtx?.rows ?? -1),
      `撤销后行数=${afterUndo}（期望回到 ${cellCtx?.rows}）`,
    )

    /**
     * ---- ⑫d 表格悬浮操作层（规格 一·二）--------------------------------------------
     *
     * 用户规格："表格 hover 态：鼠标移到表格上时，左侧出现一个「表格手柄」按钮……
     * 表格顶边显示列拖动手柄点、左边显示行手柄点"；
     * "鼠标悬停在行首 / 列首位置，出现「+」悬浮按钮：点一下即在该行下方插入一行、在该列右侧插入一列"；
     * "鼠标靠近表格底部边缘或右边缘时，出现一条虚线感应区，点击即可追加一行 / 追加一列"。
     *
     * ⚠️ 最要命的一条是**这一层不能吃掉表格内部的点击**：它铺满整个表格，
     *    一旦忘了 `pointer-events: none`（容器）/ `auto`（按钮），表格里每一格都会点不动 ——
     *    那比"没有这层"严重得多。所以这里用 `elementFromPoint` 直接验
     *    "格子中心点下去仍然是这一格"。
     */
    /*
     * ⚠️ 真机反馈第 6 条后：编辑手柄（+ / 行首列首）**只在编辑态出现**。
     * ⇒ 先断言未编辑时没有 +，再点「编辑表格」进编辑态去验手柄。
     */
    const plusBeforeEdit = await cdp.eval(`document.querySelectorAll('.bp-tbl-afford__plus').length`)
    const entered = await cdp.eval(`(() => {
      const b = Array.from(document.querySelectorAll('.bp-table-bar__btn')).find((x) =>
        (x.textContent || '').trim() === '编辑表格',
      );
      if (!b) return false;
      b.click();
      return true;
    })()`)
    await sleep(400)
    ok(
      '⑫d【未编辑态】表格上**不显示**增加行列的「+」图标（真机反馈第 6 条）',
      plusBeforeEdit === 0,
      `未编辑时 + 的个数=${plusBeforeEdit}`,
    )
    ok('⑫d 点「编辑表格」⇒ 进入编辑态', entered === true)

    const afford = await cdp.eval(`(() => {
      const a = document.querySelector('.bp-tbl-afford');
      if (!a) return null;
      const td = document.querySelector('td[data-cell-id]');
      const r = td ? td.getBoundingClientRect() : null;
      const hit = r ? document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)) : null;
      return {
        grip: !!a.querySelector('.bp-tbl-afford__grip'),
        cols: a.querySelectorAll('.bp-tbl-afford__col').length,
        rows: a.querySelectorAll('.bp-tbl-afford__row').length,
        edges: a.querySelectorAll('.bp-tbl-afford__edge').length,
        hitIsCell: !!(hit && hit.closest('[data-cell-id]')),
      };
    })()`)
    ok(
      '⑫d 悬停表格时挂上悬浮层：表格手柄 + 顶边列手柄点 + 左边行手柄点 + 右/下边缘感应区',
      afford?.grip === true && (afford?.cols ?? 0) > 0 && (afford?.rows ?? 0) > 0 && afford?.edges === 2,
      JSON.stringify(afford),
    )
    ok(
      '⑫d【承重】悬浮层**不吃表格内部的点击**（格子中心点下去仍然是那一格）',
      afford?.hitIsCell === true,
      `格子中心命中的是${afford?.hitIsCell ? '单元格' : '悬浮层（会挡住整个表格！）'}`,
    )
    {
      const plusAt = await cdp.eval(`(() => {
        const b = Array.from(document.querySelectorAll('.bp-tbl-afford__row .bp-tbl-afford__plus'))[1];
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`)
      const before = await cdp.eval(`document.querySelector('td[data-cell-id]')?.closest('table')?.querySelectorAll('tr').length ?? null`)
      if (plusAt) {
        // 用既有的真实指针链路（编辑器走 Pointer Events，合成 click 不会触发插入）——
        // ⚠️ e2e 的 cdp 上没有 `mouse()` 方法，我第一版照抄了截图脚本的写法，直接 TypeError 崩了。
        await pointerDrag(cdp, plusAt, plusAt)
        await sleep(500)
      }
      const after = await cdp.eval(`document.querySelector('td[data-cell-id]')?.closest('table')?.querySelectorAll('tr').length ?? null`)
      ok(
        '⑫d 点行首「+」真的在**那一行下方**插了一行（不进右侧属性面板）',
        plusAt != null && (after ?? 0) === (before ?? -1) + 1,
        `第 2 行下方的「+」→ 行数 ${before} → ${after}`,
      )
      await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
      await sleep(400)
    }

    /**
     * ---- ⑫e 矩形选区：拖选 → 高亮 → 工具条 → 合并（规格 四·核心）--------------------
     *
     * 这一段的职责与 ⑫c/⑫d 相同：**纯函数已被 table-actions 的单测覆盖**（`mergeRange` 那一套），
     * 这里只验"从鼠标拖到落库"这条链真的接通了 —— 拖动起选区、高亮、工具条浮现、点合并真的改表。
     */
    {
      const dragPts = await cdp.eval(`(() => {
        /*
         * ⚠️ 不用 elementFromPoint 找"右下那一格"：它只认**视口内**的坐标，
         * 而画布是可滚动的 —— 表格在摺线以下时它会返回 null，于是整段断言被 skip
         * （我第一版就是这么写的，跑出来是 SKIP 而不是 PASS，看着像"没验"）。
         * 改成**纯几何挑选**：在视口内的格子里找一对"b 在 a 的正右下一格"。
         */
        const cells = Array.from(document.querySelectorAll('td[data-cell-id]')).map((t) => ({
          r: t.getBoundingClientRect(),
        }));
        const inView = cells.filter(
          (c) => c.r.top > 70 && c.r.bottom < window.innerHeight - 60 && c.r.left > 4 && c.r.right < window.innerWidth - 4,
        );
        const pick = (c) => ({ x: Math.round(c.r.x + c.r.width / 2), y: Math.round(c.r.y + c.r.height / 2) });
        for (const a of inView) {
          for (const b of inView) {
            const right = b.r.left - a.r.left;
            const down = b.r.top - a.r.top;
            if (right > a.r.width * 0.5 && down > a.r.height * 0.5 && right < a.r.width * 2.5 && down < a.r.height * 2.5) {
              return { from: pick(a), to: pick(b), tds: cells.length };
            }
          }
        }
        return null;
      })()`)
      if (!dragPts) {
        skip('⑫e 矩形选区（拖选 → 合并）', '当前画布上找不到 2×2 可拖的单元格（模板变了）')
      } else {
        /*
         * 框选现在的口径（真机反馈 2026-09-22 两轮迭代后的结论）：
         *   · 非编辑态 ⇒ 左键拖 = 移动整个表格；
         *   · 编辑态   ⇒ 左键拖 = 框选单元格（用户明确要求不要 Shift）。
         * 所以这里先点「编辑表格」进编辑态，再平拖。
         */
        await cdp.eval(`(() => {
          const b = Array.from(document.querySelectorAll('.bp-table-bar__btn')).find((x) =>
            (x.textContent || '').trim() === '编辑表格',
          );
          if (b) b.click();
        })()`)
        await sleep(300)
        /* 先点格子把表选中（悬浮菜单只在悬停/选中时才渲染），再点「编辑表格」进编辑态 */
        await cdp.eval(`(() => { const t = document.querySelector('td[data-cell-id]'); if (t) t.click(); return !!t })()`)
        await sleep(250)
        await cdp.eval(`__bp.byText('button', '编辑表格').forEach((b) => b.click())`)
        await sleep(300)
        await pointerDrag(cdp, dragPts.from, dragPts.to)
        await sleep(450)
        const sel = await cdp.eval(`({
          rsel: document.querySelectorAll('td.is-rsel').length,
          bar: !!document.querySelector('.bp-rbar'),
          btns: Array.from(document.querySelectorAll('.bp-rbar__btn')).map((b) => (b.textContent || '').trim()),
          tds: document.querySelectorAll('td[data-cell-id]').length,
        })`)
        ok(
          '⑫e 在表格内拖动 ⇒ 矩形选区高亮（`td.is-rsel` 多格）+ 浮出工具条',
          (sel?.rsel ?? 0) >= 2 && sel?.bar === true,
          `高亮格=${sel?.rsel} 工具条=${sel?.bar} 工具条按钮=${JSON.stringify(sel?.btns)}`,
        )
        ok(
          '⑫e 工具条上有规格点名的那几组动作（合并/拆分、对齐、加粗、底纹、增删行列、表头行）',
          ['合并', '拆分', '左', '中', '右', 'B', '表头行', '上边线', '去边线', '跟随整表', '+行', '+列', '−行', '−列'].every((t) =>
            (sel?.btns ?? []).includes(t),
          ),
          JSON.stringify(sel?.btns),
        )

        const clicked = await cdp.eval(`(() => {
          const b = Array.from(document.querySelectorAll('.bp-rbar__btn')).find((x) => (x.textContent || '').trim() === '合并');
          if (!b || b.disabled) return false;
          b.click();
          return true;
        })()`)
        await sleep(500)
        const after = await cdp.eval(`(() => {
          const tds = Array.from(document.querySelectorAll('td[data-cell-id]'));
          const spans = tds.map((t) => [Number(t.getAttribute('colspan') || 1), Number(t.getAttribute('rowspan') || 1)]);
          return {
            tds: tds.length,
            maxColspan: spans.reduce((m, s) => Math.max(m, s[0]), 0),
            maxRowspan: spans.reduce((m, s) => Math.max(m, s[1]), 0),
            confirm: !!document.querySelector('.bp-merge-confirm'),
          };
        })()`)
        ok(
          '⑫e 点「合并」⇒ 选区并成一格（格数变少 + 出现跨列/跨行），且**没有**误弹确认层',
          clicked === true &&
            (after?.tds ?? 99) < (sel?.tds ?? 0) &&
            (after?.maxColspan ?? 1) >= 2 &&
            (after?.maxRowspan ?? 1) >= 2 &&
            after?.confirm === false,
          `格数 ${sel?.tds} → ${after?.tds}；colspan=${after?.maxColspan} rowspan=${after?.maxRowspan}；确认层=${after?.confirm}`,
        )
        await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
        await sleep(400)
        const undone = await cdp.eval(`document.querySelectorAll('td[data-cell-id]').length`)
        ok(
          '⑫e 合并**可撤销**（Ctrl+Z 后格数回到拖动之前）',
          undone === dragPts.tds,
          `撤销后格数=${undone}（期望 ${dragPts.tds}）`,
        )
      }
    }

    /**
     * ---- ⑫f 从左侧面板把元素**拖进单元格**（规格 六，2026-09-22）---------------------
     *
     * 上一轮我在这里得出过一个**错的结论**：以为"面板 → 格子"这条路没接线。
     * 实际是 `resolveDrop` 的探针只有 `inline` 一个档，**把非行内载荷直接拒了**
     * （提示语是「表格单元格里只能放字段、系统变量或文字」）。
     * 现在探针多了 `cellBlock` 一档，且名单的唯一来源是 `table-actions` 的 `CELL_BLOCK_KINDS`。
     *
     * 这条守卫要钉的正是那件事：**同一张二维码，拖到表格外 → 成为画布元素；拖到格子上 → 住进格子**。
     */
    {
      await cdp.eval(`__bp.clickText('button', '元素')`)
      await sleep(400)
      const pts = await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('.bp-el-item')).find((x) =>
          (x.textContent || '').includes('二维码'),
        );
        const cells = Array.from(document.querySelectorAll('td[data-cell-id]')).map((t) => ({
          el: t,
          r: t.getBoundingClientRect(),
        }));
        if (!chip) return null;
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        // 目标格子：优先取**视口内**的（拖拽是真实鼠标事件，坐标必须在视口里）
        const cell = cells
          .filter((c) => c.r.top > 80 && c.r.bottom < window.innerHeight - 60)
          .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[3];
        if (!cell) return null;
        return {
          chip: { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) },
          cell: { x: Math.round(cell.r.x + cell.r.width / 2), y: Math.round(cell.r.y + cell.r.height / 2) },
        };
      })()`)
      if (!pts) {
        skip('⑫f 面板元素拖进单元格', '当前画布上找不到可用的面板项或视口内的单元格')
      } else {
        const before = await cdp.eval(`({
          els: document.querySelectorAll('.bp-el').length,
          children: document.querySelectorAll('.bp-el-cell__child').length,
        })`)
        await pointerDrag(cdp, pts.chip, pts.cell)
        await sleep(600)
        const after = await cdp.eval(`({
          els: document.querySelectorAll('.bp-el').length,
          children: document.querySelectorAll('.bp-el-cell__child').length,
          childCode: document.querySelectorAll('.bp-el-cell__child-code, .bp-el-cell__child-img').length,
        })`)
        ok(
          '⑫f 从面板把「二维码」拖到单元格上 ⇒ **住进格子**（出现 `.bp-el-cell__child`），且没有在版式区多出一个元素',
          (after?.children ?? 0) === (before?.children ?? 0) + 1 && (after?.els ?? 0) === before?.els,
          `格内子元素 ${before?.children} → ${after?.children}；画布元素 ${before?.els} → ${after?.els}；码/图渲染=${after?.childCode}`,
        )
        await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
        await sleep(400)
      }
    }

    /**
     * ---- ⑫g 「表格尺寸」浮层（规格 一，2026-09-22）----------------------------------
     *
     * 上一轮我明确标注了这条缺口：`resizeTableTo` 有单测，但"插入表格后面板真的浮出来、
     * 点加号表格真的变大、点完成真的收起来"这三件事**没有断言**。这一段补上。
     */
    {
      await cdp.eval(`__bp.clickText('button', '元素')`)
      await sleep(400)
      const tspSetup = await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('.bp-el-item')).find((x) =>
          (x.textContent || '').includes('表格'),
        );
        const paper = document.querySelector('.bp-paper');
        if (!chip || !paper) return null;
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        const pr = paper.getBoundingClientRect();
        /* 落点选在纸张**靠下**的空白处：别落到已有的表格上（那会走"放进单元格"那条路，
           拿不到"刚插入的表格"这个状态，也就不会浮出尺寸面板）。 */
        return {
          chip: { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) },
          drop: { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.bottom - 90) },
        };
      })()`)
      if (!tspSetup) {
        skip('⑫g 表格尺寸浮层', '当前面板里找不到「表格」入口或纸张')
      } else {
        const tablesBefore = await cdp.eval(`document.querySelectorAll('.bp-el--table').length`)
        await pointerDrag(cdp, tspSetup.chip, tspSetup.drop)
        await sleep(700)
        const panel = await cdp.eval(`(() => {
          const p = document.querySelector('.bp-tsp');
          if (!p) return null;
          const vals = Array.from(p.querySelectorAll('.bp-tsp__val')).map((v) => (v.textContent || '').trim());
          const rowBtns = p.querySelectorAll('.bp-tsp__row').length;
          return {
            rows: vals[0] ?? null,
            cols: vals[1] ?? null,
            steppers: rowBtns,
            hasHeader: !!p.querySelector('.bp-tsp__check input'),
            hasDone: true,
          };
        })()`)
        const tablesAfter = await cdp.eval(`document.querySelectorAll('.bp-el--table').length`)
        ok(
          '⑫g 插入表格后**浮出「表格尺寸」面板**，默认值就是规格要的 3 行 × 4 列',
          panel?.rows === '3' && panel?.cols === '4' && panel?.steppers === 2 && panel?.hasHeader === true,
          `面板=${JSON.stringify(panel)}；表格数 ${tablesBefore} → ${tablesAfter}`,
        )
        ok(
          '⑫g 表格**真的插进去了**（不是只弹了个面板）',
          (tablesAfter ?? 0) === (tablesBefore ?? 0) + 1,
          `表格数 ${tablesBefore} → ${tablesAfter}`,
        )

        const beforeRows = await cdp.eval(`(() => {
          const t = Array.from(document.querySelectorAll('.bp-el--table')).pop();
          return t ? t.querySelectorAll('tr').length : 0;
        })()`)
        await cdp.eval(`(() => {
          const p = document.querySelector('.bp-tsp');
          const b = p ? p.querySelectorAll('.bp-tsp__row')[0].querySelectorAll('.bp-tsp__btn')[1] : null;
          if (b) b.click();
        })()`)
        await sleep(500)
        const afterRows = await cdp.eval(`(() => {
          const t = Array.from(document.querySelectorAll('.bp-el--table')).pop();
          return t ? t.querySelectorAll('tr').length : 0;
        })()`)
        ok(
          '⑫g 点「行 +」⇒ 当场生效（表格真的多一行，不是要先点确定）',
          (afterRows ?? 0) === (beforeRows ?? 0) + 1,
          `行数 ${beforeRows} → ${afterRows}`,
        )

        await cdp.eval(`(() => {
          const b = document.querySelector('.bp-tsp__close');
          if (b) b.click();
        })()`)
        await sleep(300)
        const closed = await cdp.eval(`!document.querySelector('.bp-tsp')`)
        ok('⑫g 点「完成」⇒ 面板收起（不留一个"幽灵面板"挂在那儿）', closed === true)
        await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
        await sleep(400)
      }
    }

    /**
     * ---- ⑫h 拖框建表 + 「允许拖出页面」开关（2026-09-23 重写）------------------------
     *
     * 原来这一段的入口是画布左下角那个**「拖出表格」按钮**；真机反馈第 10 条说它"点了没用"，
     * 并要求把它换成**「允许拖出页面」开关**（位置：页面属性 + 画布右键菜单）。
     * ⇒ 按钮已删除，本段改为守两件事：
     *   ① 那个按钮**真的没了**（用户明确要求移除，留着一个坏入口比没有更遭）；
     *   ② 新的开关在**右键菜单**里测得动，且勾选/取消都能读到（`pageSetup.allowOutOfPage`）。
     *
     * 「面板拖矩形建表」那条路没被删（规格 一 的后半句还在），但它从面板起手、落点在纸张上，
     * 断言要构造面板拖拽，成本高于收益 —— 这里不再重复守，改由拖框那条**实测**过的路径（⑫g）覆盖。
     */
    {
      const legacyBtn = await cdp.eval(`document.querySelectorAll('.bp-rectbtn').length`)
      ok('⑫h【第 10 条】左下角「拖出表格」按钮已移除（换成「允许拖出页面」开关）', legacyBtn === 0, `rectbtn=${legacyBtn}`)

      /* 右键纸张空白处 → 菜单里应有「允许拖出页面」，点它 → 再打开菜单应变成勾选态 */
      const openBlankMenu = async () => {
        await cdp.eval(`(() => {
          const el = document.querySelector('.bp-canvas');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: Math.round(r.x + 24), clientY: Math.round(r.y + 24) }));
          return true;
        })()`)
        await sleep(350)
      }
      const readAllow = () => cdp.eval(`(() => {
        const items = Array.from(document.querySelectorAll('.bp-ctx__item'));
        const it = items.find((b) => (b.textContent || '').includes('允许拖出页面'));
        return it ? { found: true, checked: /✓/.test(it.textContent || '') } : { found: false, checked: null };
      })()`)

      await openBlankMenu()
      const before = await readAllow()
      await cdp.eval(`(() => {
        const it = Array.from(document.querySelectorAll('.bp-ctx__item')).find((b) => (b.textContent || '').includes('允许拖出页面'));
        if (it) it.click();
        return !!it;
      })()`)
      await sleep(400)
      const wroteOn = await cdp.eval(`(() => {
        const p = document.querySelector('.bp-paper');
        return { any: !!p };
      })()`)
      void wroteOn
      await openBlankMenu()
      const after = await readAllow()
      ok(
        '⑫h【第 10 条】右键菜单里有「允许拖出页面」，且点一下真的切换了勾选态',
        before?.found === true && after?.found === true && before?.checked !== after?.checked,
        `点前 checked=${before?.checked} → 点后 checked=${after?.checked}`,
      )
      /* 收菜单 + 恢复原状（默认不勾） */
      await cdp.eval(`document.querySelector('.bp-paper')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      await sleep(200)
      await openBlankMenu()
      await cdp.eval(`(() => {
        const it = Array.from(document.querySelectorAll('.bp-ctx__item')).find((b) => (b.textContent || '').includes('允许拖出页面'));
        if (it && /✓/.test(it.textContent || '')) it.click();
        return true;
      })()`)
      await sleep(300)
      await cdp.eval(`document.querySelector('.bp-paper')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      await sleep(250)
    }

    /**
     * ---- ⑫i 从格子里把元素**拖出来**（规格 六 的最后一句，2026-09-22）------------------
     *
     * 规格原文："单元格内的元素可以再拖出来，回到画布自由层。"
     * 在此之前只有右键菜单入口（「取出格内元素」）；这条守的是**手势版**：
     * 按住格内元素往外拖、落在纸张空白处松手 ⇒ 它回到自由层（格子清空 + 画布元素 +1）。
     */
    {
      await cdp.eval(`__bp.clickText('button', '元素')`)
      await sleep(400)
      const seed = await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('.bp-el-item')).find((x) =>
          (x.textContent || '').includes('二维码'),
        );
        const cells = Array.from(document.querySelectorAll('td[data-cell-id]')).map((t) => ({ r: t.getBoundingClientRect() }));
        if (!chip) return null;
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        const cell = cells
          .filter((c) => c.r.top > 80 && c.r.bottom < window.innerHeight - 60)
          .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[3];
        if (!cell) return null;
        return {
          chip: { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) },
          cell: { x: Math.round(cell.r.x + cell.r.width / 2), y: Math.round(cell.r.y + cell.r.height / 2) },
        };
      })()`)
      if (!seed) {
        skip('⑫i 从格子里拖出来', '找不到可用的面板项 / 目标单元格')
      } else {
        await pointerDrag(cdp, seed.chip, seed.cell)
        await sleep(600)
        const seeded = await cdp.eval(`document.querySelectorAll('.bp-el-cell__child').length`)
        /* 拖出来：从格内元素拖到纸张下方的空白处（那儿没有单元格） */
        const pts = await cdp.eval(`(() => {
          const child = document.querySelector('.bp-el-cell__child');
          const paper = document.querySelector('.bp-paper');
          if (!child || !paper) return null;
          const cr = child.getBoundingClientRect();
          const pr = paper.getBoundingClientRect();
          return {
            from: { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) },
            to: { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.bottom - 40) },
          };
        })()`)
        const elsBefore = await cdp.eval(`document.querySelectorAll('.bp-el').length`)
        if (!pts || seeded === 0) {
          skip('⑫i 从格子里拖出来', `格内元素没准备好（seeded=${seeded}）`)
        } else {
          await pointerDrag(cdp, pts.from, pts.to)
          await sleep(700)
          const after = await cdp.eval(`({
            children: document.querySelectorAll('.bp-el-cell__child').length,
            els: document.querySelectorAll('.bp-el').length,
            ghost: !!document.querySelector('.bp-child-ghost'),
          })`)
          ok(
            '⑫i 把格内元素拖到纸张空白处松手 ⇒ 它回到自由层（格子清空 + 画布元素 +1）',
            (after?.children ?? 1) === 0 && (after?.els ?? 0) === elsBefore + 1,
            `格内子元素 ${seeded} → ${after?.children}；画布元素 ${elsBefore} → ${after?.els}；浮标残留=${after?.ghost}`,
          )
          ok('⑫i 拖动结束后**浮标被清掉**（不留一个跟着指针的小胶囊）', after?.ghost === false)
          await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
          await sleep(400)
        }
      }
    }
    /**
     * ---- ⑫j 格内子元素是**一等选中对象**（真机反馈第 3 条，2026-09-22）-----------------
     *
     * 用户原话："单元格内的元素……完全无法对单元格内的图片、二维码和条形码进行编辑，
     * 点击该单元格后，右侧的属性面板显示 @image#1:Clipboard_Screenshot.png **未绑定字段**。"
     *
     * 那句"未绑定字段"就是这条守卫存在的理由：点格内元素 ⇒ 面板讲的是**那一格**（字段绑定），
     * 从来说不到格子里那个元素。现在选中模型认复合 id（`child:<tableId>:<cellId>`），于是要守三件事：
     *   ① 点一下（**不拖动**）能选中它自己，而不是把选中打回整张表；
     *   ② 右侧面板换成**格内那套控件**（「占格宽」），不再显示这一格的字段绑定；
     *   ③ 那个控件**真的改得动画布**（否则就是"点了没反应" —— 比没有这个控件更坏）。
     *
     * ①②是接线，③是"控件没空转"的证据。纯函数那一层（复合 id 的解析/写回、百分比换算）
     * 由 `src/components/editor/cell-child.selftest.mts` 在 Node 里逐字节守着。
     */
    {
      /* 独立造现场：不复用 ⑫i 的残留 —— 那一段以 Ctrl+Z 收尾，状态不可依赖 */
      await cdp.eval(`__bp.clickText('button', '元素')`)
      await sleep(400)
      const seedJ = await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('.bp-el-item')).find((x) =>
          (x.textContent || '').includes('二维码'),
        );
        const cells = Array.from(document.querySelectorAll('td[data-cell-id]')).map((t) => ({ r: t.getBoundingClientRect() }));
        if (!chip) return null;
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        const cell = cells
          .filter((c) => c.r.top > 80 && c.r.bottom < window.innerHeight - 60)
          .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[3];
        if (!cell) return null;
        return {
          chip: { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) },
          cell: { x: Math.round(cell.r.x + cell.r.width / 2), y: Math.round(cell.r.y + cell.r.height / 2) },
        };
      })()`)
      if (!seedJ) {
        skip('⑫j 格内子元素可选中 / 可编辑', '找不到可用的面板项 / 目标单元格')
      } else {
        await pointerDrag(cdp, seedJ.chip, seedJ.cell)
        await sleep(600)
        const seededJ = await cdp.eval(`document.querySelectorAll('.bp-el-cell__child').length`)
        if (!seededJ) {
          skip('⑫j 格内子元素可选中 / 可编辑', `格内元素没准备好（seeded=${seededJ}）`)
        } else {
          /* 点一下 = 从==到 的同点拖（位移 0 < 4px ⇒ 走"未越过拖动阈值"那条分支） */
          const centerJ = await cdp.eval(`(() => {
            const c = document.querySelector('.bp-el-cell__child');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`)
          await pointerDrag(cdp, centerJ, centerJ)
          await sleep(450)
          const picked = await cdp.eval(`(() => {
            const child = document.querySelector('.bp-el-cell__child');
            const panel = document.querySelector('.bp-panel--inspector');
            const text = panel ? (panel.innerText || '').replace(/\\s+/g, ' ').trim() : '';
            return {
              childSelected: !!child && child.classList.contains('is-selected'),
              cellSelected: !!child && !!child.closest('td.is-selected'),
              panelText: text.slice(0, 180),
              hasPctCtl: !!panel && !!panel.querySelector('[aria-label="占单元格宽度"]'),
              hasFieldBind: /未绑定字段|绑定字段|选择字段/.test(text),
            };
          })()`)
          ok(
            '⑫j 点格内元素（不拖动）⇒ **它自己**被选中（蓝框），不是把选中打回整张表',
            picked?.childSelected === true && picked?.cellSelected === true,
            `子元素选中=${picked?.childSelected}；所在格高亮=${picked?.cellSelected}`,
          )
          ok(
            '⑫j 右侧面板换成**格内尺寸控件**（「占格宽」），不再显示这一格的字段绑定',
            picked?.hasPctCtl === true && /占格宽/.test(picked?.panelText ?? '') && picked?.hasFieldBind === false,
            `占格宽控件=${picked?.hasPctCtl}；字段绑定残留=${picked?.hasFieldBind}；面板「${picked?.panelText}」`,
          )

          /*
           * ③ 改「占格宽」⇒ 画布上那个元素的宽度真的跟着变。
           * 用 ArrowDown 而不是"改文本+回车"：它走的是 `Num` 的正规步进入口（`step=5`），
           * 一次按键就是一次提交，不依赖输入框的文本状态机。
           */
          const wBefore = await cdp.eval(`(() => {
            const c = document.querySelector('.bp-el-cell__child');
            return c ? c.style.width : null;
          })()`)
          await cdp.eval(`(() => {
            const inp = document.querySelector('.bp-panel--inspector [aria-label="占单元格宽度"]');
            if (!inp) return false;
            inp.focus();
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            return true;
          })()`)
          await sleep(450)
          const wAfter = await cdp.eval(`(() => {
            const c = document.querySelector('.bp-el-cell__child');
            const inp = document.querySelector('.bp-panel--inspector [aria-label="占单元格宽度"]');
            return { styleW: c ? c.style.width : null, inputVal: inp ? inp.value : null };
          })()`)
          ok(
            '⑫j 改「占格宽」⇒ 画布上那个格内元素的宽度**真的跟着变**（控件不是空转的）',
            wBefore === '100%' && wAfter?.styleW === '95%' && wAfter?.inputVal === '95',
            `宽度 ${wBefore} → ${wAfter?.styleW}；输入框=${wAfter?.inputVal}`,
          )

          /* 撤销要能回到原位：这条改的是"格内子元素"，它必须同样进撤销栈 */
          await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
          await sleep(450)
          const wUndone = await cdp.eval(`(() => {
            const c = document.querySelector('.bp-el-cell__child');
            return c ? c.style.width : null;
          })()`)
          ok(
            '⑫j 改格内元素的尺寸**进了撤销栈**（Ctrl+Z 回到 100%）',
            wUndone === '100%',
            `撤销后宽度=${wUndone}`,
          )

          /*
           * ④ 「复制」格内元素 —— 走**右键菜单**。
           *
           * ⚠️ 这里**不能**用 Ctrl+C：编辑器的键盘处理器只认 Z / Y / Delete / Esc
           *    （`useEditorState` 的 `onKey` 里**没有复制分支**）。所以菜单是"能复制格内元素"
           *    唯一的可达入口 —— 第一版把这条断言写成派发 Ctrl+C，量到的只能是"什么都没发生"。
           *
           * 观测点：复制之后，空白右键菜单里的「粘贴到此处」要**从灰变可点** ——
           * 那是 `clipboardHas` 在界面上唯一的表现（比去读内存状态可靠）。
           */
          await cdp.eval(`(() => {
            const c = document.querySelector('.bp-el-cell__child');
            if (!c) return false;
            const r = c.getBoundingClientRect();
            c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
              clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) }));
            return true;
          })()`)
          await sleep(350)
          const clickedCopy = await cdp.eval(`(() => {
            const items = Array.from(document.querySelectorAll('.bp-ctx__item'));
            const target = items.find((b) => (b.textContent || '').replace(/\\s+/g, '').startsWith('复制'));
            if (!target) return { found: false, labels: items.map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()) };
            target.click();
            return { found: true };
          })()`)
          await sleep(350)
          /* 再右键纸张空白处（远离表格），读「粘贴到此处」的可用状态 */
          await cdp.eval(`(() => {
            const el = document.querySelector('.bp-canvas');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
              clientX: Math.round(r.x + 24), clientY: Math.round(r.y + 24) }));
            return true;
          })()`)
          await sleep(350)
          const pasteState = await cdp.eval(`(() => {
            const items = Array.from(document.querySelectorAll('.bp-ctx__item'));
            const paste = items.find((b) => (b.textContent || '').includes('粘贴到此处'));
            return paste ? { found: true, disabled: paste.disabled === true } : { found: false, disabled: null };
          })()`)
          ok(
            '⑫j 右键格内元素点「复制」⇒ 剪贴板里**有东西**（「粘贴到此处」从灰变可点，不再是没有入口/静默无效）',
            clickedCopy?.found === true && pasteState?.found === true && pasteState?.disabled === false,
            `复制项=${JSON.stringify(clickedCopy)}；粘贴项找到=${pasteState?.found} 仍禁用=${pasteState?.disabled}`,
          )
          /*
           * 收菜单：**点画布空白处**而不是按 Esc。
           * ⚠️ 编辑器的 Esc 是"退出编辑"（会弹「确定退出编辑？」）——
           *    虽然产品侧已经让菜单的 Esc `stopPropagation` 了（见 ContextMenu），
           *    但测试这里没必要把"两条链路谁先谁后"当成前提：点空白是菜单四条出口里最中性的那条。
           */
          await cdp.eval(`document.querySelector('.bp-paper')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
          await sleep(300)

          /* 收尾：把它删掉，别影响后面的段落 */
          await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
          await sleep(300)
        }
      }
    }
    /**
     * ---- ⑫k 编辑态浮层：拆分 / 合并单元格 + 左键拖动框选（真机反馈 2026-09-23 第 7、8 条）----
     *
     * 第 7 条原话：「编辑表格的这个菜单，删除增加行列的选项，改为拆分单元格（点击后被选中的单元格
     * 会被拆分，会出现弹窗，提示输入几行几列）、合并单元格（如果只选中一个单元格，则保持不可选中状态）」。
     * 第 8 条原话：「当前表格在编辑状态，还是无法按住鼠标左键拖动选择多个单元格，需要修复」。
     *
     * 这一段的重点是把"按钮在不在"与"按了真的发生什么"分开断言：
     * 前者是接线，后者才是用户看到的东西（本项目在"点了没反应"上栽过多次）。
     */
    {
      await ensureTableVisible(cdp)
      /* ⚠️ 用 pickClickableCell：它会用 elementFromPoint 反验"这个点真的命中格子" */
      const pickCell = await pickClickableCell(cdp)
      if (!pickCell || pickCell.diag) {
        skip('⑫k 编辑态菜单 / 框选 / 拆分', `画布上找不到**点得到**的单元格 —— ${JSON.stringify(pickCell?.diag)}`)
      } else {
        await pointerDrag(cdp, pickCell, pickCell)
        await sleep(450)
        const idleLabels = await cdp.eval(`(() => {
          const b = document.querySelector('.bp-table-bar');
          return b ? Array.from(b.querySelectorAll('button')).map((x) => (x.textContent || '').trim().replace(/\\s+/g, ' ')) : null;
        })()`)
        ok(
          '⑫k 点一下表格里的格子 ⇒ 悬浮层出现（未编辑态）',
          Array.isArray(idleLabels) && idleLabels.length > 0,
          `按钮=${JSON.stringify(idleLabels)}`,
        )
        const enteredEdit = await cdp.eval(`(() => {
          const b = Array.from(document.querySelectorAll('.bp-table-bar__btn')).find((x) => (x.textContent || '').trim() === '编辑表格');
          if (!b) return false;
          b.click();
          return true;
        })()`)
        await sleep(450)
        const editLabels = await cdp.eval(`(() => {
          const b = document.querySelector('.bp-table-bar');
          return b ? Array.from(b.querySelectorAll('button')).map((x) => (x.textContent || '').trim().replace(/\\s+/g, ' ')) : null;
        })()`)
        ok('⑫k 点「编辑表格」⇒ 进入编辑态', enteredEdit === true, `按钮=${JSON.stringify(editLabels)}`)
        ok(
          '⑫k【第 7 条】编辑态浮层**不再有**「+ 行」「+ 列」，改为「拆分单元格」「合并单元格」',
          !!editLabels &&
            !editLabels.some((t) => t === '+ 行' || t === '+ 列') &&
            editLabels.includes('拆分单元格') &&
            editLabels.includes('合并单元格'),
          `按钮=${JSON.stringify(editLabels)}`,
        )
        /*
         * ⚠️ "只选一格 ⇒ 合并灰"必须在**进入编辑态之后**测。
         *
         * 编辑态之前点格子**不会**重置 `cellSel`（`onCellPointerDown` 里有 `editTableId === el.id` 的门槛）
         * ⇒ 上一段（⑫e 合并矩形选区）留下的多格选区还在 ⇒ 按钮当然是可点的。
         * 那是**测试的顺序**问题，不是产品问题：进了编辑态再点一格，`cellSel` 会重置成 1×1，
         * 这才是用户真实操作序列（"点编辑表格 → 点某个格子"）。
         */
        const reselect = await pickClickableCell(cdp)
        if (reselect && !reselect.diag) {
          await pointerDrag(cdp, reselect, reselect)
          await sleep(400)
        }
        const mergeDisabledIdle = await cdp.eval(`(() => {
          const b = Array.from(document.querySelectorAll('.bp-table-bar__btn')).find((x) => (x.textContent || '').trim() === '合并单元格');
          return b ? b.disabled === true : null;
        })()`)
        ok(
          '⑫k【第 7 条】编辑态里**只选中一个格子**时「合并单元格」**保持不可点**',
          mergeDisabledIdle === true,
          `disabled=${mergeDisabledIdle}`,
        )

        /* 第 8 条：按住左键拖过一片格子 */
        const sweep = await pickCellPair(cdp)
        if (!sweep || sweep.diag) {
          skip('⑫k 左键拖动框选多个单元格', `找不到一对都点得到的格子 —— ${JSON.stringify(sweep?.diag)}`)
        } else {
          await pointerDrag(cdp, sweep.from, sweep.to)
          await sleep(500)
          const rsel = await cdp.eval(`document.querySelectorAll('td.is-rsel').length`)
          ok(
            '⑫k【第 8 条】编辑态按住左键拖动 ⇒ 覆盖到的单元格被选中（is-rsel 至少 2 个）',
            (rsel ?? 0) >= 2,
            `is-rsel 个数=${rsel}`,
          )
          /*
           * ⚠️⚠️ **"看得见"必须单独一条断言**（2026-09-23 血的教训）。
           *
           * 上面那条只数了类名 —— 而真机反馈是「已经点了编辑表格，还是无法按住左键拖动格子」。
           * 真相：选区一直是对的、`is-rsel` 也真的加上去了，但 **CSS 里没有任何 `.is-rsel` 规则**
           * ⇒ 屏幕上什么都不变 ⇒ 用户完全合理地判定"拖不动"。而这条守卫当时是**绿的**。
           *
           * 所以这里读**计算样式**：高亮的格子必须有真实的 `box-shadow`。
           * 换成背景色/描边同理（哪个属性都行，关键是"算出来的样式跟没选中时不一样"）。
           */
          const rselPainted = await cdp.eval(`(() => {
            const cells = Array.from(document.querySelectorAll('td.is-rsel'));
            if (!cells.length) return null;
            return cells.filter((c) => {
              const bs = getComputedStyle(c).boxShadow;
              return !!bs && bs !== 'none';
            }).length;
          })()`)
          ok(
            '⑫k【第 8 条 · 看得见】框选出来的格子**真的画上了高亮**（计算样式里有 box-shadow，不是只有类名）',
            (rselPainted ?? 0) >= 1,
            `画了高亮的格数=${rselPainted}（总选中 ${rsel}）`,
          )
          const mergeEnabled = await cdp.eval(`(() => {
            const b = Array.from(document.querySelectorAll('.bp-table-bar__btn')).find((x) => (x.textContent || '').trim() === '合并单元格');
            return b ? b.disabled === false : null;
          })()`)
          ok(
            '⑫k【第 7 条】选中两格以上后「合并单元格」变为可点（与"只有一格时灰"成对照）',
            mergeEnabled === true,
            `可点=${mergeEnabled}`,
          )
          /*
           * ⚠️ **这里不要按 Esc**：编辑器的 Esc = 退出编辑（会弹确认层盖住整屏），
           *    而且画布那个 Esc 监听会顺手把 `cellSel` 清掉 ⇒ 后面的「拆分单元格」按钮变灰、点不动。
           *    第一版就是在这里按了 Esc，导致"拆分弹窗没出现 + 格子数没变"两条假红。
           */
        }

        /* 拆分：点按钮 → 弹层（含行/列两个输入）→ 确认 → 格子变多 */
        const cellCountBefore = await cdp.eval(`document.querySelectorAll('td[data-cell-id]').length`)
        const splitPt = await cdp.eval(`(() => {
          const b = Array.from(document.querySelectorAll('.bp-table-bar__btn')).find((x) => (x.textContent || '').trim() === '拆分单元格');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`)
        if (!splitPt) {
          skip('⑫k 拆分单元格', '找不到「拆分单元格」按钮')
        } else {
          await pointerDrag(cdp, splitPt, splitPt)
          await sleep(450)
          const dlg = await cdp.eval(`(() => {
            const d = document.querySelector('.bp-merge-confirm');
            if (!d) return null;
            return {
              title: ((d.querySelector('.bp-merge-confirm__title') || {}).textContent || '').trim(),
              inputs: Array.from(d.querySelectorAll('.bp-splitcell__input')).map((i) => i.value),
              hasConfirm: !!Array.from(d.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === '确认拆分'),
            };
          })()`)
          ok(
            '⑫k【第 7 条】点「拆分单元格」⇒ 弹出"输入几行几列"的弹窗',
            dlg?.title === '拆分单元格' && (dlg?.inputs?.length ?? 0) === 2 && dlg?.hasConfirm === true,
            JSON.stringify(dlg),
          )
          await cdp.eval(`(() => {
            const d = document.querySelector('.bp-merge-confirm');
            if (!d) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            for (const i of d.querySelectorAll('.bp-splitcell__input')) {
              setter.call(i, '2');
              i.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const okBtn = Array.from(d.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === '确认拆分');
            if (okBtn) okBtn.click();
            return !!okBtn;
          })()`)
          await sleep(700)
          const cellCountAfter = await cdp.eval(`document.querySelectorAll('td[data-cell-id]').length`)
          ok(
            '⑫k【第 7 条】确认拆分 ⇒ 表格里**格子真的变多**（不是"弹窗点了没反应"）',
            (cellCountAfter ?? 0) > (cellCountBefore ?? 0),
            `格子 ${cellCountBefore} → ${cellCountAfter}`,
          )
          await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
          await sleep(450)
        }
      }
    }

    /**
     * ---- ⑫l 拖动落点反馈 / 格内元素占位形态 / 附件字段入格（真机反馈第 2、4、10 条）----
     *
     * 第 4 条原话：「元素拖到表格上时，没有吸附动画，导致不知道元素最终会落到哪个单元格」。
     * 病根是**拖画布上已有元素**那条路（`beginSession`）在拖动过程中从不报告落点，
     * 单元格高亮只接在"从左侧面板拖"那条路上 ⇒ 拖已有元素时全程零反馈。
     * ⇒ 这条断言必须在**松手之前**量（松手后高亮就被清掉了，测的是另一件事）。
     */
    {
      await ensureTableVisible(cdp)
      /*
       * ⚠️⚠️ **源元素必须自己造，不能去"捡"画布上现成的**（2026-09-23，试了三轮才认）。
       *
       * 诊断原文：`elCount: 1, hasFrom: false` —— 套件跑到这一段时，前面的段落已经做了大量
       * 拖动 + Ctrl+Z，文档里只剩**一个**非表格元素，而且它被滚出视口/被别的元素压住 ⇒
       * 这条守卫连着三轮都是"跳过"。**跳过比失败更危险**（它会把回归伪装成绿色）。
       *
       * 所以：先从面板拖一个「文本段落」到纸张的**空白处**（落点用 elementFromPoint 找一个
       * 底下没有 td 的位置），再用它的 id 精确地把它拖到格子上 —— 与前面几段的状态完全解耦。
       */
      await cdp.eval(`__bp.clickText('button', '元素')`)
      await sleep(500)
      const srcIdsBefore = await cdp.eval(
        `Array.from(document.querySelectorAll('.bp-paper [data-el-id]')).map((n) => n.getAttribute('data-el-id'))`,
      )
      const seedSrc = await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('.bp-el-item')).find((x) => (x.textContent || '').includes('文本段落'));
        if (!chip) return { err: 'no-text-chip' };
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        const cp = { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) };
        const chipHit = document.elementFromPoint(cp.x, cp.y);
        if (!(chipHit && chip.contains(chipHit))) return { err: 'chip-not-hittable', hit: chipHit ? chipHit.className : null };
        /* 落点：纸张里一个**底下没有 td** 的位置（否则就落进格子里了，测的不是这一条） */
        const paper = document.querySelector('.bp-paper');
        if (!paper) return { err: 'no-paper' };
        const pr = paper.getBoundingClientRect();
        const x = Math.round(pr.left + pr.width * 0.5);
        for (let y = Math.round(pr.top + 70); y < Math.round(pr.bottom - 30); y += 35) {
          if (y < 100 || y > window.innerHeight - 120) continue;
          const under = document.elementFromPoint(x, y);
          if (under && !under.closest('td[data-cell-id]') && under.closest('.bp-paper')) {
            return { chip: cp, drop: { x, y } };
          }
        }
        return { err: 'no-free-spot' };
      })()`)
      let dragFrom = null
      if (!seedSrc?.err) {
        await pointerDrag(cdp, seedSrc.chip, seedSrc.drop)
        await sleep(700)
        /* 新造出来的那个元素 = id 集合里多出来的那一个 */
        const newId = await cdp.eval(`(() => {
          const before = ${JSON.stringify(srcIdsBefore)};
          const now = Array.from(document.querySelectorAll('.bp-paper [data-el-id]')).map((n) => n.getAttribute('data-el-id'));
          return now.find((id) => before.indexOf(id) === -1) || null;
        })()`)
        const target = await pickClickableCell(cdp)
        const srcPoint = newId
          ? await cdp.eval(`(() => {
              const n = document.querySelector('.bp-paper [data-el-id="' + ${JSON.stringify(newId)} + '"]');
              if (!n) return null;
              const r = n.getBoundingClientRect();
              const p = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
              const hit = document.elementFromPoint(p.x, p.y);
              return hit && hit.closest && hit.closest('[data-el-id]') === n ? p : null;
            })()`)
          : null
        dragFrom =
          srcPoint && target && !target.diag
            ? { from: srcPoint, to: target, fromInfo: { id: newId, seeded: true } }
            : {
                diag: {
                  seed: seedSrc,
                  newId,
                  srcPoint: !!srcPoint,
                  target: target?.diag ?? !!target,
                  viewport: [window.innerWidth, window.innerHeight],
                },
              }
      } else {
        dragFrom = { diag: { seed: seedSrc } }
      }
      if (!dragFrom || dragFrom.diag) {
        skip('⑫l 拖已有元素的落点反馈', `找不到"点得到"的源元素或目标格子 —— ${JSON.stringify(dragFrom?.diag)}`)
      } else {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragFrom.from.x, y: dragFrom.from.y, button: 'left', buttons: 1, clickCount: 1 })
        for (let i = 1; i <= 12; i += 1) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(dragFrom.from.x + ((dragFrom.to.x - dragFrom.from.x) * i) / 12),
            y: Math.round(dragFrom.from.y + ((dragFrom.to.y - dragFrom.from.y) * i) / 12),
            button: 'left',
            buttons: 1,
          })
          await sleep(45)
        }
        await sleep(350)
        const during = await cdp.eval(`(() => {
          const el = document.elementFromPoint(${dragFrom.to.x}, ${dragFrom.to.y});
          return {
            dropCells: document.querySelectorAll('td.is-drop-target').length,
            hint: (document.querySelector('.bp-drop-hint') || {}).textContent || null,
            /* 诊断：松手点底下到底是什么（拖拽时被拖的元素会压在上面，所以用整摞命中看有没有 td） */
            underTop: el ? (el.className || el.tagName) : null,
            underHasTd: !!(el && el.closest && el.closest('td[data-cell-id]')),
            stackHasTd: document.elementsFromPoint(${dragFrom.to.x}, ${dragFrom.to.y}).some((n) => n.closest && n.closest('td[data-cell-id]')),
            confirmLayer: !!document.querySelector('.bp-fs-confirm'),
          };
        })()`)
        ok(
          '⑫l【第 4 条】拖**画布上已有的元素**到格子上（未松手）⇒ 那一格亮起并给出"松开即放进这个单元格"',
          (during?.dropCells ?? 0) >= 1 && /放进这个单元格/.test(during?.hint ?? ''),
          `高亮格数=${during?.dropCells}；提示=${JSON.stringify(during?.hint)}；` +
            `源=${JSON.stringify(dragFrom.fromInfo)}；松手点顶=${during?.underTop}；` +
            `整摞里有 td=${during?.stackHasTd}；确认层=${during?.confirmLayer}`,
        )
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragFrom.to.x, y: dragFrom.to.y, button: 'left', buttons: 0, clickCount: 1 })
        await sleep(500)
        const afterDrop = await cdp.eval(`(() => ({
          dropCells: document.querySelectorAll('td.is-drop-target').length,
          children: document.querySelectorAll('.bp-el-cell__child').length,
        }))()`)
        ok(
          '⑫l 松手后落点高亮被清掉（不留一格一直亮着）+ 元素真的住进了格子',
          (afterDrop?.dropCells ?? 1) === 0 && (afterDrop?.children ?? 0) >= 1,
          `高亮=${afterDrop?.dropCells}；格内元素=${afterDrop?.children}`,
        )
      }

      /*
       * 第 2 条：格内元素不许是"一条细线"（图片没选图 / 码没绑值时都要有占位盒）。
       *
       * ⚠️ **自己造现场**：不复用前面几段留下的格内元素 —— ⑫j 结尾有 Ctrl+Z，
       *    "上一段留下的子元素"根本不可依赖（第一版就是这么红的：`格内元素 undefined`）。
       */
      await cdp.eval(`__bp.clickText('button', '元素')`)
      await sleep(500)
      const seedQr = await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('.bp-el-item')).find((x) => (x.textContent || '').includes('二维码'));
        if (!chip) return { err: 'no-chip' };
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        const p = { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) };
        const hit = document.elementFromPoint(p.x, p.y);
        if (!(hit && chip.contains(hit))) return { err: 'chip-not-hittable', hit: hit ? hit.className : null };
        return { chip: p };
      })()`)
      const targetCell = seedQr?.err ? null : await pickClickableCell(cdp)
      if (seedQr?.err || !targetCell || targetCell.diag) {
        skip(
          '⑫l 格内元素占位形态',
          `造不出格内元素（chip=${JSON.stringify(seedQr)}；cell=${JSON.stringify(targetCell?.diag ?? targetCell)}）`,
        )
      } else {
        await pointerDrag(cdp, seedQr.chip, targetCell)
        await sleep(800)
        const childBox = await cdp.eval(`(() => {
          const c = document.querySelector('.bp-el-cell__child');
          if (!c) return null;
          const r = c.getBoundingClientRect();
          const td = c.closest('td');
          const tr = td ? td.getBoundingClientRect() : null;
          return {
            h: Math.round(r.height),
            w: Math.round(r.width),
            cellH: tr ? Math.round(tr.height) : null,
            cls: c.className,
            text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
          };
        })()`)
        ok(
          '⑫l【第 2 条】格内元素的盒子有实际高度（≥ 20px）—— 不再是 12px 的窄条',
          (childBox?.h ?? 0) >= 20,
          `格内元素 ${childBox?.w}×${childBox?.h}（class=${childBox?.cls}；文案「${childBox?.text}」）；所在格高=${childBox?.cellH}`,
        )
      }

      /* 第 10 条：附件字段从左侧面板拖进格子，必须放得进去 */
      await cdp.eval(`__bp.clickText('button', '字段')`)
      await sleep(500)
      /*
       * ⚠️ 字段面板项的真实类名是 **`.bp-chip-item`**（元素面板才是 `.bp-el-item`），
       *    而且字段按类型**分组折叠**（附件那组可能是收着的，收着就不在 DOM 里）
       *    ⇒ 先点开分组再找。第一版拿 `.bp-el-item` 找附件字段，永远找不到（SKIP 了一条真守卫）。
       */
      /*
       * ⚠️ 先等**提示条（toast）自己消失**：它浮在底部中间，会正好盖住面板里的字段项
       *    （实测诊断：`chip-not-hittable, hit: "bp-toast"`）。提示条是自动隐藏的，等它走就行。
       */
      await waitNoToast(cdp)
      await cdp.eval(`(() => {
        const head = Array.from(document.querySelectorAll('.bp-group__head')).find((h) => /附件/.test(h.textContent || ''));
        if (head && !head.parentElement.querySelector('.bp-chip-item')) head.click();
        return true;
      })()`)
      await sleep(350)
      const attachChip = await cdp.eval(`(() => {
        const chips = Array.from(document.querySelectorAll('.bp-chip-item'));
        const chip = chips.find((x) => /照片|附件/.test(x.textContent || ''));
        if (!chip) return { err: 'no-attach-chip', sample: chips.slice(0, 8).map((x) => (x.textContent || '').trim().slice(0, 10)) };
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        const p = { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) };
        const hit = document.elementFromPoint(p.x, p.y);
        if (!(hit && chip.contains(hit))) return { err: 'chip-not-hittable', hit: hit ? hit.className : null };
        return { label: (chip.textContent || '').trim().slice(0, 16), chip: p };
      })()`)
      const attachCell = attachChip?.err ? null : await pickClickableCell(cdp)
      if (attachChip?.err || !attachCell || attachCell.diag) {
        skip(
          '⑫l 附件字段拖进格子',
          `附件字段这条路跑不起来（chip=${JSON.stringify(attachChip)}；cell=${JSON.stringify(attachCell?.diag ?? attachCell)}）`,
        )
      } else {
        await pointerDrag(cdp, attachChip.chip, attachCell)
        await sleep(900)
        /*
         * ⚠️ 判据**不能**是"格内子元素个数 +1"：一格只装一个（`MAX_CELL_CHILDREN = 1`），
         *    放第二个是**替换**，个数不变。第一版就是这么红的 ——
         *    而提示条其实明明白白写着"已放进单元格（格子里原来那个「产品照片」被替换掉了）"。
         * ⇒ 判据换成**可观测的两件事**：① 出现了 attach 类的格内子元素；② 提示是成功而不是拒绝。
         */
        const res = await cdp.eval(`(() => ({
          attachChild: document.querySelectorAll('.bp-el-cell__child[data-kind*="附件"]').length,
          anyChild: document.querySelectorAll('.bp-el-cell__child').length,
          toast: Array.from(document.querySelectorAll('[class*="toast"], [class*="notice"]')).map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 2),
        }))()`)
        const toastText = (res?.toast ?? []).join(' ')
        ok(
          '⑫l【第 10 条】附件字段从左侧拖进格子 ⇒ **住进格子里**（不再提示"装不下「异常照片1-1」"）',
          (res?.attachChild ?? 0) >= 1 && /已放进单元格/.test(toastText) && !/装不下/.test(toastText),
          `附件类格内元素=${res?.attachChild}（格内元素共 ${res?.anyChild}）；提示=${JSON.stringify(res?.toast)}`,
        )
        await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
        await sleep(400)
      }
    }
    /**
     * ---- ⑫m 「固定图片」选本地文件 ⇒ 图片真的进画布（真机反馈 2026-09-23 第 2 条）----
     *
     * 用户原话：「在全屏状态下选择图片后，会打开资源管理器选择图片，此时全屏缩小，
     * 但是依旧是选择了图片但不生效……但在此状态下，是可以正常选择图片的」。
     *
     * 这条守卫用 CDP 的 `DOM.setFileInputFiles` 给那个 input 塞一个**真实文件**
     * （`test/fixtures/photo.png`），走的就是用户那条路：点按钮 → 选中文件 → 图应出现在画布上。
     *
     * ⚠️ 它守的是**单例 input**（`lib/file-pick.ts`）这条链：
     *    原来 input 画在面板里，系统对话框导致的布局切换会把它换掉 ⇒ `change` 落在
     *    已从 DOM 移除的节点上 ⇒ 选图静默失败。单例挂在 body 上，重挂不影响它。
     */
    {
      /* 先造一个「固定图片」元素（它没有 dataUrl，所以面板里会显示"还没有选择图片"） */
      await cdp.eval(`__bp.clickText('button', '元素')`)
      await sleep(500)
      await waitNoToast(cdp)
      const imgChip = await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('.bp-el-item')).find((x) => (x.textContent || '').includes('固定图片'));
        if (!chip) return { err: 'no-chip' };
        chip.scrollIntoView({ block: 'center' });
        const cr = chip.getBoundingClientRect();
        const p = { x: Math.round(cr.x + cr.width / 2), y: Math.round(cr.y + cr.height / 2) };
        const hit = document.elementFromPoint(p.x, p.y);
        if (!(hit && chip.contains(hit))) return { err: 'chip-not-hittable', hit: hit ? hit.className : null };
        return { chip: p };
      })()`)
      const canvasSpot = imgChip?.err ? null : await cdp.eval(`(() => {
        const paper = document.querySelector('.bp-paper');
        if (!paper) return null;
        const pr = paper.getBoundingClientRect();
        const x = Math.round(pr.left + pr.width * 0.5);
        for (let y = Math.round(pr.top + 90); y < Math.round(pr.bottom - 40); y += 35) {
          if (y > window.innerHeight - 110) break;
          const under = document.elementFromPoint(x, y);
          if (under && !under.closest('td[data-cell-id]') && under.closest('.bp-paper')) return { x, y };
        }
        return null;
      })()`)
      if (imgChip?.err || !canvasSpot) {
        skip('⑫m 选本地图片', `造不出固定图片元素（chip=${JSON.stringify(imgChip)}；spot=${!!canvasSpot}）`)
      } else {
        await pointerDrag(cdp, imgChip.chip, canvasSpot)
        await sleep(700)
        const before = await cdp.eval(`(() => ({
          els: document.querySelectorAll('.bp-el--image').length,
          hasPreview: document.querySelectorAll('.bp-img-preview').length,
          /* 判据取"面板里那个按钮的文案"：没有图时是「选择图片」，有图时是「更换图片」。
             ⚠️ 不要去 grep「还没有选择图片」—— 那行警示在面板文字里靠后，
             而截断（slice）会让它落在窗口之外 ⇒ 一条**永远为假**的断言（我第一版就这么红的）。 */
          pickLabel: (() => {
            const p = document.querySelector('.bp-panel--inspector');
            if (!p) return null;
            const b = Array.from(p.querySelectorAll('button')).find((x) => /^(选择图片|更换图片)$/.test((x.textContent || '').trim()));
            return b ? (b.textContent || '').trim() : null;
          })(),
          panelText: (() => { const p = document.querySelector('.bp-panel--inspector'); return p ? (p.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : null; })(),
        }))()`)
        ok(
          '⑫m 前提：拖入「固定图片」后，它**确实还没有图**（面板按钮是「选择图片」、没有预览图）',
          (before?.els ?? 0) >= 1 && (before?.hasPreview ?? 1) === 0 && before?.pickLabel === '选择图片',
          `图片元素=${before?.els}；预览=${before?.hasPreview}；按钮=${before?.pickLabel}`,
        )

        /* 点「选择图片」→ 单例 input 被挂到 body 上（headless 里不会真弹对话框，它会留在 DOM 里） */
        await cdp.eval(`__bp.clickText('button', '选择图片')`)
        await sleep(400)
        /* DOM 域要先 enable 才能 querySelector（幂等，多调一次没关系） */
        await cdp.send('DOM.enable')
        const fileDoc = await cdp.send('DOM.getDocument', { depth: -1 })
        const fileNode = await cdp.send('DOM.querySelector', { nodeId: fileDoc.root.nodeId, selector: 'body > input[type=file]' })
        ok(
          '⑫m 点「选择图片」⇒ 单例 input **挂在 body 上**（不在面板里，所以重挂换不掉它）',
          !!fileNode?.nodeId,
          `nodeId=${fileNode?.nodeId}`,
        )
        if (fileNode?.nodeId) {
          /*
           * ⚠️⚠️ **先制造那个真实存在的竞态，再塞文件**（2026-09-23 真机反馈的最后一块拼图）。
           *
           * 真机现象是：「全屏时选图不生效，**小窗状态下可以正常上传**」——
           * 同一份代码同一个文件，差别只在**时机**。根因是 `pickFile` 早期用
           * "window 重获焦点后 400ms 就当取消"收尾，而退出全屏时浏览器要做一整套
           * 布局/fullscreen 收尾、`change` 被推到 400ms 之后才到 ⇒ 被兜底吃掉。
           *
           * 所以这里**故意**先派发一个 focus 事件并等 600ms（跨过那个 400ms 窗口），
           * 再塞文件 —— 若实现里还有"按 focus 抢跑"的收尾，这条断言就会红。
           */
          await cdp.eval(`window.dispatchEvent(new Event('focus'))`)
          await sleep(600)
          await cdp.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [FIXTURE_PHOTO] })
          await sleep(1200)
          const afterPick = await cdp.eval(`(() => {
            const el = document.querySelector('.bp-el--image img');
            const panel = document.querySelector('.bp-panel--inspector');
            return {
              srcLen: el ? (el.getAttribute('src') || '').length : 0,
              preview: document.querySelectorAll('.bp-img-preview').length,
              panelText: panel ? (panel.innerText || '').replace(/\\s+/g, ' ').slice(0, 80) : null,
            };
          })()`)
          ok(
            '⑫m【承重】选中真实文件后 ⇒ **图片真的进画布**（img.src 拿到 dataURL、面板出现预览）',
            (afterPick?.srcLen ?? 0) > 100 && (afterPick?.preview ?? 0) >= 1,
            `src 长度=${afterPick?.srcLen}；面板预览=${afterPick?.preview}；面板「${afterPick?.panelText}」`,
          )
        }
        await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`)
        await sleep(400)
      }
    }
    const orphan = await cdp.eval(`(async () => {
      const rows = window.__tplDS ? await window.__tplDS.listTemplateRows('tpl') : null;
      return { creates: (window.__tplWrites || []).filter(x => x.op === 'create').length, rowCount: rows ? rows.length : null };
    })()`)
    /**
     * 承重的是 `creates === 0`：模板行**只能**经由 `createTemplateRow` 产生，
     * 所以"没调过它"就是"表里不可能多出一条"的**直接证据**。
     * `rowCount` 是第二来源（直接数表里有几条），取到就必须也是 0；
     * 取不到（实例没被捕获）不判红 —— 那是观测装置的限制，不是产品的事实。
     */
    ok(
      '④d 还没点「完成」时**一条模板都不落库**（惰性落库；守"凭空多出空白模板"那个真 bug）',
      orphan?.creates === 0 && (orphan?.rowCount == null || orphan.rowCount === 0),
      `create 调用=${orphan?.creates} 次；模板表现存=${orphan?.rowCount ?? '未取到实例（不影响：没有 create 就不可能有行）'}`,
    )

    // ------------------------------------------------------------
    console.log('\n[4] 编辑器：切到「元素」面板插入文本，再返回')
    if (!editorOpen) {
      console.log('  （本环境页面内没有编辑器 —— 见 ④d。这一段整块跳过，理由写在 SKIP 里）')
    }
    if (editorOpen) {
    // 元素面板默认收起在「字段」标签下（这是编辑器为了窄侧栏做的抽屉设计）
    const switched = await cdp.eval(`__bp.clickText('button', '元素')`)
    ok('切到元素面板', switched === true)
    await sleep(500)

    const inserted = await (async () => {
      /* ⚠️ 先等提示条散掉：它盖住面板项时，拖拽会从 toast 起手 ⇒ 什么都没插进去 */
      await waitNoToast(cdp)
      // 元素面板里的按钮是 button.bp-el-item，用真实指针拖到画布上
      const itemSel = `Array.from(document.querySelectorAll('button.bp-el-item')).find(b => (b.textContent||'').includes('文本段落'))`
      const from = await centerOf(cdp, itemSel)
      if (!from) return 'no-palette-item'
      const area = await centerOf(cdp, `document.querySelector('.bp-canvas-area')`)
      if (!area) return 'no-canvas-area'
      // 抽屉从底部升起，落到画布靠上的位置才不会被抽屉盖住
      const to = { x: area.x, y: area.top + Math.min(70, Math.max(30, Math.round(area.h * 0.25))) }
      await pointerDrag(cdp, from, to)
      await sleep(700)
      return 'dragged'
    })()
    console.log(`  （插入元素：${inserted}）`)

    // 断言画布上真的多了元素，而不是"点了但没反应"
    const elementCount = await cdp.eval(`__bp.count('[class*="bp-el-"]') - __bp.count('.bp-el-item') - __bp.count('.bp-el-item__icon') - __bp.count('.bp-el-item__label') - __bp.count('.bp-el-item__hint') - __bp.count('.bp-el-item__body')`)
    ok('拖放插入成功（画布上出现元素）', inserted === 'dragged' && (elementCount ?? 0) > 0, `元素数 ${elementCount}`)
    await sleep(400)

    // 编辑器对空模板会拒绝"完成"（刻意的防御），所以这一步依赖上一步真的插入成功
    await cdp.eval(`__bp.clickText('button', '完成') || __bp.clickText('button', '保存')`)
    const back = await waitFor(cdp, `__bp.byText('button','下一步：预览').length > 0`, 12000, '返回向导')
    ok('从编辑器返回向导', back === true)
    ok('模板已出现在列表', (await cdp.eval(`__bp.count('.wiz-tpl') > 0`)) === true)

    // ---- ⑦b 闭环：落库那一步真的改写了"那一条"模板 ----------------------------------
    const tplWrite = await cdp.eval(`(async () => {
      const w = window.__tplWrites || []
      const rows = window.__tplDS ? await window.__tplDS.listTemplateRows('tpl') : null
      const creates = w.filter(x => x.op === 'create')
      const updates = w.filter(x => x.op === 'update')
      /**
       * ⚠️ 取**最后一次落库动作**，而不是"最后一次 update"。
       * 换到插件内全屏编辑之后，新建模板是**点完成时才建**（惰性落库）
       * ⇒ 落库动作是 create 而不是 update；只看 update 会永远取不到东西。
       */
      const last = w[w.length - 1] || null
      const row = rows && last ? rows.find(r => r.recordId === last.recordId) : null
      /** 落库文档里到底有没有元素 —— 防"存回空骨架 / 存错 doc"这类错 */
      let storedElements = -1
      let storedHasText = false
      try {
        const d = JSON.parse(String(row?.docJson || ''))
        const els = [
          ...(d?.bands?.header ?? []),
          ...(d?.bands?.loop?.elements ?? []),
          ...(d?.bands?.footer ?? []),
        ]
        storedElements = els.length
        storedHasText = els.some((e) => e && e.kind === 'text')
      } catch {
        storedElements = -1
      }
      return {
        writes: w.length,
        writtenId: last ? last.recordId : null,
        writtenDocLen: last ? last.docLen : -1,
        storedElements,
        storedHasText,
        err: window.__tplHookErr || null,
        spec: window.__tplSpec || null,
        creates: creates.length,
        createdId: creates[0] ? creates[0].recordId : null,
        createdDocLen: creates[0] ? creates[0].docLen : -1,
        updates: updates.length,
        updatedId: last ? last.recordId : null,
        updatedDocLen: last ? last.docLen : -1,
        storedDocLen: row ? String(row.docJson || '').length : -1,
        rowCount: rows ? rows.length : -1,
      }
    })()`)
    ok(
      '⑦b 前提：落库观测装置真的挂上了（拿到了页面正在用的那一份 mock 模块）',
      hookInstalled === true && tplWrite?.err === null && typeof tplWrite?.spec === 'string',
      `钩子错误=${tplWrite?.err}；specifier=${tplWrite?.spec}`,
    )
    /**
     * 这条是**闭环**，四个条件缺一不可（每个都单独能红）：
     *   ① `updates >= 1` —— `commitEditor` 真的调了 `saveTemplate`（把 `await store.saveTemplate(...)`
     *      整段挖掉 → 这里立刻红）；
     *   ② `updatedId === createdId` —— 写的是**刚才建的那一条**，不是又插了一条新的；
     *   ③ `rowCount === 1` —— 模板表里**没有多出一条**（"不是只多了一条"就是这句在守）；
     *   ④ `updatedDocLen > createdDocLen` —— 落进去的 `docJson` 比建的时候**长**了：
     *      用户在编辑器里拖进去的元素真的被带回来了。只断言"调用了 saveTemplate"是不够的 ——
     *      那样传错 doc（比如把 `target.doc` 而不是 `editorDoc` 传下去）照样绿。
     *   `storedDocLen === updatedDocLen` 是把"表里现存内容"与"最后一次写入"对齐，
     *   防止出现"写了但被后来的写覆盖回旧的"。
     */
    /**
     * ⚠️ **判据写"结果"，别写"机制"**（2026-09-20 修正过一条）。
     *
     * 原版要求 `updates >= 1`（必须更新一条**已存在**的行）—— 那是假设
     * "新建模板时先落库、编辑完再更新"。换成插件内全屏编辑后，新建改成
     * **点完成时才落库**（惰性落库：用户取消就一条都不建），落库动作自然变成 insert，
     * 于是断言红了，而**功能是对的**。
     * ⇒ 四个条件全部落在"用户能看到的结果"上：
     *   ① 恰好一次落库（惰性落库的反面：不该有第二次）；
     *   ② 表里只一条（没多出重复行）；
     *   ③ 表里现存内容 == 最后写进去的那份（防"写了又被覆盖回旧的"）；
     *   ④ **落库文档里真的有元素**（防"把空骨架/错误的 doc 存进去"——
     *      只断言"调过 saveTemplate"是抓不到这种错的）。
     */
    ok(
      '⑦b 闭环：开编辑器 → 完成 之后，模板表里**恰好那一条**、内容是编辑后的（没多出一条 + 文档里有元素）',
      tplWrite?.writes === 1 &&
        tplWrite?.rowCount === 1 &&
        tplWrite?.storedDocLen === tplWrite?.writtenDocLen &&
        (tplWrite?.storedElements ?? -1) >= 1,
      `落库动作=${tplWrite?.writes} 次(最后写的是 recordId=${tplWrite?.writtenId}, docLen=${tplWrite?.writtenDocLen})；` +
        `表里现存=${tplWrite?.rowCount} 条(docLen=${tplWrite?.storedDocLen}, 元素数=${tplWrite?.storedElements}, 含文本=${tplWrite?.storedHasText})`,
    )
    /**
     * ⚠️ 这条断言**守到哪里为止**（2026-09-21 更新：独立窗口那条路已整体删除）。
     *
     * 以前这里要交代一件很绕的事：闭环分"真·独立窗口"与"弹窗被拦 → 侧边栏内联展开"两支，
     * 而只有后一支有端到端读数，前者要靠 `test/window-handshake.mjs` 补 ——
     * 于是这条注释花了一半篇幅说明"哪一半**没**被守住"。
     *
     * 现在**只有一支**（插件内全屏浮层 `EditorOverlay`），本文件读的就是它 ⇒
     * 那个"守到哪里为止"的缺口**消失了**，不需要再交代。
     * 保留这段是因为：以后若有人想把"开新窗口编辑"加回来，先读这里，别重走一遍。
     */
    // 钩子**不撤**（撤了反而要在两处维护）：它只记流水，不改行为。
    // 后面的段落若再产生模板写入，只会多几条记录，而上面这条读的是"最后一次 update"，
    // 且已在这条断言执行时定死 —— 不依赖之后发生什么。
    // ⚠️ 把数字打在**绿的那一次**里：`ok()` 只在失败时印 detail，绿的那次是空的，
    // 事后想核"到底长了多少"就只剩失败读数了（这个坑我踩过，所以这里显式打印）。
    console.log(
      `  （⑦b 观测：${tplWrite?.spec ?? '装钩失败'}；建 ${tplWrite?.creates} 次/${tplWrite?.createdDocLen} 字节` +
        ` → 更新 ${tplWrite?.updates} 次/${tplWrite?.updatedDocLen} 字节；表里 ${tplWrite?.rowCount} 条/${tplWrite?.storedDocLen} 字节）`,
    )
    } else {
      /*
       * 出口：**编辑器没能打开**时的降级（`.bp-fs` 没渲染出来）。
       * 这三条都不是"功能没做"，而是"本环境到不了"：页面内没有编辑器 ⇒
       * 拖不了元素、点不了「完成」、也就改写不了模板。
       *
       * ⚠️ 但"编辑器打不开"本身就是**异常**，上面 ④d 的那条断言已经把它判红了；
       * 这里只是不让后续段落整个崩掉，用 skip 如实报出来（不掩盖）。
       * 覆盖画布交互的套件是 `test/editor-interaction.mjs`。
       */
      skip('切到元素面板', '编辑器没打开（④d 已判红）；画布交互由 test/editor-interaction.mjs 覆盖')
      skip('拖放插入成功（画布上出现元素）', '同上；画布交互由 test/editor-interaction.mjs 覆盖')
      skip('从编辑器返回向导 / 模板已出现在列表', '同上；编辑器交互由 test/editor-interaction.mjs 覆盖')
      skip(
        '⑦b 闭环：开编辑器 → 完成 之后模板表里那一条被改写',
        '编辑器没打开 ⇒ 没有编辑器可驱动（④d 已判红）',
      )
    }

    // ------------------------------------------------------------
    console.log('\n[5] 进预览，验证真实排版产物')
    /**
     * ⚠️ **先换一条路进预览**（2026-09-19）。
     *
     * 原来的入口是"刚在编辑器里插完元素 → 点「下一步：预览」"，而那条路依赖编辑器，
     * 编辑器又依赖"窗口被拦 → 内联展开"这条**已被删掉**的分支 ⇒ 预览这整段跟着一起红。
     *
     * 现在改用 mock 的 `?tpl=N` 种子（见 `src/lib/mock-source.ts`）：
     * 页面起步就带 N 个**真实骨架建出来的**模板，点一张卡片就能进预览。
     * 好处是预览这一段的覆盖**不再和编辑器绑在一起** —— 两者本是独立的两块能力。
     */
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tpl=6` })
    await sleep(3200)
    await cdp.eval(HELPERS)
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(900)

    // ---- [3b] 模板卡片：一排两个（2026-09-19 用户要求"占用空间太大，改成一排两个"）----
    const cardList = await cdp.eval(`(() => {
      const list = document.querySelector('.wiz-tpl-list');
      const cs = list ? getComputedStyle(list) : null;
      const cards = Array.from(document.querySelectorAll('.wiz-tpl')).map((c) => {
        const r = c.getBoundingClientRect();
        return {
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          name: c.querySelector('.wiz-tpl-name')?.textContent ?? null,
          kind: c.querySelector('.wiz-kind')?.textContent ?? null,
          time: c.querySelector('.wiz-tpl-time')?.textContent ?? null,
        };
      });
      return { cols: cs ? cs.gridTemplateColumns : null, cards, listW: list ? Math.round(list.getBoundingClientRect().width) : 0 };
    })()`)
    const rowCount = new Map()
    for (const c of cardList?.cards ?? []) rowCount.set(c.y, (rowCount.get(c.y) ?? 0) + 1)
    const perRow = [...rowCount.values()]
    ok('⑤b 模板卡片**一排两个**（列数=2、每行恰好 2 张）', (cardList?.cards ?? []).length >= 2 && perRow.every((n) => n === 2), `列=${cardList?.cols}；每行张数=${JSON.stringify(perRow)}`)
    /**
     * ⚠️ UI 重设计（2026-09-21）改了**类型与时间的呈现方式**，两条期望随之更新：
     *   · 类型从"meta 行首的胶囊"变成**卡片右下角的半透明水印**（`opacity:.16` 的 34px 大字）——
     *     它仍然是**有字的**（"记录"/"视图"），这条断言守的"不能只靠颜色表意"不变；
     *   · 时间从 `YYYY-MM-DD HH:mm:ss` 收成 `MM-DD HH:mm`（设计稿的 `09-21 18:10`）。
     *     这不是为了省地方：模板表的「更新时间」列 2026-09-21 已被用户改成"只精确到分"
     *     （`dateFormat: 'yyyy-MM-dd HH:mm'`）⇒ 秒数永远是 :00，显示出来是**假精度**。
     *     完整时间仍挂在 `title` 上（悬停可见），所以信息没有丢。
     */
    ok(
      '⑤b 卡片带类型文字（记录/视图，不只是颜色）+ 最后编辑时间（分钟精度）',
      (cardList?.cards ?? []).every((c) => /记录|视图/.test(String(c.kind))) &&
        (cardList?.cards ?? []).some((c) => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(String(c.time))),
      `类型=${(cardList?.cards ?? []).map((c) => c.kind).join('/')}；时间样本=${(cardList?.cards ?? [])[0]?.time}`,
    )
    ok(
      '⑤b 卡片是紧凑的（单张高 ≤ 100px；"一排两个"就是为了省垂直空间）',
      (cardList?.cards ?? []).every((c) => c.h <= 100),
      `各张高=${(cardList?.cards ?? []).map((c) => c.h).join('/')}`,
    )
    /**
     * 重设计新增的三条**卡片几何**（设计稿给的都是确定值，所以能钉死）：
     * 圆角 10 / 类型底色按类型不同 / 右下角水印是绝对定位、无底色、半透明。
     * ⚠️ 水印那条特别值钱：`.wiz-kind` 原来是 meta 行里的胶囊（**有底色**），
     *    改水印时必须显式复位 `.wiz-tpl .wiz-kind.record/.view` 的 background ——
     *    只写在 `.wiz-tpl .wiz-kind` 上会被同优先级更高的旧规则盖掉，
     *    表现就是"卡片右下角多了一个蓝色方块"（我第一次就是那样）。
     */
    const cardStyle = await cdp.eval(`(() => {
      const rec = document.querySelector('.wiz-tpl.is-record');
      const view = document.querySelector('.wiz-tpl.is-view');
      const wm = document.querySelector('.wiz-tpl .wiz-kind');
      const cs = rec ? getComputedStyle(rec) : null;
      const w = wm ? getComputedStyle(wm) : null;
      return {
        radius: cs?.borderRadius ?? null,
        recBg: rec ? getComputedStyle(rec).backgroundColor : null,
        viewBg: view ? getComputedStyle(view).backgroundColor : null,
        wmPos: w?.position ?? null,
        wmBg: w?.backgroundColor ?? null,
        wmFont: w?.fontSize ?? null,
        wmOpacity: w?.opacity ?? null,
      };
    })()`)
    ok(
      '⑤b 卡片圆角 10 + 按类型配色（记录 ≠ 视图）',
      cardStyle?.radius === '10px' && !!cardStyle?.recBg && !!cardStyle?.viewBg && cardStyle.recBg !== cardStyle.viewBg,
      JSON.stringify(cardStyle),
    )
    ok(
      '⑤b 右下角类型水印是**无底色的半透明大字**（复位了胶囊的底色，否则会多出一个色块）',
      cardStyle?.wmPos === 'absolute' &&
        cardStyle?.wmBg === 'rgba(0, 0, 0, 0)' &&
        cardStyle?.wmFont === '34px' &&
        Number(cardStyle?.wmOpacity) < 0.3,
      JSON.stringify(cardStyle),
    )

    await cdp.eval(`document.querySelector('.wiz-tpl')?.click()`)
    await sleep(400)

    /**
     * 选中态必须是"**描边 + 光环 + 右上对勾徽标**"三件套，而且**不能盖住「・・・」菜单**
     * （设计稿把两者画在同一格上；本项目刻意让开 —— 选中是最常见的状态，
     *  对勾压住菜单等于菜单点不到，那是功能损失。`loop-table-browser.mjs` 就是点那个菜单的）。
     */
    const selState = await cdp.eval(`(() => {
      const on = document.querySelector('.wiz-tpl.on');
      if (!on) return null;
      const cs = getComputedStyle(on);
      const check = on.querySelector('.wiz-tpl-check');
      const dots = on.querySelector('.wiz-tpl-actions .app-btn');
      const cr = check?.getBoundingClientRect();
      const dr = dots?.getBoundingClientRect();
      const overlap = cr && dr ? !(cr.right <= dr.left || dr.right <= cr.left || cr.bottom <= dr.top || dr.bottom <= cr.top) : null;
      return {
        border: cs.borderTopColor,
        shadow: cs.boxShadow,
        bg: cs.backgroundColor,
        hasCheck: !!check,
        checkSize: cr ? Math.round(cr.width) + 'x' + Math.round(cr.height) : null,
        menuVisible: !!dots,
        overlap,
        // 卡内右上角：对勾的右边缘不应越出卡片
        checkInside: (() => { const r = on.getBoundingClientRect(); return cr ? cr.right <= r.right + 0.5 && cr.top >= r.top - 0.5 : null })(),
      };
    })()`)
    ok(
      '⑤m 选中态 = 蓝描边 + 3px 光环 + 卡内右上角对勾徽标（16px）',
      selState?.border === 'rgb(51, 112, 255)' &&
        /0px 0px 0px 3px/.test(String(selState?.shadow)) &&
        selState?.hasCheck === true &&
        selState?.checkSize === '16x16' &&
        selState?.checkInside === true,
      JSON.stringify(selState),
    )
    ok(
      '⑤m 对勾徽标**不压住**「・・・」菜单（选中是最常见状态，压住等于菜单点不到）',
      selState?.menuVisible === true && selState?.overlap === false,
      JSON.stringify({ menu: selState?.menuVisible, overlap: selState?.overlap }),
    )
    ok(
      '⑤m 选中时**保留类型底色**（设计稿：选中只改描边与光环，不把类型色洗掉）',
      selState?.bg !== 'rgba(51, 112, 255, 0.1)' && /^rgb\(246, 249, 255\)$/.test(String(selState?.bg)) === true,
      `选中卡底色=${selState?.bg}`,
    )

    {
      /**
       * ---- 卡片菜单不能被卡片裁掉（这一条是"实测挖出来的"）------------------
       *
       * UI 重设计的卡片要放右下角水印，而设计稿给卡片写了 `overflow: hidden`。
       * 照抄之后实测（`_ui-shot.mjs` 的 `card-menu` 探针）：
       *   `{"cardOverflow":"hidden","menuRect":{"w":150,"h":178},"overflowPx":173,"clipped":true}`
       * ⇒ 卡片上的「・・・」菜单（150×178，比卡片本身还高）**整块被裁掉**，
       *   编辑 / 重命名 / 另存为副本 / 导出此模板 / 复制到当前数据表 / 删除 **六个动作全点不到**，
       *   而截图上看只是"点了没反应"。
       * ⚠️ 这个坑 wizard.css 里早就写过一次警告（"将来若要再裁剪，别挂到 `.wiz-tpl` 上"），
       *    我是第二个踩的。所以这条守卫**必须留下**，它比"水印好不好看"重要得多。
       */
      const cardMenu = await cdp.eval(`(() => {
        const card = document.querySelector('.wiz-tpl.on') || document.querySelector('.wiz-tpl');
        const btn = card?.querySelector('.wiz-tpl-actions .app-btn');
        if (!card || !btn) return null;
        btn.click();
        return new Promise((r) => setTimeout(() => {
          const menu = card.querySelector('.wiz-tpl-menu');
          const mr = menu?.getBoundingClientRect();
          const cr = card.getBoundingClientRect();
          r({
            overflow: getComputedStyle(card).overflow,
            hasMenu: !!menu,
            items: menu ? menu.querySelectorAll('button').length : 0,
            menuH: mr ? Math.round(mr.height) : 0,
            overflowsCard: mr ? mr.bottom > cr.bottom + 1 : null,
          });
        }, 320));
      })()`)
      ok(
        '⑤m 卡片「・・・」菜单**没有被卡片裁掉**（overflow 必须是 visible；这个坑踩过两次）',
        cardMenu?.overflow === 'visible' && cardMenu?.hasMenu === true && cardMenu?.items >= 6 && cardMenu?.overflowsCard === true,
        JSON.stringify(cardMenu),
      )
      // 收起菜单（点空白），别影响后面的步骤
      await cdp.eval(`document.querySelector('.wiz-content')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      await sleep(250)
    }

    {
      /**
       * 网格最后一格是虚线「＋ 新建模板」，且**它就在同一张网格里**（不是另起一段）。
       * 这条守的是"重设计把底部的按钮组删掉之后，新建入口还在原来该在的地方"。
       */
      const gridTail = await cdp.eval(`(() => {
        const list = document.querySelector('.wiz-tpl-list');
        if (!list) return null;
        const kids = Array.from(list.children).map((c) => c.className);
        const add = list.querySelector('.wiz-tpl-add');
        const last = list.lastElementChild;
        const r = add?.getBoundingClientRect();
        const lr = list.getBoundingClientRect();
        return {
          kids: kids.length,
          cards: list.querySelectorAll('.wiz-tpl').length,
          addIsLast: !!add && last === add,
          addVisible: r ? r.width > 0 && r.height > 0 : false,
          addInListWidth: r && lr ? r.right <= lr.right + 0.5 && r.left >= lr.left - 0.5 : null,
        };
      })()`)
      ok(
        '⑤m 模板网格最后一格是虚线「＋ 新建模板」（新建入口没丢，只是换了位置）',
        gridTail?.addIsLast === true && gridTail?.addVisible === true && gridTail?.addInListWidth === true,
        JSON.stringify(gridTail),
      )
    }
    /**
     * ---- [5c] 数据量这件事**只说在选模板页**（2026-09-21 用户要求）----
     *
     * 用户的两次反馈合起来定义了现在的契约：
     *   · "当用户选择了全部数据、点击下一步选择模板，**此时不会有任何数据量过多的提示**，
     *     反而是用户如果选择了上一步或者点击顶部的导航返回到数据选择，**就会提示这个**"
     *     ⇒ 提示出现在**用户没有在改范围的时候**，等于对着他刚做完的事说教；
     *   · "**删除这个提示，不再限制用户打印数据量**，只在**模板选择页面轻提醒**"
     *     ⇒ 第①步那条红色阻断卡（"345 条 = 345 份文档" + 两个动作按钮）整体删除。
     *
     * ⇒ 这一段现在守的是**负向契约**：第①步**不许**再出现批量阻断警告。
     *   负向断言同样需要"会红"的可能 —— 它的牙齿由 `_r22-mut-e2e.mjs` 的
     *   "把那张卡加回来"突变来压（把 `{bulk && …}` 恢复 ⇒ 这里立刻红）。
     *   ⚠️ 别再写成"警告文案改成 XX"：那会变成**追着实现跑**的断言，
     *      下次再改文案又红一次，而真正要守的是"这一页不该有阻断"。
     */
    const READ_RANGE = `(() => ({
      alertCount: document.querySelectorAll('.wiz-alert').length,
      alertText: Array.from(document.querySelectorAll('.wiz-alert')).map((n) => n.textContent.trim()).join(' | '),
      // 2026-09-21：两张"事实卡"（.wiz-fact）已压成一条统计条（.wiz-stat）
      fact: Array.from(document.querySelectorAll('.wiz-stat-cell')).map((f) => (f.textContent || '').trim()).join(' | '),
    }))()`
    await cdp.eval(`__bp.clickText('button', '上一步')`)
    await sleep(800)
    const rangeA = await cdp.eval(READ_RANGE)
    ok(
      '⑤c【承重】第①步**不再**出现批量阻断警告（用户要求删除；别再顺手加回来）',
      rangeA?.alertCount === 0,
      `警告数=${rangeA?.alertCount}；正文=${rangeA?.alertText || '(无)'}`,
    )
    ok(
      '⑤c 第①步仍然**如实**给出份数（删掉的是"说教"，不是事实）',
      /份文档/.test(String(rangeA?.fact ?? '')),
      `统计条=${rangeA?.fact}`,
    )

    /**
     * ⛔ 这一段原来会**加一条筛选条件**（模拟"范围被收窄"）来验证"收窄与否都不弹警告"。
     *    2026-09-21 用户要求直接移除「筛选条件」功能 ⇒ 那条路已经没有入口了，
     *    于是这里改成**正向确认它真的没了**（找得到按钮才说明删得不干净）。
     * ⚠️ 别再写成"点开筛选条件后没有警告"：那会变成一条**永远绿的空断言**
     *    （点不到东西 ⇒ 后面的断言在同样的界面上照样通过）。
     */
    const filterGone = await cdp.eval(`({
      addOrEditBtn: Array.from(document.querySelectorAll('button')).filter((x) => ['添加', '编辑'].includes(x.textContent.trim())).length,
      condNodes: document.querySelectorAll('.wiz-cond, .wiz-cond-add, .wiz-cond-grid, .wiz-cond-head, .wiz-opts, .wiz-opt').length,
      /*
       * ⚠️ 只查**标题 / 按钮**里有没有"筛选条件"，不查整页正文 ——
       *    筛选结果为空时那句提示（"在表格里改一下**视图的筛选条件**"）会合法地包含这四个字，
       *    用整页 grep 会在"0 命中"的场景下假红。
       */
      titlesMentioning: Array.from(document.querySelectorAll('.app-section-title, .wiz-group-title, button'))
        .filter((x) => (x.textContent || '').includes('筛选条件')).length,
      alerts: document.querySelectorAll('.wiz-alert').length,
    })`)
    ok(
      '② 第①步**找不到**任何"筛选条件"的入口或残留（添加 / 编辑 / 条件卡 / 标题，全都没有）',
      filterGone?.addOrEditBtn === 0 && filterGone?.condNodes === 0 && filterGone?.titlesMentioning === 0,
      JSON.stringify(filterGone),
    )
    ok(
      '② 移除筛选条件后第①步干净无警告（原先那条"收窄也不弹"的负向契约继续成立）',
      filterGone?.alerts === 0,
      `警告数=${filterGone?.alerts}`,
    )

    // 回到步骤②继续走预览（`activeId` 还在，不用重新点卡片）
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(800)
    await cdp.eval(`__bp.clickText('button', '下一步：预览')`)
    await waitFor(cdp, `__bp.count('.wiz-prev-frame') > 0`, 25000, '预览 iframe 出现')

    const prev = await cdp.eval(`({
      hasFrame: __bp.count('.wiz-prev-frame') > 0,
      frameH: (document.querySelector('.wiz-prev-inner')||{}).offsetHeight || 0,
      text: document.body.innerText
    })`)
    ok('预览 iframe 已渲染', prev?.hasFrame === true)
    /**
     * ★ 层级修正（断言审计）：这一条原来写着"说明分页产物真的画出来了"，
     * 但量的是**宿主页里那个容器 div 的 offsetHeight** —— 容器高度来自它自己的 CSS/尺寸，
     * `buildDocumentHtml()` 返回空串时它照样 > 100。**缺陷在那一层不可能显现**，
     * 变异实测坐实过：`preview-empty` 下它仍绿，而同段读 iframe 内部的两条都红了。
     *
     * 现在按**它真正测的东西**改名（宿主侧 UI 没被折叠），
     * 而"分页产物真的画出来了"这个**原意**挪到下面读 iframe 内部去量（见 `pageH`）。
     * 不是删掉它 —— 折叠覆盖本身有价值，只是不该顶着别人的名字。
     */
    ok(
      '预览容器没被折叠（宿主侧 UI 高度；"产物真的画出来"由下面 iframe 内那条守）',
      (prev?.frameH ?? 0) > 100,
      `宿主容器高 ${prev?.frameH}`,
    )

    // 读 iframe 内部，确认是真实的纸张 DOM 而不是空壳
    const inner = await cdp.eval(`(() => {
      const f = document.querySelector('.wiz-prev-frame');
      if (!f || !f.contentDocument) return null;
      const d = f.contentDocument;
      const first = d.querySelector('.bp-page');
      return {
        pages: d.querySelectorAll('.bp-page').length,
        pageH: first ? Math.round(first.getBoundingClientRect().height) : 0,
        hasPageRule: /@page/.test(d.documentElement.innerHTML),
        noNaN: !/NaN/.test(d.documentElement.innerHTML)
      };
    })()`)
    ok('iframe 内含 1 个以上纸张页', (inner?.pages ?? 0) >= 1, `页数 ${inner?.pages}`)
    ok('渲染产物带 @page 规则', inner?.hasPageRule === true)
    // "分页产物真的画出来了"的原意 —— 必须在**产物所在的那一层**量：
    // 纸张得是真的有高度，不是 0 高的空壳。产物为空时这里必然是 0。
    ok(
      '预览里真的画出了分页产物（iframe 内第一张纸有真实高度，不是 0 高的空壳）',
      (inner?.pageH ?? 0) > 100,
      `iframe 内第一张纸高 ${inner?.pageH}px`,
    )
    // ★ 层级修正：「预览显示了页数」原来只读**宿主 UI 的文本** `/共 N 页/` ——
    // 页数是宿主自己算的，跟真正产出的文档没关系，产物为空时它照样绿。
    // 改成"宿主声称的 N"与"iframe 里真的渲染出来的纸张数"**两边对上**才算数。
    const claimedPages = Number((/共\s*(\d+)\s*页/.exec(String(prev?.text ?? '')) ?? [])[1] ?? Number.NaN)
    ok(
      '预览显示的页数不是空话（宿主说 N 页，iframe 里真的渲染出 N 张纸）',
      Number.isFinite(claimedPages) && claimedPages >= 1 && claimedPages === (inner?.pages ?? -1),
      `宿主声称 ${claimedPages} 页 / iframe 实际渲染 ${inner?.pages} 张`,
    )

    // ------------------------------------------------------------
    console.log('\n[6] 进输出页')
    await cdp.eval(`__bp.clickText('button', '下一步：输出')`)
    await sleep(800)
    const out = await cdp.eval(`({
      hasPrint: __bp.byText('button','打印（系统对话框）').length > 0,
      hasHtml: __bp.byText('button','保存打印就绪 HTML').length > 0,
      // 「导出 PDF」已于 2026-09-18 移除（浏览器不能静默生成 PDF，不留占位按钮）
      hasPdfRemoved: __bp.byText('button','导出 PDF').length === 0,
      text: document.body.innerText
    })`)
    ok('输出页有两种输出方式（打印 / 保存打印就绪 HTML）', out?.hasPrint && out?.hasHtml)
    ok('「导出 PDF」按钮确实已移除', out?.hasPdfRemoved === true)
    ok('输出页显示页数与记录数', /页/.test(String(out?.text ?? '')) && /条/.test(String(out?.text ?? '')))

    // ------------------------------------------------------------
    console.log('\n[7] 打开开发者菜单 → 切到探针页（真实用户路径）')
    // ⚠️ 以前这里是直接 `clickText('button','探针')` —— 点的是**藏在收起菜单里的那个按钮**。
    // 那条断言测的是"隐藏节点能被 JS 点到"，证明不了"用户到得了"：
    // 验证者实测过菜单收起时 `PROBE_E_CLICKED_WHILE_CLOSED_AND_PROBE_OPENED=true`。
    // 所以改成两步真实路径：先点标题栏的「开发者」，菜单展开后再点「探针」。
    const devClicked = await cdp.eval(`__bp.clickText('button', '开发者')`)
    await sleep(400)
    const menuOpen = await cdp.eval(`(() => {
      const m = document.querySelector('.app-dev-menu');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { hidden: m.hasAttribute('hidden'), w: Math.round(r.width), h: Math.round(r.height) };
    })()`)
    ok(
      '④c 点「开发者」后菜单真的展开（不再 hidden、占位非 0）',
      devClicked === true && menuOpen?.hidden === false && (menuOpen?.w ?? 0) > 0 && (menuOpen?.h ?? 0) > 0,
      `点击成功=${devClicked}；菜单=${JSON.stringify(menuOpen)}`,
    )
    /**
     * ⚠️ 这条**被验证者压红过**，说明它原来是个装饰（第三次冻结前的独立验证）。
     *
     * 它原来的名字是"④c 菜单展开后「探针」才可点（走的是用户真实路径，不是点隐藏节点）"，
     * 判据是 `__bp.clickText('button','探针')` 返回 true。验证者把开发者按钮的
     * `onClick` 改成空操作（**菜单永不展开**）之后，它**依然绿**：
     * `_v3b-mut-devc.txt` → `点击成功=true；菜单={"hidden":true,"w":0,"h":0}`。
     * 原因就在本文件的 HELPERS 里：`clickText` 是 `el.click()`，**隐藏节点照样点得到**；
     * 而下一步"探针页可打开"也跟着绿（点隐藏节点同样能切 tab）。
     *
     * 也就是说"点到了"这件事，在同一份页面上有两种来源：用户展开后点到 / 点在隐藏树里。
     * 只断言"点到了"区分不了这两者 —— 这正是本轮要修的那个毛病，
     * 上一版只修了一半（改成"先点开发者再点探针"），第二条仍是装饰。
     *
     * 改法：**在展开的菜单容器子树里**找它，三层判据缺一不可：
     *   ① 菜单容器存在、`hidden === false`、**自身 rect 非 0**（菜单真的占位了）；
     *   ② 「探针」条目必须是**这个容器的子树里**的按钮（不再全局搜）；
     *   ③ 它**自己的 rect 非 0**（在这份菜单里真的可见可点），且点的就是它。
     * 菜单没展开时①②③全不成立：`hidden` 元素的子树 rect 恒为 0×0 ⇒ 这条必红。
     * （"用户能不能真的按下去"仍由 ④b/④c 第一条 + 下面 waitFor 的探针页一起兜。）
     */
    const probeEntry = await cdp.eval(`(() => {
      const m = document.querySelector('.app-dev-menu');
      if (!m) return { menu: null, items: null, inMenu: false, entry: null, clicked: false };
      const btns = Array.from(m.querySelectorAll('button'));
      const items = btns.map((b) => (b.textContent || '').trim());
      const mr = m.getBoundingClientRect();
      const menu = { hidden: m.hasAttribute('hidden'), w: Math.round(mr.width), h: Math.round(mr.height) };
      const el = btns.find((b) => (b.textContent || '').trim() === '探针') || null;
      if (!el) return { menu, items, inMenu: false, entry: null, clicked: false };
      const r = el.getBoundingClientRect();
      const entry = { text: '探针', w: Math.round(r.width), h: Math.round(r.height) };
      el.click();
      return { menu, items, inMenu: true, entry, clicked: true };
    })()`)
    ok(
      '④c 菜单展开后「探针」才可点（必须在**展开的菜单容器子树里**找到它并点它 —— 不是全局搜一个隐藏节点来点）',
      probeEntry?.inMenu === true &&
        probeEntry?.menu?.hidden === false &&
        (probeEntry?.menu?.w ?? 0) > 0 &&
        (probeEntry?.menu?.h ?? 0) > 0 &&
        (probeEntry?.entry?.w ?? 0) > 0 &&
        (probeEntry?.entry?.h ?? 0) > 0 &&
        probeEntry?.clicked === true,
      `菜单里的按钮=${JSON.stringify(probeEntry?.items)}；菜单=${JSON.stringify(probeEntry?.menu)}；` +
        `「探针」条目=${JSON.stringify(probeEntry?.entry)}；点了=${probeEntry?.clicked}`,
    )
    // 绿的那次也要把派生读数打出来（`ok()` 只在失败时印 detail —— 这个坑本文件里已经踩过一次）。
    console.log(
      `  （④c 观测：菜单里的按钮=${JSON.stringify(probeEntry?.items)}；菜单=${JSON.stringify(probeEntry?.menu)}；` +
        `「探针」条目=${JSON.stringify(probeEntry?.entry)}）`,
    )

    await waitFor(cdp, `__bp.byText('button','全部非破坏性').length > 0`, 8000, '探针页')
    const probeUi = await cdp.eval(`({
      hasGroups: __bp.byText('button','全部非破坏性').length > 0 && __bp.byText('button','关键 3 项').length > 0,
      hasLiveCard: document.body.innerText.includes('选中态实时监听'),
      hasPerProbeRun: __bp.byText('button','运行').length >= 10,
      listed: ['P1','P2','P3','P4','P5','P6','P7','P8','P9','P10'].every(id => document.body.innerText.includes(id)),
      hasIntro: document.body.innerText.includes('这一步要验什么')
    })`)
    ok('探针页可打开', probeUi?.hasIntro === true)
    ok('有快捷组合按钮', probeUi?.hasGroups === true)
    ok('有选中态实时监听卡片', probeUi?.hasLiveCard === true)
    ok('列出全部 10 条探针', probeUi?.listed === true)
    ok('每条探针都有独立运行按钮', probeUi?.hasPerProbeRun === true)

    // ------------------------------------------------------------
    // [8] 字段顺序降级时的**用户可见提示**（2026-09-19 新增）
    //
    // 守的是"降级了但用户不知道"这一类静默失败。
    // `?fieldOrder=table` 是 mock 的测试开关（见 src/lib/mock-source.ts）：
    // 真机上这条提示只在 SDK 恰好读不到视图级字段序时出现，本地复现不了，
    // 所以给了个显式开关 —— 否则"改完有没有生效"只能靠想象。
    // 这一段的最后一条是**反向对照**：不带开关就不许提示（不能变成常驻噪音）。
    console.log('\n[8] 字段顺序读不到要如实告知（不能只在控制台里说）')
    const HINT_RE = /行标签可能不是/
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1` })
    await sleep(2600)
    await cdp.eval(HELPERS)
    const noFlag = await cdp.eval(`document.body.innerText.split('\\n').filter((t) => ${HINT_RE}.test(t)).length`)
    ok('不带开关时**不提示**字段顺序（mock 没有视图列序这个概念，不该常驻吓人）', noFlag === 0, `命中 ${noFlag} 条`)

    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&fieldOrder=table` })
    await sleep(2600)
    await cdp.eval(HELPERS)
    // 提示在「筛选结果」那一块里（默认范围就是视图筛选）——按整页文本找，不绑具体容器
    const withFlag = await cdp.eval(`document.body.innerText.split('\\n').filter((t) => ${HINT_RE}.test(t)).length`)
    ok(
      '视图级字段序读不到时，界面上有一句**看得见**的提示（以前只打 console，用户看不见）',
      withFlag >= 1,
      `命中 ${withFlag} 条 —— 命中 0 说明 getter / 传参 / 渲染 有一处断了`,
    )

    // ------------------------------------------------------------
    // [9] 必须在 finally 之前出结论：浏览器清理是"尽力而为"，不能让它拖住测试结果。
    // （踩过：`await Browser.close` 会一直挂到超时，把 [9] 和总结一起吞掉。）
    /**
     * ---- [8c] 插件内全屏编辑（2026-09-20，取代 window.open 的独立窗口）----
     *
     * 为什么这条路值得单独守：飞书**代理了 `window.open`** —— 窗口真开了、返回值却是 `null`，
     * 于是父窗口既没有句柄也没有 opener，postMessage / localStorage / window.name
     * **三条回传通道同时断掉**，结果只能靠"手动复制 → 回插件粘贴"（为此还上过一套中转服务器）。
     *
     * 挪进插件内之后，编辑器与数据源在**同一个文档**里 ⇒ 保存直接走 SDK 落库。
     * 所以这里要守住的三件事：
     *   ① 它真的是**覆盖插件可视区**的全屏浮层（不是又一个小内联框）；
     *   ② 它挂在 `document.body` 上（portal）—— `position:fixed` 的包含块会被**任何有 transform
     *      的祖先**改写，飞书容器层层嵌套，不挂 body 就有"浮层只盖住半屏"的风险；
     *   ③ 全屏状态**如实显示**：真全屏 / 容器内全屏（以及为什么拿不到真全屏）。
     */
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tpl=2` })
    await sleep(2600)
    // ⚠️ 导航会**清掉页面上下文**，`__bp` 辅助函数得重新装一遍（本文件上一段导航后就是这么做的，
    // 我漏了这一行，结果整整一段崩在 `__bp is not defined`）。
    await cdp.eval(HELPERS)
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(900)
    // 卡片的「…」菜单 → 「编辑」
    await cdp.eval(`(() => {
      const b = document.querySelector('button[aria-label="更多操作"]')
      if (b) b.click()
      return !!b
    })()`)
    await sleep(400)
    const openedEditor = await cdp.eval(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((x) => (x.textContent || '').trim() === '编辑')
      if (!item) return { clicked: false, items: Array.from(document.querySelectorAll('[role="menuitem"]')).map((x) => (x.textContent || '').trim()) }
      item.click()
      return { clicked: true }
    })()`)
    await sleep(700)
    ok('⑤f 卡片菜单里有「编辑」且点得动', openedEditor?.clicked === true, JSON.stringify(openedEditor))

    const ov = await cdp.eval(`(() => {
      const el = document.querySelector('.bp-fs')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        parentIsBody: el.parentElement === document.body,
        w: Math.round(r.width), h: Math.round(r.height),
        vw: window.innerWidth, vh: window.innerHeight,
        /**
         * ⚠️ 状态说明**不该再单独占位**（用户原话："直接移除这个字，不然用户会误以为可以点击"）——
         * 它原来是段蓝色小字，看着像个链接。信息挪到了尺寸按钮的 title 属性上。
         */
        hasStatusText: !!document.querySelector('.bp-fs-status'),
        /** ⚠️「完成」在整个编辑器里**只能有一个** —— 用户报的"两个标题、两个完成"就是这条在守 */
        doneCount: Array.from(el.querySelectorAll('button')).filter((b) => (b.textContent || '').trim() === '完成').length,
        /** 尺寸按钮（全屏/缩小）—— 已经**并进 EditorShell 顶栏**，不再单独占一行 */
        sizeBtn: (() => {
          const b = Array.from(el.querySelectorAll('button')).find((x) => ['缩小', '全屏'].includes((x.textContent || '').trim()))
          if (!b) return null
          return { text: (b.textContent || '').trim(), inTopRow: !!b.closest('.bp-top'), title: b.getAttribute('title') || '' }
        })(),
        /** 旧的独立顶栏容器应当**彻底消失** */
        hasOwnBar: !!el.querySelector('.bp-fs-bar'),
        oldInlineHost: !!document.querySelector('.wz-editor-host'),
      }
    })()`)
    ok('⑤f 编辑器是全屏浮层（覆盖插件可视区，不是小内联框）', ov !== null, JSON.stringify(ov))
    ok(
      '⑤f 浮层挂在 document.body 上（portal —— 避免 fixed 被祖先 transform 改掉包含块）',
      ov?.parentIsBody === true,
      `parentIsBody=${ov?.parentIsBody}`,
    )
    ok(
      '⑤f 浮层尺寸 == 视口尺寸（"容器内全屏"就是这个判据）',
      Math.abs((ov?.w ?? 0) - (ov?.vw ?? -1)) <= 1 && Math.abs((ov?.h ?? 0) - (ov?.vh ?? -1)) <= 1,
      `${ov?.w}×${ov?.h} vs 视口 ${ov?.vw}×${ov?.vh}`,
    )
    ok('⑤f 旧的侧边栏内联容器已不再使用', ov?.oldInlineHost === false, `still=${ov?.oldInlineHost}`)
    ok(
      '⑤f 「完成」在整个编辑器里**只出现一次**（顶栏不再重复 EditorShell 的完成）',
      ov?.doneCount === 1,
      `完成按钮数=${ov?.doneCount}`,
    )
    ok(
      '⑤f 尺寸按钮**并进了 EditorShell 顶栏那一行**（不再单独占一行 —— 用户嫌"看着有点怪"）',
      ov?.sizeBtn?.inTopRow === true && ov?.hasOwnBar === false,
      `尺寸按钮=${JSON.stringify(ov?.sizeBtn)}；还有独立顶栏=${ov?.hasOwnBar}`,
    )
    /**
     * 状态说明从"一段蓝色小字"改成**按钮的 title**：
     * 用户明确要求移除那段字（"不然会误以为可以点击"），但"为什么没进真全屏"这条信息不能丢 ——
     * 它是排查"全屏没生效"的唯一线索，所以挂在按钮上，鼠标停一下就能看到。
     */
    ok(
      '⑤f 状态说明不再单独占位，改为挂在尺寸按钮的 title 上（信息没丢、也不会被当成链接）',
      ov?.hasStatusText === false && typeof ov?.sizeBtn?.title === 'string' && ov.sizeBtn.title.length > 0,
      `还有独立状态文字=${ov?.hasStatusText}；按钮 title=${ov?.sizeBtn?.title}`,
    )

    /**
     * ---- 「缩小」：从全屏退回插件内的内嵌档（2026-09-20 用户要求）----
     *
     * 用户原话："进入全屏画布后，无法退回到插件内小屏的效果，只能退出编辑或者完成，
     * 能否增加缩小的功能"。判据要落在**尺寸真的变了**上 —— 只断言"按钮在"是不够的。
     */
    await cdp.eval(`__bp.clickText('button', '缩小')`)
    await sleep(500)
    const inline = await cdp.eval(`(() => {
      const el = document.querySelector('.bp-fs--inline')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        h: Math.round(r.height), vh: window.innerHeight,
        pos: getComputedStyle(el).position,
        sizeBtn: (() => {
          const b = Array.from(el.querySelectorAll('button')).find((x) => ['缩小', '全屏'].includes((x.textContent || '').trim()))
          return b ? (b.textContent || '').trim() : null
        })(),
        doneCount: Array.from(el.querySelectorAll('button')).filter((b) => (b.textContent || '').trim() === '完成').length,
      }
    })()`)
    ok('⑤f 点「缩小」后回到内嵌档（不再是盖满视口的浮层）', inline !== null, JSON.stringify(inline))
    ok(
      '⑤f 内嵌档的高度明显小于视口（"缩小"必须真的变小，不是只换个名字）',
      (inline?.h ?? 1e9) < (inline?.vh ?? 0) && inline?.pos === 'relative',
      `高=${inline?.h} 视口高=${inline?.vh} position=${inline?.pos}`,
    )
    ok(
      '⑤f 缩小后按钮翻成「全屏」（同一个按钮切两档，不留一个永远空操作的）',
      inline?.sizeBtn === '全屏',
      `按钮=${inline?.sizeBtn}`,
    )
    ok('⑤f 缩小后「完成」仍然只有一个', inline?.doneCount === 1, `完成按钮数=${inline?.doneCount}`)

    /**
     * 退出编辑（现在归 EditorShell 顶栏）→ **必须先确认** → 浮层消失。
     * ⚠️ 那个按钮是**图标按钮**（只有 `aria-label="返回模板列表"`、没有文字），
     * 所以不能按文案点 —— 第一版按文案点，什么都没点到，白白红了一条。
     */
    const backClicked = await cdp.eval(`(() => {
      const b = document.querySelector('button[aria-label="返回模板列表"]')
      if (b) b.click()
      return !!b
    })()`)
    await sleep(400)
    /**
     * ---- 退出保护：**没改动**直接退、**有改动**必须先问一句 ----
     *
     * ⚠️ 我第一版这一段**从头到尾没改过任何东西**，却断言"应该出现确认层" ⇒ 假红。
     * 而"手滑点返回就丢改动"正是这次修的洞 —— 所以要**真的造出一个未保存改动**才验得到。
     * 两条一起守，才算把语义写准：
     *   ① 干净时**别打扰**（每次退出都弹确认，用户会烦到直接闭眼点确定）；
     *   ② 有改动时**必须问**（不问就是悄悄丢用户的工作）。
     */
    ok('⑤f 干净状态下点「返回」直接退出（不弹无意义的确认）', backClicked === true && inline !== null)
    const confirmClean = await cdp.eval(`!!document.querySelector('.bp-fs-confirm')`)
    ok('⑤f 没改动时不该出现确认层', confirmClean === false, `确认层=${confirmClean}`)

    // 重新打开编辑器，**造一个真实改动**（从元素面板拖一个文本段落进画布）
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(800)
    await cdp.eval(`(() => { const b = document.querySelector('button[aria-label="更多操作"]'); if (b) b.click(); return !!b })()`)
    await sleep(400)
    await cdp.eval(`(() => {
      const it = Array.from(document.querySelectorAll('[role="menuitem"]')).find((x) => (x.textContent || '').trim() === '编辑')
      if (it) it.click()
      return !!it
    })()`)
    await sleep(800)
    await cdp.eval(`__bp.clickText('button', '元素')`)
    await sleep(500)
    const dirtied = await (async () => {
      const itemSel = `Array.from(document.querySelectorAll('button.bp-el-item')).find(b => (b.textContent||'').includes('文本段落'))`
      const from = await centerOf(cdp, itemSel)
      if (!from) return 'no-palette-item'
      const area = await centerOf(cdp, `document.querySelector('.bp-canvas-area')`)
      if (!area) return 'no-canvas-area'
      const to = { x: area.x, y: area.top + Math.min(70, Math.max(30, Math.round(area.h * 0.25))) }
      await pointerDrag(cdp, from, to)
      await sleep(700)
      return 'dragged'
    })()
    ok('⑤f 造改动：往画布里拖进一个元素（否则"有改动要确认"这条根本没被测到）', dirtied === 'dragged', dirtied)

    const back2 = await cdp.eval(`(() => {
      const b = document.querySelector('button[aria-label="返回模板列表"]')
      if (b) b.click()
      return !!b
    })()`)
    await sleep(400)
    const confirmDirty = await cdp.eval(`!!document.querySelector('.bp-fs-confirm')`)
    ok(
      '⑤f **有未保存改动**时点「返回」必须先问一句（手滑一下就丢改动是这个洞的原样）',
      back2 === true && confirmDirty === true,
      `确认层=${confirmDirty}`,
    )

    await cdp.eval(`(() => {
      const b = Array.from(document.querySelectorAll('.bp-fs-confirm button')).find((x) => (x.textContent || '').includes('退出') || (x.textContent || '').includes('放弃'))
      if (b) b.click()
      return !!b
    })()`)
    await sleep(500)
    const gone = await cdp.eval(`document.querySelectorAll('.bp-fs').length`)
    ok('⑤f 确认后浮层消失（不会卡在全屏里出不来）', gone === 0, `残留浮层=${gone}`)

    /**
     * ---- [8d] 新建模板必须**新增一条**，不许替换掉已有模板（2026-09-20 用户报的严重 bug）----
     *
     * 用户原话："新建模板的时候，新建的模板会**直接替换掉原有模板列表中的第一个表**，
     * 不会新增一个表出来"，并且"选模板界面只有视图类型的表，**记录类型的表不在了**"。
     * 两个症状同一个根因：`commitEditor` 先判 `active`，而 `active` 因"加载后自动选中第一条"
     * 几乎总是非空 ⇒ "新建"走了"更新"分支 ⇒ 覆盖第一条；被覆盖的若是记录模板，类型也随之变视图。
     *
     * ⚠️ **为什么必须新起一段**：本脚本前面那条创建路线用的是 `?mock=1`（**0 个模板**）——
     * 没有可覆盖的东西，这个 bug 在那里**永远测不到**（断言的前提本身就不成立）。
     * 这一段用 `?mock=1&tpl=2` 起两张种子模板，才复现出用户的环境。
     */
    console.log('\n[8d] 新建模板必须新增一条（不许替换第一条）')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tpl=2` })
    await sleep(2600)
    await cdp.eval(HELPERS)
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(900)
    /** 种子的名字（DOM 读，不依赖任何 mock 实例捕获时机的巧合） */
    const READ_TPL = `Array.from(document.querySelectorAll('.wiz-tpl')).map((c) => ({
      name: (c.querySelector('.wiz-tpl-name')?.textContent || '').trim(),
      kind: (c.querySelector('.wiz-kind')?.textContent || '').trim(),
    }))`
    const seedTpls = await cdp.eval(READ_TPL)
    const seedNames = (seedTpls ?? []).map((t) => t.name)
    ok('前提：这一屏**确实有已存在的模板**（否则"覆盖第一条"根本无从复现）', (seedNames?.length ?? 0) >= 2, `种子=${JSON.stringify(seedNames)}`)

    // 走"新建模板（选骨架）"→ 选一个 → 创建并编辑
    await cdp.eval(`__bp.clickText('button', '新建模板') || __bp.clickText('button', '新建模板（选骨架）')`)
    await sleep(900)
    /** 顺手记下所选骨架的名字：新建的那一条就该叫它（`SkeletonPicker` 里 `onCreate(name || sk.name, …)`） */
    const skelName = await cdp.eval(`(() => {
      /**
       * ⚠️ 骨架**不能**用「入库单」：这一屏的第一张种子模板恰好就叫「入库单」
       * （SEED_NAMES[0]），标题与种子重名的话就分不清"显示对了"还是"显示了上一个模板"。
       * 换成「出库单」—— 与两张种子模板都不重名，断言才有区分度。
       * （⚠️ 本段注释在 cdp.eval 的模板字符串里，**不能出现反引号**，否则整个文件语法错误。）
       */
      const it = Array.from(document.querySelectorAll('.sk-item')).find((e) => (e.textContent || '').includes('出库单'))
      if (!it) return null
      const n = (it.querySelector('.sk-item-name')?.textContent || '').trim()
      it.click()
      return n
    })()`)
    ok('前提：找到了「入库单」骨架并能点中（否则下面那条断言无从判定）', !!skelName, `骨架名=${skelName}`)
    await sleep(300)
    await cdp.eval(`__bp.clickText('button', '创建并编辑')`)
    await waitFor(cdp, `__bp.byText('button','完成').length > 0`, 15000, '编辑器打开')

    /**
     * ---- [8d2] 编辑器左上角的模板名必须是**这一份**的，不能是上一个模板的 ----
     *
     * 用户原话："我在画布中编辑了模板 A 并保存，再创建另一份模板 B，不论选择了什么骨架，
     * 打开左上角都显示 A，但如果不去修改它，直接点完成名字却是正常的 B。"
     *
     * 根因：`Wizard.tsx` 里 `templateName={w.active?.name ?? w.pendingNew?.name ?? '新建模板'}` ——
     * **判据反了**。`active` 因"加载模板后自动选中第一条"几乎总是非空，
     * 于是新建时显示的是`active`（= 上一个模板）的名字；同一段里的 `onRename` 也只认 `active`
     * ⇒ 在新模板上改名会**把上一个模板改掉**（比标题错更严重，那是改错数据）。
     *
     * ⇒ 两条都守：标题要对；改名后**种子模板的名字一个都不能变**，而新模板要叫改后的名字。
     *   （只断言标题的话，"改名改错对象"这半边会漏掉。）
     */
    const READ_TITLE = `(() => {
      const b = document.querySelector('.bp-fs .bp-name')
      return b ? (b.textContent || '').trim() : null
    })()`
    const titleOnOpen = await cdp.eval(READ_TITLE)
    ok(
      '⑤i【承重】新建模板的编辑器标题是**这一份**的名字（原来显示的是上一个模板的名字）',
      !!titleOnOpen && !(seedNames ?? []).includes(titleOnOpen),
      `标题=${titleOnOpen}；种子模板=${JSON.stringify(seedNames)}`,
    )
    ok(
      '⑤i 标题就是所选骨架的名字（不是「新建模板」这种占位，也不是上一个）',
      titleOnOpen === skelName,
      `标题=${titleOnOpen} 骨架名=${skelName}`,
    )

    // 在画布上改个名：点名字 → 改值 → 提交（controlled input 要走原生 setter）
    const RENAMED = '出库单（改名了）'
    await cdp.eval(`(() => { const b = document.querySelector('.bp-fs .bp-name'); if (b) b.click(); return !!b })()`)
    await sleep(300)
    const typed = await cdp.eval(`(() => {
      const inp = document.querySelector('.bp-fs .bp-name__input')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, ${JSON.stringify('出库单（改名了）')})
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    ok('前提：编辑器标题可以改（点开后变成输入框）', typed === true, `typed=${typed}`)
    await sleep(200)
    /**
     * ⚠️ 提交要走**真事件**：`inp.blur()` 试过，React 的 `onBlur` 没被触到
     * （`nameEditing` 一直是 true，`.bp-name` 渲染不出来 ⇒ 标题读成 null）。
     * 这里补一条 Enter 的 keydown —— 那也是 `EditorShell` 里 `commitName` 的正规入口之一，
     * 比"模拟失焦"更贴近用户真实动作。
     */
    /*
     * ⚠️ **这条断言原来会偶发红**（2026-09-22 实测：同一份代码连跑两次，一次 committed=false 一次 true）。
     *
     * 病根：它断言的是"**我有没有派发成功**" —— 而 `committed` 只有在读不到 `.bp-name__input` 时才是 false。
     * 也就是说，输入框在"打字"与"提交"这两次 eval 之间（隔 200ms）**自己消失了**，
     * 于是断言红，可改名其实已经发生（后面读标题那条照样能过）。
     * ⇒ 判据换成**可观测的结果**：等标题文本真的变成新值。
     *    这样无论"输入框还在、我按了回车"还是"输入框自己关掉了、提交已经生效"，都判绿；
     *    而真正没提交（标题还是旧值）时照样判红 —— 这才叫守住了契约。
     */
    await cdp.eval(`(() => {
      const inp = document.querySelector('.bp-fs .bp-name__input')
      if (!inp) return false
      inp.focus()
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      inp.blur()
      return true
    })()`)
    const titleCommitted = await waitFor(
      cdp,
      `(document.querySelector('.bp-fs .bp-name')?.textContent || '').includes('改名了')`,
      6000,
      '标题文本真的变成新值',
    )
    ok('前提：改名能提交（回车 / 失焦二选一）', titleCommitted === true, `标题已变成新值=${titleCommitted}`)
    await sleep(600)
    const titleAfterRename = await cdp.eval(READ_TITLE)
    ok('⑤i 改名当场生效（标题跟着变）', titleAfterRename === RENAMED, `标题=${titleAfterRename} 期望=${RENAMED}`)

    await cdp.eval(`__bp.clickText('button', '完成')`)
    await waitFor(cdp, `__bp.count('.wiz-tpl') > 0`, 15000, '回到模板列表')
    await sleep(600)

    const afterTpls = await cdp.eval(READ_TPL)
    const afterNames = (afterTpls ?? []).map((t) => t.name)
    const lost = (seedNames ?? []).filter((n) => !(afterNames ?? []).includes(n))
    /**
     * ⚠️ 我一开始在这条上写错了理由：以为覆盖会连**类型**一起改成新骨架的。
     * 跑突变测试才发现——覆盖走的是 `saveTemplate({recordId: active.recordId,
     * name: active.name, kind: active.kind, doc: editorDoc})`，
     * **名字和类型都保留旧的，只有内容被换掉** ⇒ 类型断言在突变下照样绿。
     * ⇒ 换成真正能表示"新增了"的判据：**列表里必须多出一个种子没有的名字**。
     */
    const added = afterNames.filter((n) => !(seedNames ?? []).includes(n))
    ok(
      '⑤h 新建模板是**新增一条**：原来那些模板一个都没少，且总数 +1（"替换掉第一个表"的守卫）',
      (afterNames?.length ?? 0) === (seedNames?.length ?? 0) + 1 && lost.length === 0,
      `新建前 ${seedNames?.length} 条 ${JSON.stringify(seedNames)} → 新建后 ${afterNames?.length} 条 ${JSON.stringify(afterNames)}；丢失=${JSON.stringify(lost)}`,
    )
    ok(
      '⑤h 新建的那一条**确实出现在列表里**（多出来的那个名字就是新骨架的名字，不是把旧内容换掉）',
      added.length === 1,
      `新增的名字=${JSON.stringify(added)}；前=${JSON.stringify(seedTpls)}；后=${JSON.stringify(afterTpls)}`,
    )

    /**
     * ⚠️ 改名那半边必须**回到列表才能验**：编辑器全屏浮层盖住时 `.wiz-tpl` 根本没渲染。
     * 这也是"只断言标题"会漏掉的那一半 —— 标题对了，但改名可能仍然改在 `active` 上。
     */
    ok(
      '⑤i【承重】改名改的是**这一份新模板**：种子模板的名字一个都没变（原来 `onRename` 只认 `active`，改的是上一个模板）',
      lost.length === 0,
      `丢失/被改名的种子=${JSON.stringify(lost)}；现在的列表=${JSON.stringify(afterNames)}`,
    )
    ok(
      '⑤i 新模板以**改名后**的名字落库（编辑器里改的名字要跟着走到表里）',
      (afterNames ?? []).includes(RENAMED),
      `改名后期望含 ${RENAMED}；实际=${JSON.stringify(afterNames)}`,
    )
    /**
     * 种子模板的**类型**也必须原样 —— 这是同一个 bug 的另一半：
     * 一旦走了"更新 active"那条分支，被覆盖的模板会连类型一起变（用户看到"记录类型的表不在了"）。
     * 名字相同不足以证明没被动过，类型一起比才算钉住。
     */
    const kindDrift = (afterTpls ?? []).filter((t) => {
      const before = (seedTpls ?? []).find((s) => s.name === t.name)
      return before && before.kind !== t.kind
    })
    ok(
      '⑤i 种子模板的**类型**也一个都没被改写（"记录类型的表不在了"的守卫）',
      kindDrift.length === 0,
      `类型漂移=${JSON.stringify(kindDrift)}`,
    )

    /**
     * ---- [8e] 「完成」的落库顺序 + 保存后默认选中（2026-09-21 用户报的两个问题）----
     *
     * 用户原话：
     *   ① "全屏状态编辑完成后点击完成，**画布会先缩小到侧边栏展开的状态**，然后才会跳转到
     *      模板选择界面，能不能直接完成后就跳转到模板保存界面？"
     *   ② "不论是编辑还是新建模板，保存后跳回模板选择界面，**默认选中刚才新增/修改的那个模板**。"
     *
     * ── ① 的根因（值得记住，因为它是一个**语法级**的坑）────────────────
     * `EditorOverlay.finish` 里写的是 `await onDone()`，而 `Wizard` 传的是
     * `() => void w.commitEditor()` —— **箭头函数返回 undefined**，`await` 立刻过。
     * 于是顺序成了"先 `exitFullscreen()` ⇒ `onFullscreenChange(false)` 把容器档收成
     * `inline` ⇒ 用户看到画布缩回小窗；而落库还在等 SDK 往返"。
     * `void` 这个修饰符把返回值抹掉，调用方**看不出来**，类型检查也拦不住。
     *
     * ── 为什么这一段能真的压红它（本机是**没有**真全屏的，见下）────────────
     * ⚠️ 本地无头 Edge 里 `document.fullscreenElement` 恒为 null ⇒ `exitFullscreen()`
     * 整段是**空操作**（见 `lib/fullscreen.ts`），"先缩回小画布"这个观感**在本机复现不出来**。
     * 所以不能靠"看有没有缩"来断言，改成直接测**顺序**：
     *   · 把 `document.fullscreenElement` 打桩成真值 ⇒ `exitFullscreen()` 才会真的走那一步；
     *   · 把 `document.exitFullscreen` 换成记录器；
     *   · 把落库拖慢 700ms ⇒ 制造一个可观测窗口。
     * 判据：调用顺序必须是 `save:start > save:end > exit`。
     * 把 `onDone` 改回 `() => void w.commitEditor()` ⇒ 顺序变成 `save:start > exit > save:end` ⇒ **红**。
     */
    console.log('\n[8e] 完成后直接跳转（不许先缩回小画布）+ 保存后默认选中刚存的那条')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tpl=2` })
    await sleep(2600)
    await cdp.eval(HELPERS)
    // ⚠️ 导航会清掉页面里的原型补丁 ⇒ 观测装置必须重装（这就是它被提成常量的原因）
    const hooksAgain = await cdp.eval(INSTALL_TPL_HOOKS)
    ok('前提：[8e] 段在新导航后能重装观测装置', hooksAgain === true)
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(900)

    const READ_SELECTED = `(() => {
      const c = document.querySelector('.wiz-tpl.on');
      return c ? (c.querySelector('.wiz-tpl-name')?.textContent || '').trim() : null;
    })()`
    const seedTplsE = await cdp.eval(READ_TPL)
    const seedNamesE = (seedTplsE ?? []).map((t) => t.name)
    const selectedBefore = await cdp.eval(READ_SELECTED)
    ok(
      '前提：进列表时已有 ≥2 条模板、且已有选中（"保存后选中"才有判据）',
      (seedNamesE?.length ?? 0) >= 2 && !!selectedBefore,
      `种子=${JSON.stringify(seedNamesE)}；当前选中=${JSON.stringify(selectedBefore)}`,
    )

    /**
     * ⚠️ 这段**故意不去用 `window.__tplDS`**（第一版就是栽在这上面，报 `no-ds`）：
     * 实例是"第一次 `listTemplateRows` 被调到"时才捕获的，而 `Page.navigate` 之后
     * 页面的那次 `loadTemplates()` **发生在我装钩子之前** ⇒ 永远等不到实例。
     * ⇒ 改成**再包一层原型**：`MockDataSource.prototype` 已经由 `INSTALL_TPL_HOOKS` 拿到并补过，
     *   这里只需按同样的办法再 import 一次那个模块（同一个 specifier ⇒ 同一个实例），
     *   在原方法外面套一层"打点 + 变慢"。不依赖实例，也就不受调用时机影响。
     */
    const probe = await cdp.eval(`(async () => {
      window.__order = []
      window.__origExitFs = document.exitFullscreen
      document.exitFullscreen = async function () { window.__order.push('exit') }
      try {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement })
      } catch (e) { return 'define-failed:' + ((e && e.message) || e) }
      try {
        const boot = await (await fetch('/src/lib/bootstrap.ts')).text()
        const at = boot.indexOf('/src/lib/mock-source.ts')
        if (at < 0) return 'no-specifier'
        const spec = boot.slice(at, boot.indexOf('"', at))
        const P = (await import(spec)).MockDataSource.prototype
        const slow = (name) => {
          const orig = P[name]
          if (typeof orig !== 'function') return
          P[name] = async function () {
            window.__order.push('save:start')
            await new Promise((r) => setTimeout(r, 700))
            const out = await orig.apply(this, arguments)
            window.__order.push('save:end')
            return out
          }
        }
        slow('createTemplateRow')
        slow('updateTemplateRow')
        return 'ok'
      } catch (e) { return 'wrap-failed:' + ((e && e.message) || e) }
    })()`)
    ok('前提：装上"落库变慢 + 假装处于真全屏"的观测装置', probe === 'ok', String(probe))

    // 新建一条（走骨架，与 [8d] 同一条路，但骨架换一个避免与种子重名）
    await cdp.eval(`__bp.clickText('button', '新建模板') || __bp.clickText('button', '新建模板（选骨架）')`)
    await sleep(900)
    const skelE = await cdp.eval(`(() => {
      const it = Array.from(document.querySelectorAll('.sk-item')).find((e) => (e.textContent || '').includes('领料单'))
      if (!it) return null
      const n = (it.querySelector('.sk-item-name')?.textContent || '').trim()
      it.click()
      return n
    })()`)
    await sleep(300)
    await cdp.eval(`__bp.clickText('button', '创建并编辑')`)
    await waitFor(cdp, `__bp.byText('button','完成').length > 0`, 15000, '编辑器打开')
    await cdp.eval(`__bp.clickText('button', '完成')`)

    // 落库被拖到 700ms ⇒ 现在取样一定落在"保存中"窗口里
    await sleep(250)
    const during = await cdp.eval(`(() => {
      const labels = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
      return {
        full: __bp.count('.bp-fs') > 0,
        inline: __bp.count('.bp-fs--inline') > 0,
        savingBtn: labels.includes('保存中…'),
        doneBtn: labels.includes('完成'),
      };
    })()`)
    ok(
      '⑤j【承重】落库期间浮层仍是"盖满视口"档（**没有**先缩回内联小画布）',
      during?.full === true && during?.inline === false,
      JSON.stringify(during),
    )
    ok(
      '⑤j【承重】落库期间「完成」变成「保存中…」（不变成的话用户以为没反应，再点一次会**建出两条**）',
      during?.savingBtn === true && during?.doneBtn === false,
      JSON.stringify(during),
    )

    await waitFor(cdp, `__bp.count('.wiz-tpl') > 0`, 15000, '回到模板列表')
    await sleep(900)
    const order = await cdp.eval(`window.__order || []`)
    ok(
      '⑤j【承重】退全屏发生在**落库结束之后**（顺序反了 = "先缩回小画布再跳转"那个观感；`void` 把 promise 抹掉就会反）',
      (order ?? []).join('>') === 'save:start>save:end>exit',
      `实际顺序=${JSON.stringify(order)}`,
    )

    const afterTplsE = await cdp.eval(READ_TPL)
    const afterNamesE = (afterTplsE ?? []).map((t) => t.name)
    const addedE = afterNamesE.filter((n) => !seedNamesE.includes(n))
    const selectedAfter = await cdp.eval(READ_SELECTED)
    const overlayGoneE = await cdp.eval(`__bp.count('.bp-fs')`)
    ok('⑤j 完成后浮层消失了（真的回到列表，不是卡在画布里）', overlayGoneE === 0, `残留浮层=${overlayGoneE}`)
    ok('前提：确实新增了一条（否则下面那条没有判据）', addedE.length === 1, `新增=${JSON.stringify(addedE)}；列表=${JSON.stringify(afterNamesE)}`)
    ok(
      '⑤j【承重】回到列表后**默认选中的就是刚新建的那条**（原来是"沿用旧选中" ⇒ 选中还停在上一个模板上）',
      selectedAfter === addedE[0] && selectedAfter !== selectedBefore,
      `选中=${JSON.stringify(selectedAfter)}；新增=${JSON.stringify(addedE)}；保存前选中=${JSON.stringify(selectedBefore)}；骨架=${JSON.stringify(skelE)}`,
    )

    // 拆掉打桩：后面的段落不该活在一个"假装全屏"的世界里（未拆的话也会影响 [9] 的 console 检查）
    await cdp.eval(`(() => {
      try {
        document.exitFullscreen = window.__origExitFs
        delete document.fullscreenElement
      } catch (e) { /* 拆不掉也不影响后续断言 */ }
      return true
    })()`)

    /**
     * ---- [8f] 记录模板也要能选「每页条数」（2026-09-21 用户要求恢复）----
     *
     * 用户原话："我之前如果选择了多条数据、再选择记录模板打印的话，在预览界面
     * **可以选择一页打印多少条数据**，现在怎么只有连续模式和默认模式了。"
     *
     * 查证结果：这条路**两处同时堵着**，只改一处都是白改 ——
     *   · UI：`StepPreview` 的条件是 `w.kind === 'view' && !isContinuousLoopTable(w)`，
     *     记录模板一律不渲染「每 N 条」；
     *   · 引擎：向导交给 `renderDocument` 的是 `kind === 'view' ? perPageN : null`，
     *     记录模板的 perPageN **被无条件丢掉**（就算 UI 给了控件也不会生效）。
     * ⇒ 现在两处同口径：记录模板**只在连续模式下**给控件、也只在连续模式下把它传给引擎。
     *
     * ── ⚠️ 为什么这一段必须**先用骨架建一份有内容的模板**（这是本次最费时的坑）──
     * `?tpl=N` 的种子是用 `skeletonsFor(kind)[0]` 建的，而那正好是 **`blank-record` / `blank-view`**：
     * 三个版式区**各 0 个元素**（已用探针核对过）。而 `render/layout.ts` 的 `breakPage()` 里有
     * `if (!hasContent && pages.length > 0) return` —— **空模板永远 hasContent=false**
     * ⇒ 无论怎么切排版方式、怎么设 perPageN，**都只有 1 页**。
     * 我第一版断言就是拿种子测的，读出"自动 1 页 → 每 5 条 1 页"，差点当成"引擎没生效"去改源码。
     * ⇒ 教训：**要观察分页，必须先造出"有内容"的模板**；空模板的页数恒为 1，是个天然的无信号区。
     *
     * ── 实测数字（通用单据骨架 + mock 60 条记录，A4）──
     *   默认模式        = 60 页（每条一页）
     *   连续 + 自动      = 96 页（按内容高度装页）
     *   连续 + 每 5 条   = 96 页（本模板每条内容 ≈ 一页高，装不下 5 条 ⇒ **高度先断页**，正常）
     *   连续 + 每 1 条   = 60 页 ← **只有这个能判定 perPageN 生效**
     * 所以判据用「每 1 条」：它的语义就是"一页一条"，**页数必须等于记录条数**。
     * 引擎那一处一旦退回 `perPageN: null`，这里会读到 96 ≠ 60 ⇒ 红（差 36 页，信号很硬）。
     */
    console.log('\n[8f] 记录模板 + 连续模式要能选「每页条数」')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tpl=2` })
    await sleep(2600)
    await cdp.eval(HELPERS)
    await cdp.eval(`__bp.clickText('button', '下一步：选模板')`)
    await sleep(900)

    // ⛔ 顺带守「选模板页的轻提醒」（用户要求：数据量只说在这一页）
    const tplNotes = await cdp.eval(`(() => Array.from(document.querySelectorAll('.wiz-note')).map((n) => ({
      text: (n.textContent || '').trim(),
      buttons: n.querySelectorAll('button').length,
    })))()`)
    const bulkNote = (tplNotes ?? []).find((n) => /页纸/.test(n.text))
    ok(
      '⑤k【承重】选模板页给出**轻提醒**（选中记录模板 + 60 条 ⇒ 告知会打出约 60 页纸、建议视图模板）',
      !!bulkNote && /视图模板/.test(bulkNote.text),
      `所有提示=${JSON.stringify(tplNotes)}`,
    )
    ok(
      '⑤k 轻提醒**不带按钮**（它是告知不是命令；要换模板，下面那排卡片就是入口）',
      bulkNote?.buttons === 0,
      `按钮数=${bulkNote?.buttons}`,
    )

    // 用**有内容**的骨架建一份记录模板（空白骨架没有可观察的分页信号，见上面的长注释）
    await cdp.eval(`__bp.clickText('button', '新建模板') || __bp.clickText('button', '新建模板（选骨架）')`)
    await sleep(900)
    const skelRich = await cdp.eval(`(() => {
      const it = Array.from(document.querySelectorAll('.sk-item')).find((e) => (e.textContent || '').includes('通用单据'))
      if (!it) return null
      it.click()
      return (it.querySelector('.sk-item-name')?.textContent || '').trim()
    })()`)
    await sleep(300)
    await cdp.eval(`__bp.clickText('button', '创建并编辑')`)
    await waitFor(cdp, `__bp.byText('button','完成').length > 0`, 15000, '编辑器打开')
    await cdp.eval(`__bp.clickText('button', '完成')`)
    await waitFor(cdp, `__bp.count('.wiz-tpl') > 0`, 15000, '回到模板列表')
    await sleep(900)
    ok('⑤k 前提：用「通用单据」骨架建出了一份**有内容**的模板', !!skelRich, `骨架=${skelRich}`)
    const pickedRich = await cdp.eval(`(() => {
      const c = document.querySelector('.wiz-tpl.on');
      return { name: c ? (c.querySelector('.wiz-tpl-name')?.textContent || '').trim() : null,
               kind: c ? ((c.className.match(/is-(record|view)/) || [])[1] || null) : null };
    })()`)
    ok(
      '⑤k 前提：保存后选中的就是刚建的那份记录模板（顺带守 [8e] 的选中修复）',
      pickedRich?.kind === 'record' && pickedRich?.name === skelRich,
      JSON.stringify(pickedRich),
    )

    /**
     * ⚠️ 这条前提是**踩过坑才加的**：`WizardFooter` 在子面板（选骨架 / Word 导入）展开时
     * **整块 `return null`** —— 于是"下一步：预览"这个按钮**根本不在 DOM 里**，
     * `clickText` 静默失败、页面还停在选模板页，而后面几条断言在**选模板页**上照样能读到
     * `.seg` / 没有"每 1 条" / 没有自定义框 ⇒ **全绿**（我第一次跑就是这种假绿）。
     * ⇒ 凡是要点"底部主按钮"的地方，都得先确认底部栏真的在。
     */
    const beforePreview = await cdp.eval(`(() => ({
      skItems: document.querySelectorAll('.sk-item').length,
      hasNextToPreview: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '下一步：预览'),
    }))()`)
    ok(
      '⑤k 前提：骨架面板已收起、底部「下一步：预览」在 DOM 里（否则点不动，后面全是假绿）',
      beforePreview?.skItems === 0 && beforePreview?.hasNextToPreview === true,
      JSON.stringify(beforePreview),
    )

    await cdp.eval(`__bp.clickText('button', '下一步：预览')`)
    await waitFor(cdp, `__bp.count('.wiz-sum-title') > 0`, 25000, '预览摘要出现')
    await sleep(1200)
    // 诊断：摘要没出现时，渲染到底卡在哪一步（这条只打印，不判红）
    const renderDiag = await cdp.eval(`(async () => {
      const ifr = document.querySelector('.wiz-prev-frame');
      /**
       * ⚠️ 关键的因果验证：pipeline.ts 的 yieldToHost() 用的是 requestAnimationFrame，
       * 而**隐藏页面里 rAF 不触发** ⇒ 分批让出的循环会**永久停住**（症状：卡在"正在排版 18/420"）。
       * 这条探针同时报 visibilityState 和"rAF 到底会不会触发"，把猜测变成读数。
       * （⚠️ 本段在 cdp.eval 的模板字符串里，注释里一个反引号都不能有 —— 已踩过三次。）
       */
      const raf = await new Promise((r) => {
        let fired = false;
        try { requestAnimationFrame(() => { fired = true; r('fired') }) } catch (e) { r('threw:' + e.message); return }
        setTimeout(() => { if (!fired) r('NOT-fired-within-1200ms') }, 1200);
      });
      return {
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        raf,
        progress: document.querySelectorAll('.wiz-progress').length,
        progressText: document.querySelector('.wiz-progress-text')?.textContent ?? null,
        hasFrame: !!ifr,
        alerts: Array.from(document.querySelectorAll('.wiz-alert')).map((n) => (n.textContent || '').trim().slice(0, 60)),
      };
    })()`)
    console.log(`  （⑤k 渲染诊断：${JSON.stringify(renderDiag)}）`)

    /** 一次读数：页数 + 摘要里的记录条数 + 排版控件行 */
    const READ_PREV = `(() => {
      const t = document.body.textContent || '';
      const pg = t.match(/共\\s*(\\d+)\\s*页/);
      const rc = t.match(/(\\d+)\\s*条记录/);
      return {
        pages: pg ? Number(pg[1]) : null,
        records: rc ? Number(rc[1]) : null,
        segRows: Array.from(document.querySelectorAll('.seg')).map((s) => Array.from(s.querySelectorAll('button')).map((b) => (b.textContent || '').trim())),
        customInput: !!document.querySelector('.wiz-perpage-custom input'),
        hints: Array.from(document.querySelectorAll('.wiz-hint')).map((n) => (n.textContent || '').trim()),
      };
    })()`

    const dflt = await cdp.eval(READ_PREV)
    ok('⑤k 前提：预览里读到了记录条数与页数（否则后面都是空断言）', (dflt?.records ?? 0) > 1 && dflt?.pages !== null, JSON.stringify({ records: dflt?.records, pages: dflt?.pages }))
    ok(
      '⑤k 记录模板的**默认模式**下不摆「每 N 条」（每条都从新页开始，摆了也不会生效 ⇒ 不能改就不显示）',
      /**
       * ⚠️ 判据里**必须带上 `segRows` 非空**（2026-09-21 自查出来的一个假绿）：
       * 原来写成 `!(dflt?.segs ?? []).some(...)` —— 而我早先把字段读成了 `segs`（真实字段是 `segRows`），
       * 于是它恒等于 `!([]).some(...)` = **true**，不管页面上有没有控件都绿。
       * ⇒ 凡是 `!(xs ?? []).some(...)` 这种"否定式"判据，都要**先证明观测到过东西**，
       *   否则"读不到"与"确实没有"长得一模一样。
       */
      (dflt?.segRows ?? []).length > 0 &&
        !(dflt?.segRows ?? []).some((g) => g.some((t) => /每 1 条/.test(t))) &&
        dflt?.customInput === false,
      `各行=${JSON.stringify(dflt?.segRows)}；自定义框=${dflt?.customInput}`,
    )
    ok(
      '⑤k 默认模式**说清去哪改**（只说"没有"用户会以为功能被删了）',
      (dflt?.hints ?? []).some((t) => /连续模式/.test(t)),
      JSON.stringify(dflt?.hints),
    )
    ok(
      '⑤k 默认模式 = 每条一页（页数 == 记录条数；这也是"有内容"的自证 —— 空模板恒为 1 页）',
      dflt?.pages === dflt?.records,
      `${dflt?.pages} 页 / ${dflt?.records} 条`,
    )

    // 切到连续模式 ⇒ 「每 N 条」应当出现
    await cdp.eval(`__bp.clickText('button', '连续模式')`)
    await sleep(2000)
    const cont = await cdp.eval(READ_PREV)
    const perPageRow = (cont?.segRows ?? []).find((g) => g.some((t) => /每 1 条/.test(t)))
    ok(
      '⑤k【承重】记录模板 + **连续模式**下出现「每 N 条」档位（这就是用户要找的那个控件）',
      !!perPageRow && perPageRow.some((t) => /自动/.test(t)) && perPageRow.some((t) => /每 5 条/.test(t)),
      `各行=${JSON.stringify(cont?.segRows)}`,
    )
    ok('⑤k 连续模式下自定义「每 [__] 条」输入框也在', cont?.customInput === true, `输入框=${cont?.customInput}`)
    ok(
      '⑤k 连续 + 自动 = 按内容高度装页（≠ 每条一页 ⇒ 与下面那条形成对照）',
      cont?.pages !== null && cont.pages !== cont.records,
      `自动 ${cont?.pages} 页 / ${cont?.records} 条`,
    )

    // 选「每 1 条」⇒ 一页一条 ⇒ 页数必须回到记录条数（这条才证明引擎那一处也改对了）
    await cdp.eval(`__bp.clickText('button', '每 1 条')`)
    await sleep(2000)
    const oneEach = await cdp.eval(`(() => {
      const row = Array.from(document.querySelectorAll('.seg')).find((s) => /每 1 条/.test(s.textContent || ''));
      const on = row ? (row.querySelector('.seg-item.active')?.textContent || '').trim() : null;
      const t = document.body.textContent || '';
      const pg = t.match(/共\\s*(\\d+)\\s*页/);
      const rc = t.match(/(\\d+)\\s*条记录/);
      return { on, pages: pg ? Number(pg[1]) : null, records: rc ? Number(rc[1]) : null };
    })()`)
    ok('⑤k 点「每 1 条」后档位真的选中了', oneEach?.on === '每 1 条', `选中=${oneEach?.on}`)
    ok(
      '⑤k【承重】「每 1 条」= 一页一条：页数**必须等于记录条数**（引擎侧一旦退回 `perPageN: null`，这里会变成 96 ≠ 60）',
      oneEach?.pages !== null && oneEach.pages === oneEach.records,
      `每 1 条 ${oneEach?.pages} 页 / ${oneEach?.records} 条（对照：连续+自动 ${cont?.pages} 页）`,
    )

    console.log('\n[9] 运行期错误检查')
    const realErrors = consoleErrors.filter((m) => !/favicon|Download the React DevTools/i.test(m))
    const realExceptions = exceptions.filter((m) => !/favicon/i.test(m))
    ok('无 console 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
    ok('无未捕获异常', realExceptions.length === 0, realExceptions.slice(0, 3).join(' | '))

    console.log('\n' + '='.repeat(56))
    if (skips.length) {
      // 跳过的必须**印出来**：不印的话，"绿"就变成了一种让人安心的假象
      console.log(`SKIP ${skips.length} 项（本环境到不了，已在别处覆盖）：`)
      for (const s of skips) console.log(`   · ${s}`)
      console.log('')
    }
    if (failures.length === 0) {
      console.log(`✅ 端到端冒烟全部通过：${pass} 项${skips.length ? `（另有 ${skips.length} 项跳过）` : ''}`)
    } else {
      console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
      for (const f of failures) console.log(`   · ${f}`)
      if (realErrors.length) {
        console.log('\nconsole 错误明细：')
        for (const e of realErrors.slice(0, 10)) console.log(`   · ${e}`)
      }
      if (realExceptions.length) {
        console.log('\n异常明细：')
        for (const e of realExceptions.slice(0, 5)) console.log(`   · ${String(e).split('\n')[0]}`)
      }
    }
    console.log('='.repeat(56))

    /**
     * ⚠️ ASCII 结论行：上面那行中文摘要会被 **OEM 码页吞掉紧邻 `：` 的一个字符**
     * （`：48 项` 曾被读成 `?8 项` → 报成 38）。这一行不含中文，**任何控制台编码下都一样**，
     * 读的人不必"记得先把控制台设成 UTF-8"。
     */
    console.log(`PASS_COUNT=${pass} SKIP_COUNT=${skips.length} FAIL_COUNT=${failures.length}`)

    process.exitCode = failures.length === 0 ? 0 : 1
  } finally {
    // 不要 await Browser.close：浏览器一关，这个请求的响应就永远不会回来，
    // await 会一直挂到超时，把后面的断言与总结一起拖住（实测踩过）。
    try {
      if (cdp) void cdp.send('Browser.close').catch(() => {})
    } catch {
      /* 忽略 */
    }
    await sleep(300)
    child.kill()
    await sleep(500)
    cleanupProfile()
  }

  // 结论已在 try 内打印完毕，这里只需带着退出码收工
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('端到端脚本崩溃：', e)
  process.exit(1)
})
