/**
 * 专项验证：「打印范围 → 手动勾选」这一块。
 *
 * 为什么要单独写：用户在第 ① 步报了三个问题，每一个都只有真实浏览器 + 真实函数才能证伪：
 *   1) 勾选列表显示的是"字段表第 2 个字段"的内容 —— 飞书表里附件/自动编号常排在最前，
 *      于是列表变成一串 `ID_xxx.jpg`；
 *   2) 想按条数打，只能点「全选前 50」，没法输入行数；
 *   3) 只能读"光标所在的那一条"，读不到用户在多维表格里勾选的那些行。
 *
 * 断言分四组：
 *   [A] 字段选择：直接调**真实**的 pickLabelFields()，喂"用户真实表形状"的固定装置（fixture）
 *   [B] 列表渲染：mock 模式下真实 DOM（顺带守住 e2e-smoke 依赖的三个选择器）
 *   [C] 行数输入：输入 N → 勾选 N 条；超上限要"明说"而不是静默截断
 *   [D] 读取选中行：可用 / 空 / 取消 / 抛错 / 超时 / 不支持 六条路径，外加"提示不能静默"
 *
 * ⚠️ 第三批优化改了 [A] 的口径（2026-09）：用户原话是「改为行高+当前视图表的前面两个字段内容，
 *    现在我都不知道显示的具体是什么内容」。⇒ 行标签**固定 = 当前视图前两列**，
 *    不再按"信息量"挑字段、不再跳过空列、不再躲开附件/自动编号。
 *    所以 A 组从"该被过滤的字段别进来"改成了"**列序说了算**"：前两列是什么就显示什么，
 *    附件出现与否只取决于它排在第几列（A9 是这条的反向对照）。
 *    上面第 1) 条记的是**旧缺陷**（旧实现按字段表下标取，与用户视图列序无关），保留作历史。
 *
 * 用法：node test/range-picker.mjs [baseUrl]
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE = process.env.BP_BASE ?? process.argv[2] ?? 'http://localhost:5190'
/**
 * 调试端口**不能写死**。
 *
 * 踩过的坑：脚本崩溃时（例如断言超时抛错）Edge 的浏览器进程会变成孤儿、继续占着这个端口；
 * 下一次运行 `--remote-debugging-port` 绑不上，`/json/list` 却仍然有响应 ——
 * 于是新脚本连上的是**上一个僵尸**，然后在随机的地方 `Runtime.evaluate` 卡 25 秒超时。
 * 症状极具误导性：失败点每次都不一样（一会儿 [A] 之前，一会儿 C5，一会儿 D31 之后），
 * 让人以为是刚改的代码有问题。
 *
 * 所以：每次运行挑一个**确认空闲**的随机端口，连上后再核对目标页确实是刚起的那个 about:blank。
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

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

// profile 建在系统临时目录：项目根不再被 `.range-profile-*` 污染
const profileDir = join(tmpdir(), `bp-range-${Date.now().toString(36)}`)
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
    this.consoleErrors = []
    this.exceptions = []
    this.navigations = []
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
        return
      }
      const h = this.handlers.get(m.method)
      if (h) h(m.params)
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
        this.navigations.push(m.params.frame.url)
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        this.exceptions.push(d.exception?.description ?? d.text ?? 'unknown')
      }
    })
  }
  on(method, fn) {
    this.handlers.set(method, fn)
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

// ============================================================
// 页面内辅助
// ============================================================

const HELPERS = `
window.__bp = {
  byExact(sel, t) { return Array.from(document.querySelectorAll(sel)).filter(e => (e.textContent||'').trim() === t); },
  byText(sel, t) { return Array.from(document.querySelectorAll(sel)).filter(e => (e.textContent||'').includes(t)); },
  click(sel, t) { const e = this.byExact(sel,t)[0] || this.byText(sel,t)[0]; if (!e) return false; e.click(); return true; },
  count(sel) { return document.querySelectorAll(sel).length; },
  text() { return document.body.innerText || ''; },
  rowTexts() { return Array.from(document.querySelectorAll('.wiz-pick-row')).map(r => (r.querySelector('.wiz-pick-text')||{}).innerText || ''); },
};
/** React 受控输入：必须走原生 setter + input 事件，直接改 .value 不会触发 onChange */
window.__bpSetInput = function (sel, val) {
  const el = document.querySelector(sel);
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
true`

/** 页面里加载真实模块（Vite dev 会即时编译 .ts） */
async function loadModule(cdp, path) {
  return cdp.eval(`(async () => { const m = await import(${JSON.stringify(path)}); return Object.keys(m); })()`)
}

/**
 * JSON dump 被渲染进列表时有两种可观测形态，**缺一不可**：
 *   ① 对象 / 数组 → `[{"type":"text",...}]`、`{"id":"..."}`：带 `{` 或 `[`
 *   ② 字符串     → `"薇诺娜舒敏保湿特护霜 50g"`：**被一对引号包着，既没有 `{` 也没有 `[`**
 *
 * 原来只判了 ①。而 mock 表里能做标签的字段恰好都是字符串（单据编号=数字、产品名称=文本），
 * 于是它在**真实 DOM 这条路径上从来没生效过** —— 这是反向验证实测出来的：
 * 在浏览器里把 `renderCellValue` 的兜底换回 `JSON.stringify` 之后，
 * 列表里明明已经出现 `"薇诺娜…50g"`，而原来的 B5 依然是绿的。
 *
 * 抽成导出函数是为了让反向验证脚本调**同一份**判定，避免"测试一套、验证脚本另一套"地漂移。
 */
export function looksJsonDumped(rowTexts) {
  const blob = (rowTexts ?? []).join('\n')
  const hasJsonShape = blob.includes('{"') || /[{[]\s*"/.test(blob)
  const quoted = (rowTexts ?? []).flatMap((t) =>
    String(t)
      .split('\n')
      .map((c) => c.trim())
      .filter((c) => c.length >= 2 && c.startsWith('"') && c.endsWith('"')),
  )
  return { hasJsonShape, quoted, dumped: hasJsonShape || quoted.length > 0 }
}

/**
 * Vite 的 HMR 抖动：刚改完源码就跑测试时，文件监听可能晚一拍才推给浏览器，
 * 客户端会**整页刷新**一次，`window.__bp` 随之消失。
 *
 * 这不是被测代码的问题，但会让脚本随机崩在半路。所以：
 *   · `bp()` 在遇到"没定义 / 上下文被销毁"时重注入辅助函数并重试一次；
 *   · 开跑前先确认页面稳定（连续两次探活），把抖动等过去；
 *   · 整页刷新次数会被 E3 断言记下来 —— 真刷新过就不算"静默通过"。
 */
function attachBp(cdp) {
  cdp.bp = async (expr) => {
    let last = null
    for (let i = 0; i < 5; i++) {
      try {
        return await cdp.eval(expr)
      } catch (e) {
        last = e
        const m = String(e?.message ?? e)
        if (!/is not defined|context was destroyed|Execution context|Cannot find context/i.test(m)) throw e
        await sleep(1500 + i * 1200)
        try {
          await cdp.eval(HELPERS)
        } catch {
          /* 还在刷新，下一轮再试 */
        }
      }
    }
    throw last
  }
  return cdp
}

/** 等 HMR 抖动过去：连续两次探活都还在，才算稳 */
async function waitStable(cdp) {
  for (let i = 0; i < 8; i++) {
    await sleep(700)
    try {
      if (!(await cdp.eval(`!!window.__bp && __bp.count('.app-tabs') > 0`))) continue
      await sleep(700)
      if (await cdp.eval(`!!window.__bp && __bp.count('.app-tabs') > 0`)) return true
    } catch {
      /* 正在刷新 */
    }
    try {
      await cdp.eval(HELPERS)
    } catch {
      /* 忽略 */
    }
  }
  return false
}

/** 保证当前停在「手动勾选」并且勾选列表已经渲染出来（整页刷新后需要重新点一次） */
async function ensurePicker(cdp) {
  await cdp.bp(`window.__bp = window.__bp || undefined`)
  const has = await cdp.bp(`__bp.count('.wiz-num') > 0 && __bp.count('.wiz-pick-row') > 0`)
  if (has) return true
  await cdp.bp(`__bp.click('button','手动勾选')`)
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    if (await cdp.bp(`__bp.count('.wiz-pick-row') > 0`)) return true
  }
  return false
}

// ============================================================
// [A] 字段选择：真实函数 + 用户真实表形状的 fixture
//
// 口径（用户原话）：「改为行高+当前视图表的前面两个字段内容，现在我都不知道
// 显示的具体是什么内容」⇒ 行标签**固定 = 当前视图的前两列**，不再按"信息量"挑、
// 不再跳过空列、不再躲开附件/自动编号/时间。
// 所以 A 组现在量的是：**列序说了算**（前两列是什么就显示什么），
// 以及"附件出现与否只取决于它排在第几列"这条反向对照。
// ============================================================

const SECTION_A = `(async () => {
  const LF = await import('/src/components/wizard/label-fields.ts');
  const FT = await import('/src/lib/field-types.ts');
  const pick = LF.pickLabelFields;

  // 用户真实表的形状：附件、自动编号、创建时间排在最前面
  const ATTACH = { id: 'f_attach', name: '附件', type: 17 };
  const AUTONO = { id: 'f_no', name: '自动编号', type: 1005, isPrimary: true };
  const CREATED = { id: 'f_created', name: '创建时间', type: 1001 };
  const PHOTO = { id: 'f_photo', name: '照片', type: 17 };
  const NAME = { id: 'f_name', name: '产品名称', type: 1 };
  const QTY = { id: 'f_qty', name: '数量', type: 2 };
  const EMPTY_FORMULA = { id: 'f_calc', name: '空公式', type: 20 };
  // 富文本字段：SDK 给的是对象数组，渲染层没翻译时会被 dump 成 [{"type":"text","text":"张三"}]
  const RICH = { id: 'f_rich', name: '备注', type: 1 };
  // 主字段是文本的"正常表"
  const NAME_PRIMARY = { id: 'f_title', name: '名称', type: 1, isPrimary: true };

  const rec = (over) => ({ recordId: 'r1', fields: Object.assign({
    f_attach: [{ name: 'ID_F65A6BA691A2487AA6629ED969CB2D6D.jpg' }],
    f_no: 26,
    f_created: Date.UTC(2026, 0, 5, 9, 0, 0),
    f_photo: [{ name: 'photo_1_1.png' }],
    f_name: '张三',
    f_qty: 5,
    f_calc: '',
    f_rich: [{ type: 'text', text: '张三' }],
    f_title: '张三',
  }, over || {}) });

  // 视图列序就是唯一口径：下面每张表的第一、二个元素 = 界面上的头两列
  const F1 = [ATTACH, AUTONO, CREATED, PHOTO, NAME, QTY];
  const F2 = [AUTONO, CREATED, NAME, QTY];
  const F4 = [NAME_PRIMARY, EMPTY_FORMULA, NAME];
  const F5 = [NAME_PRIMARY, RICH];
  const F6 = [NAME_PRIMARY, NAME, ATTACH];
  const F7 = [NAME_PRIMARY];

  const sel1 = pick(F1);
  const sel2 = pick(F2);
  const sel4 = pick(F4);
  const sel5 = pick(F5);
  const sel6 = pick(F6);
  const sel7 = pick(F7);
  const selOk = pick([NAME_PRIMARY, NAME, QTY]);

  const render = (fields) => fields.map(f => FT.renderCellValue(rec().fields[f.id], f.type).trim()).filter(Boolean).join(' | ');

  return {
    slotCount: LF.LABEL_SLOT_COUNT,
    sel1: sel1.map(f => ({ name: f.name, type: f.type })),
    sel2: sel2.map(f => ({ name: f.name, type: f.type })),
    sel4: sel4.map(f => ({ name: f.name, type: f.type })),
    sel5: sel5.map(f => ({ name: f.name, type: f.type })),
    sel6: sel6.map(f => ({ name: f.name, type: f.type })),
    sel7: sel7.map(f => ({ name: f.name, type: f.type })),
    selOk: selOk.map(f => ({ name: f.name, type: f.type })),
    sel1Text: render(sel1),
    sel5Text: render(sel5),
  };
})()`

// ============================================================
// [D] 读取选中行：六条路径
// ============================================================

const SECTION_D = `(async () => {
  const RS = await import('/src/components/wizard/record-selection.ts');
  const out = {};

  // ① 可用：官方选择器返回两个 id
  out.pickerOk = await RS.readByOfficialPicker(
    { selectRecordIdList: async () => ['rec_1', 'rec_2'] }, 'tbl', 'viw', { timeoutMs: 1000 });

  // ② 取消：返回 null
  out.pickerCancel = await RS.readByOfficialPicker(
    { selectRecordIdList: async () => null }, 'tbl', 'viw', { timeoutMs: 1000 });

  // ③ 选了空：返回 []
  out.pickerEmpty = await RS.readByOfficialPicker(
    { selectRecordIdList: async () => [] }, 'tbl', 'viw', { timeoutMs: 1000 });

  // ④ 抛错
  out.pickerThrow = await RS.readByOfficialPicker(
    { selectRecordIdList: async () => { throw new Error('host exploded') } }, 'tbl', 'viw', { timeoutMs: 1000 });

  // ⑤ 一直不回应（宿主没注册接口时的真实表现）
  out.pickerHang = await RS.readByOfficialPicker(
    { selectRecordIdList: () => new Promise(() => {}) }, 'tbl', 'viw', { timeoutMs: 250 });

  // ⑥ 没有这个接口
  out.pickerNa = await RS.readByOfficialPicker({}, 'tbl', 'viw', { timeoutMs: 1000 });

  // 表格视图路径
  const mkTable = (fn) => ({ getViewList: async () => [{ id: 'viw', getSelectedRecordIdList: fn }] });
  out.gridOk = await RS.readGridSelected(mkTable(async () => ['rec_9']), 'viw', { timeoutMs: 1000 });
  out.gridEmpty = await RS.readGridSelected(mkTable(async () => []), 'viw', { timeoutMs: 1000 });
  out.gridCancel = await RS.readGridSelected(mkTable(async () => null), 'viw', { timeoutMs: 1000 });
  out.gridHang = await RS.readGridSelected(mkTable(() => new Promise(() => {})), 'viw', { timeoutMs: 250 });
  out.gridNa = await RS.readGridSelected({ getViewList: async () => [{ id: 'viw' }] }, 'viw', { timeoutMs: 1000 });
  out.gridNoTable = await RS.readGridSelected(null, 'viw', { timeoutMs: 1000 });

  // 晚到的结果必须还能收到（用户在官方选择器里多挑了一会儿）
  let lateGot = null;
  const late = new Promise((res) => setTimeout(() => res(['rec_late']), 400));
  await RS.readByOfficialPicker({ selectRecordIdList: () => late }, 'tbl', 'viw',
    { timeoutMs: 120, onLate: (o) => { lateGot = o; } });
  await new Promise((r) => setTimeout(r, 700));
  out.late = lateGot;

  // 提示语：任何一条失败/取消路径都不能静默
  out.hints = {
    cancel: RS.outcomeHint(out.pickerCancel),
    empty: RS.outcomeHint(out.pickerEmpty),
    timeout: RS.outcomeHint(out.pickerHang),
    error: RS.outcomeHint(out.pickerThrow),
    unsupported: RS.outcomeHint(out.pickerNa),
    ok: RS.outcomeHint(out.pickerOk),
  };
  out.notes = {
    unknown: RS.capabilityNote('unknown'),
    grid: RS.capabilityNote('grid'),
    picker: RS.capabilityNote('picker'),
    none: RS.capabilityNote('none'),
  };

  // ---- 链级：① 探测不到时会不会**自动**走 ②，以及走没走越级 ----
  // 这一段是补的：原来只有各级自己的六种结果，**"① 不可用 → 自动降级到 ②"这条路径没有任何断言**，
  // 而真机上 ①（getSelectedRecordIdList 未从包出口导出）恰好就是走这条路的。

  // ① 可用：② 必须**一次都不被调用**（不许越级，也不许"两个都弹一遍"）
  let pickerCalled = 0;
  out.chainGrid = await RS.readSelectionChain(
    { getViewList: async () => [{ id: 'viw', getSelectedRecordIdList: async () => ['rec_g1'] }] },
    { selectRecordIdList: async () => { pickerCalled += 1; return ['rec_p1']; } },
    'tbl', 'viw', { timeoutMs: 1000 });
  out.chainGridPickerCalled = pickerCalled;

  // ① 探测不到（视图上没有那个方法）→ 必须自动走 ②，并且说清 ① 为什么没成
  out.chainFallback = await RS.readSelectionChain(
    { getViewList: async () => [{ id: 'viw' }] },
    { selectRecordIdList: async () => ['rec_p2'] },
    'tbl', 'viw', { timeoutMs: 1000 });
  out.chainFallbackLabel = RS.appliedLabel(out.chainFallback.level, out.chainFallback.skipped);

  // ① 连表格对象都没有（真机上 rawTable 不可用的情形）→ 同样必须自动走 ②
  out.chainNoTable = await RS.readSelectionChain(
    null,
    { selectRecordIdList: async () => ['rec_p3'] },
    'tbl', 'viw', { timeoutMs: 1000 });

  // 两级都不可用 → 两条原因都要说出来，别只报最后试的那一个
  out.chainNone = await RS.readSelectionChain(
    { getViewList: async () => [{ id: 'viw' }] }, {}, 'tbl', 'viw', { timeoutMs: 1000 });
  out.chainNoneText = RS.chainFailureText(out.chainNone);

  // ---- 等待期间的"进行中"反馈：每一级开始前都必须先说话 ----
  // 用户最恨的不是慢，是"点了没反应"。两级都不可用时最坏要等 timeout×2 秒，
  // 这段时间界面必须一直在说话，而且要能看出"在第几级"。
  const stages = [];
  out.stageFallback = await RS.readSelectionChain(
    { getViewList: async () => [{ id: 'viw' }] },
    { selectRecordIdList: async () => ['rec_p9'] },
    'tbl', 'viw', { timeoutMs: 1000, onStage: (s, t) => stages.push([s, t]) });
  out.stages = stages;

  const stages2 = [];
  out.stageGrid = await RS.readSelectionChain(
    { getViewList: async () => [{ id: 'viw', getSelectedRecordIdList: async () => ['rec_g9'] }] },
    { selectRecordIdList: async () => ['rec_p9'] },
    'tbl', 'viw', { timeoutMs: 1000, onStage: (s, t) => stages2.push([s, t]) });
  out.stages2 = stages2;

  out.stageText = { grid: RS.stageText('grid'), picker: RS.stageText('picker', '某个原因') };

  // ---- ① 和 ② 的截止时间必须**各自独立** ----
  // 曾经共用一个 PICK_TIMEOUT_MS：① 问"通道注册了吗"（探测），② 问"用户挑完了吗"（用户驱动）。
  // 职责不同却共用一个数，谁想调其中一个都会连带改掉另一个 —— 这是留给下一个人的陷阱。
  out.budgets = {
    grid: RS.GRID_PROBE_TIMEOUT_MS,
    picker: RS.PICKER_WINDOW_MS,
    // 超时文案也得按级分开：① 说"左表勾选的接口"，② 说"记录选择器"
    gridTimeoutHint: RS.outcomeHint({ status: 'timeout', source: 'grid', waitedMs: 0 }).text,
    pickerTimeoutHint: RS.outcomeHint({ status: 'timeout', source: 'picker', waitedMs: 0 }).text,
    // 显式 timeoutMs 必须仍然优先于两级各自的默认值（重构别把覆盖路径弄坏）
    gridOverride: await RS.readGridSelected(
      { getViewList: async () => [{ id: 'viw', getSelectedRecordIdList: () => new Promise(() => {}) }] },
      'viw', { timeoutMs: 200 }),
    pickerOverride: await RS.readByOfficialPicker(
      { selectRecordIdList: () => new Promise(() => {}) }, 'tbl', 'viw', { timeoutMs: 200 }),
  };

  return out;
})()`

// ============================================================

async function main() {
  if (!EDGE) {
    console.log('找不到 Edge / Chrome')
    process.exit(1)
  }
  try {
    const r = await fetch(BASE, { method: 'HEAD' })
    if (!r.ok) throw new Error(String(r.status))
  } catch (e) {
    console.log(`dev server 不可达（${BASE}）：${e.message}`)
    console.log('若看到 fetch failed，说明后台 dev server 挂了 —— 请联系 team-lead 重启，不要自己起。')
    process.exit(1)
  }

  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  mkdirSync('.shots', { recursive: true })

  const PORT = await pickFreePort()
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
      '--window-size=390,1000',
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
        // 只认"刚起的那张空白页"：万一端口上还蹲着别的浏览器，这里会找不到目标而不是连错人
        target = list.find((t) => t.type === 'page' && (t.url === 'about:blank' || t.url === ''))
        if (target?.webSocketDebuggerUrl) break
      } catch {
        /* 还没起来 */
      }
      await sleep(300)
    }
    if (!target) throw new Error(`连不上浏览器调试端口 ${PORT}（或找到的都不是刚起的空白页）`)

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    cdp = attachBp(new Cdp(ws))
    const bp = (expr) => cdp.bp(expr)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 1000, deviceScaleFactor: 2, mobile: false,
    })

    console.log('\n[0] 打开插件（mock 模式，侧边栏宽度 390px）')
    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tab=wizard` })
    await sleep(3200)
    await cdp.eval(HELPERS)
    await waitStable(cdp)

    // ------------------------------------------------------------
    console.log('\n[A] 字段选择：行标签 = 当前视图的前两列（列序说了算）')
    const a = await bp(SECTION_A)
    const names = (x) => (x ?? []).map((f) => f.name).join('+')

    ok('A0 槽位数就是 2（固定两槽，不随数据变）', a?.slotCount === 2, `LABEL_SLOT_COUNT=${a?.slotCount}`)
    ok(
      'A1 行标签 = 视图前两列（哪怕它们是附件 / 自动编号）',
      names(a?.sel1) === '附件+自动编号',
      `实际选了 ${names(a?.sel1)}`,
    )
    ok(
      'A2 视图第二列是创建时间也照样显示（不自作主张换成文本列）',
      (a?.sel2 ?? []).length === 2 && a.sel2[1].name === '创建时间',
      `实际选了 ${names(a?.sel2)}`,
    )
    ok(
      'A3 第一格永远是视图第 1 列（列序不被重排）',
      a?.sel1?.[0]?.name === '附件' && a?.selOk?.[0]?.name === '名称',
      `实际 ${names(a?.sel1)} ｜ ${names(a?.selOk)}`,
    )
    ok(
      'A4 字段少于两个时只显示能显示的（不补空、不报错）',
      (a?.sel7 ?? []).length === 1 && a.sel7[0].name === '名称',
      `实际选了 ${names(a?.sel7)}`,
    )
    ok(
      'A5 第二列是"空值多的公式字段"也照显示（不再按信息量跳过）',
      (a?.sel4 ?? []).length === 2 && a.sel4[1].name === '空公式',
      `实际选了 ${names(a?.sel4)}`,
    )
    // ⚠️ 这条原来是**反向**的（"列表文本不含附件文件名"）。口径换掉之后它必须反过来：
    // 附件是用户自己排在第一列的，藏起来才是缺陷（"我不知道显示的是什么内容"就是这么来的）。
    ok(
      'A6 视图前两列含附件时，文件名如实出现（不替用户藏列）',
      /\.(jpe?g|png|gif|bmp|webp|svg)/i.test(String(a?.sel1Text ?? '')),
      `实际文本 ${JSON.stringify(a?.sel1Text)}`,
    )
    // ⚠️ B5 已经补过"字符串被引号包着"那一形态，A7 原来漏了 ——
    // 于是它只认 `[{"…":…}]` 这种带 { / [ 的形态，认不出 `"薇诺娜…50g"`。
    // 变异实测：把取值层的字符串分支改成 JSON.stringify 之后，A7 **依然是绿的**。
    // 这里改成复用 B5 那份判定（looksJsonDumped），两边口径不再漂移。
    const a7 = looksJsonDumped(String(a?.sel5Text ?? '').split(' | '))
    ok(
      'A7 列表文本不含原始 JSON 片段（对象 dump + 字符串被引号包着）',
      !a7.dumped,
      `jsonShape=${a7.hasJsonShape} 引号包裹=${JSON.stringify(a7.quoted.slice(0, 2))}；实际文本 ${JSON.stringify(a?.sel5Text)}；选中 ${names(a?.sel5)}`,
    )
    // 反向对照：正常的"主字段 + 文本字段"表不能被误伤
    ok(
      'A8【反向对照】正常表（名称 + 产品名称 + 数量）仍取到两个字段、且第二个是文本',
      (a?.selOk ?? []).length === 2 && a.selOk[1].name === '产品名称',
      `实际选了 ${names(a?.selOk)}`,
    )
    ok(
      'A9【反向对照】附件排到第三列就不出现（出现与否只取决于列序）',
      !(a?.sel6 ?? []).some((f) => f.type === 17) && names(a?.sel6) === '名称+产品名称',
      names(a?.sel6),
    )

    // ------------------------------------------------------------
    console.log('\n[B] 列表渲染（mock 真实 DOM）')
    await ensurePicker(cdp)
    await sleep(400)

    const b = await bp(`({
      hasPicker: __bp.count('.wiz-pick') > 0,
      rows: __bp.count('.wiz-pick-row'),
      hasLimitHint: document.body.innerText.includes('50'),
      rowTexts: __bp.rowTexts().slice(0, 8),
      placeholder: (document.querySelector('.wiz-search')||{}).placeholder || null,
      onCount: __bp.count('.wiz-pick-row.on'),
      rowSlots: Array.from(document.querySelectorAll('.wiz-pick-row')).slice(0, 8).map(r => ({
        no: !!r.querySelector('.wiz-pick-no'),
        main: !!r.querySelector('.wiz-pick-main'),
        sub: !!r.querySelector('.wiz-pick-sub'),
      })),
    })`)
    // 这三条与 e2e-smoke 第 [2] 段重合，属于"不许弄坏"的既有断言
    ok('B1 手动勾选打开插件内勾选列表', b?.hasPicker === true)
    ok('B2 勾选列表有记录行', (b?.rows ?? 0) > 0, `行数 ${b?.rows}`)
    ok('B3 提示了 50 条上限', b?.hasLimitHint === true)

    const rowBlob = (b?.rowTexts ?? []).join('\n')
    /**
     * ⚠️ ⑧ 口径互斥（team-lead 点名的那一对）：这条原来写死"列表里**不**出现附件文件名"，
     * 而 A6 写死"视图前两列含附件时文件名**必须**出现" —— 两条字面上互相否证。
     * 它们之所以同时绿，靠的是**运气**：A 组的合成 fixture 把附件放在第 1 列（该出现），
     * 真实 mock 把附件放在第 19 列（不该出现）。一旦有人把附件列挪到前两位，
     * 产品行为完全正确，这条却会红 —— 那是**假红**。
     *
     * 实测（`_r4-8-m1-oldb4.txt`；M1 = 只把 mock 的附件列挪到第 2 列，产品代码一字未改）：
     *   旧 B4 → `FAIL … — "3\nphoto_3_1.png photo_3_2.png"`（A6 仍 PASS，其余 7 条红的是
     *   "第 2 列 = 产品名称"这个前提，属于数据改动该有的连带）。
     *
     * 改判据 vs 再补一份带附件的 mock 数据（哪个便宜）：
     *   · mock 的字段顺序被 B7 / B8 / B10 / B11 / B15-B17 当基准用 —— M1 一次就压红了这 8 条，
     *     再加一份数据等于要同时动这 8 条的读数；而 A 组那份合成 fixture 已经把"在前两列"测过了。
     *   · 改判据只动这一行，并且把两条并成**同一条规则**：附件文件名出不出现，
     *     只取决于它是不是视图前两列。A6 是这条规则在"是"那一侧，B4 是"否"那一侧。
     * 于是它不再依赖"附件永不在同一列位置"这个隐含前提 —— 列序真被改了，它跟着改口径而不是假红；
     * 而"排在前面却把文件名藏起来"（用户明确不要的）会让它红（见 `_r4-8-m1m2-*`）。
     */
    const b4 = await bp(`(async () => {
      const MS = await import('/src/lib/mock-source.ts');
      const idx = MS.MOCK_FIELDS.findIndex(f => f.id === 'fld_photo');
      return { idx, first: (MS.MOCK_FIELDS[0]||{}).name, second: (MS.MOCK_FIELDS[1]||{}).name };
    })()`)
    const attachShown = /\.(jpe?g|png|gif|bmp|webp|svg)/i.test(rowBlob)
    const attachInFirstTwo = (b4?.idx ?? -1) >= 0 && b4.idx < 2
    ok(
      'B4【与 A6 同一条规则：附件文件名出现与否只取决于列序】mock 的附件列不在前两列 → 列表里不出现附件文件名',
      attachShown === attachInFirstTwo,
      `mock 附件列第 ${(b4?.idx ?? -1) + 1} 列（前两列 = ${b4?.first} / ${b4?.second}）；` +
        `期望出现=${attachInFirstTwo} 实际出现=${attachShown}；首行=${JSON.stringify(b?.rowTexts?.[0])}`,
    )

    const b5 = looksJsonDumped(b?.rowTexts)
    ok(
      'B5 列表里不出现原始 JSON 片段（对象 dump + 字符串被引号包着）',
      !b5.dumped,
      `jsonShape=${b5.hasJsonShape} 引号包裹的单元格=${JSON.stringify(b5.quoted.slice(0, 2))}`,
    )
    // ⚠️ 这条原来是**反向**的（"空的字段不会用「—」占位"）—— 那是旧口径（跳空列）。
    // 新口径是"列序固定、空值显式占位、列不许塌"，所以改成结构断言：
    // 每行都必须是「行号 + 主格 + 副格」三件套。把槽位砍成一个（LABEL_SLOT_COUNT=1）
    // 或者按空值过滤字段，这一条就会红。
    // ⚠️ 覆盖边界：「空值真的显示成 —」这半句在本机**造不出来** —— mock 的前两列
    // （单据编号 / 产品名称）60 条全非空，DOM 里永远不会出现 `—`。不假装测过，
    // 记在 report 的 advisory 里（要真机或一条空数据才能断言）。
    ok(
      'B6 每行都是固定两格 + 行号（列不会塌）',
      (b?.rowSlots ?? []).length > 0 && (b?.rowSlots ?? []).every((r) => r.no && r.main && r.sub),
      JSON.stringify((b?.rowSlots ?? []).slice(0, 2)),
    )

    const expectedPlaceholder = await bp(`(async () => {
      const LF = await import('/src/components/wizard/label-fields.ts');
      const MS = await import('/src/lib/mock-source.ts');
      const names = LF.pickLabelFields(MS.MOCK_FIELDS).map(f => f.name).join(' / ');
      return '搜索记录（按 ' + names + ' 匹配）';
    })()`)
    ok(
      'B7 搜索框的匹配范围与列表显示的字段一致（不会"看得到搜不到"）',
      b?.placeholder === expectedPlaceholder,
      `实际 ${JSON.stringify(b?.placeholder)} / 期望 ${JSON.stringify(expectedPlaceholder)}`,
    )

    // ⚠️ B8 原来是"第 1 行 = mock 第 1 条记录"。第 2 项要求（勾选的置顶）之后**这个前提没了**：
    // mock 会自动预选记录 3，置顶之后它才是第 1 行。硬写"第 1 行 = 记录 1"等于把
    // 两条需求（③ 列序 + ② 置顶）互相打架，谁改谁红。
    // 改成不依赖置顶的**内部一致性**口径：拿第 1 行的主格值去 mock 数据里反查那一条记录，
    // 再看副格是不是**那条记录**的第 2 列 —— 两格必须同属一条记录、且分属视图第 1 / 第 2 列。
    //
    // ⚠️ 隐含假设收口（team-lead 点名的那 8 条）：上一版把"视图第 2 列 = 产品名称"**写死在
    // `hit.fields.fld_title`** 里 —— 那测的是 **mock fixture 的列序**，不是产品行为。
    // 拿 M1（只把 mock 的附件列挪到第 2 列，产品一字未改）压它：B8 立刻假红
    // （`_r4-8-m1-oldb4.txt`：`wantTitle="薇诺娜…" subCell="photo_3_1.png photo_3_2.png"`）。
    // 现在期望**从 fixture 的实际列序推导**：列 = `pickLabelFields(MOCK_FIELDS)` 给的那两列，
    // 值 = 那条记录在该列上的值经 `renderCellValue` 读出的显示形态。
    // 为什么不借 `displayCellText` 当期望：那样期望与被测函数同源，③ 的牙就没了 ——
    // `return text` 那个变异会把 DOM 与期望一起改成空串，B8 反而变绿。
    // 借 `renderCellValue` 是**有意**的：它守的是"两格同属一条记录、分属第 1/2 列"这件事，
    // 显示形态本身由 B5 / B6 / B11 / B16 / B17 守。
    const firstRowCheck = await bp(`(async () => {
      const MS = await import('/src/lib/mock-source.ts');
      const LF = await import('/src/components/wizard/label-fields.ts');
      const FT = await import('/src/lib/field-types.ts');
      const recs = MS.buildMockRecords(60);
      const slots = LF.pickLabelFields(MS.MOCK_FIELDS);
      const s1 = slots[0], s2 = slots[1];
      // 显示形态由字段类型决定；空格子/换行的归一化见下面 norm()
      const disp = (rec, f) => FT.renderCellValue((rec.fields||{})[f.id], f.type).trim();
      // ⚠️ 附件字段的显示形态是用 \\n 连接多个文件名（field-types.ts:310），
      // 而 DOM 的 innerText 会把 \\n 折成空格（CSS 空白折叠）；两边都归一化再比，
      // 比的是"格子里是哪串字"，不是空白怎么排的。
      const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      const cell = (r, sel) => norm((r?.querySelector(sel)||{}).innerText || '');
      const rows = Array.from(document.querySelectorAll('.wiz-pick-row'));
      const row1 = rows[0];
      const mainCell = cell(row1, '.wiz-pick-main');
      const subCell = cell(row1, '.wiz-pick-sub');
      // 用主格值去 fixture 里反查那一条记录（**不写死列名**：第 1 列由 MOCK_FIELDS 决定）
      const hit = recs.find(r => norm(disp(r, s1)) === mainCell);
      const rowOf1 = rows.find(r => cell(r, '.wiz-pick-main') === norm(disp(recs[0], s1)));
      return {
        mainCell, subCell,
        s1Name: s1.name, s2Name: s2.name,
        wantSub: hit ? norm(disp(hit, s2)) : null,
        record1Sub: rowOf1 ? cell(rowOf1, '.wiz-pick-sub') : null,
        wantRecord1Sub: recs[0] ? norm(disp(recs[0], s2)) : null,
      };
    })()`)
    ok(
      'B8 第 1 行两格 = **同一条记录**的「视图第 1 列 / 第 2 列」（列名从 fixture 列序推导，不是写死的）',
      firstRowCheck?.wantSub != null && firstRowCheck.subCell === firstRowCheck.wantSub,
      JSON.stringify(firstRowCheck),
    )
    // 独立期望：**不以 DOM 为基准**，而是拿 fixture 里记录 1 的两列值自己算出来。
    // 按"主格 = 记录 1 的第 1 列"找到那一行再核对副格 —— 既不依赖置顶顺序，也不经过被测函数自算。
    // （旧版这里是字面量 `薇诺娜舒敏保湿特护霜 50g`，一挪列序就假红；期望来源已改成 fixture。）
    ok(
      'B8b【独立期望】记录 1 那一行的副格 = 记录 1 在视图第 2 列上的值（期望由 fixture 推导）',
      firstRowCheck?.wantRecord1Sub != null &&
        firstRowCheck.record1Sub === firstRowCheck.wantRecord1Sub,
      `记录 1 的副格 ${JSON.stringify(firstRowCheck?.record1Sub)} / 期望 ${JSON.stringify(firstRowCheck?.wantRecord1Sub)}（第 2 列 = ${firstRowCheck?.s2Name}）`,
    )
    ok('B9 切到手动勾选后自动预选了"光标那一行"（既有行为）', (b?.onCount ?? 0) >= 1, `已勾选 ${b?.onCount}`)

    // ⚠️ 隐含假设收口：这里原来写死 `'70g'` —— 它是"产品名称"那一列的值的片段，
    // 列序一变（M1）就搜不到，B10 假红。改成**从 fixture 里取**记录 1 第 2 列的值当关键词
    // （全文，不是片段：既保证命中数 > 0，也保证 < 60 —— 精确值只会命中少数几条）。
    const needleInfo = await bp(`(async () => {
      const MS = await import('/src/lib/mock-source.ts');
      const LF = await import('/src/components/wizard/label-fields.ts');
      const FT = await import('/src/lib/field-types.ts');
      const recs = MS.buildMockRecords(60);
      const s2 = LF.pickLabelFields(MS.MOCK_FIELDS)[1];
      return { needle: FT.renderCellValue(recs[0].fields[s2.id], s2.type).trim(), s2Name: s2.name };
    })()`)
    await bp(`__bpSetInput('.wiz-search', ${JSON.stringify(String(needleInfo?.needle ?? ''))})`)
    await sleep(500)
    const searched = await bp(`({ rows: __bp.count('.wiz-pick-row'), sample: __bp.rowTexts()[0] || '' })`)
    ok(
      'B10【反向对照】搜索仍能用第二个字段的关键词命中（关键词取自 fixture 的第 2 列）',
      (searched?.rows ?? 0) > 0 && (searched?.rows ?? 0) < 60,
      `关键词=${JSON.stringify(needleInfo?.needle)}（第 2 列 = ${needleInfo?.s2Name}）${JSON.stringify(searched)}`,
    )
    // ⚠️ 这条原来搜的是 `ID_F65A6BA691A2487AA6629ED969CB2D6D.jpg` —— 那个名字只存在于 A 组的
    // 固定装置里，**mock 数据里根本没有**。于是不管搜索范围是什么，命中数恒为 0；
    // 变异实测：把搜索范围扩到"记录里的所有字段"之后，这条断言**依然是绿的**，它从来没生效过。
    // 现在改成两层：① 前提先证明那个附件名真的在数据里（否则判据退化成"扫一个不存在的模式"）；
    // ② 判据按 **A6/B4 同一条规则**写 —— 附件文件名能不能被搜到，只取决于附件列在不在视图前两列。
    //    搜的是**去掉扩展名的词干**：扩展名在不在归 B4 守，这里只管"附件列进没进匹配范围"。
    const attachProbe = await bp(`(async () => {
      const MS = await import('/src/lib/mock-source.ts');
      const LF = await import('/src/components/wizard/label-fields.ts');
      const recs = MS.buildMockRecords(60);
      const att = MS.MOCK_FIELDS.find(f => f.type === 17);
      const slots = LF.pickLabelFields(MS.MOCK_FIELDS);
      const first = att ? (recs[0].fields[att.id] || [])[0] : null;
      const name = first ? String(first.name) : null;
      return {
        name,
        stem: name ? name.replace(/\\.[^.]+$/, '') : null,
        inFirstTwo: !!att && slots.some(f => f.id === att.id),
        present: name ? JSON.stringify(recs.map(r => r.fields)).includes(name) : false,
        attName: att ? att.name : null,
      };
    })()`)
    ok(
      'B11 前提：数据里确实存在附件文件名（否则下面的判据会退化成"扫一个不存在的模式"）',
      attachProbe?.present === true && typeof attachProbe?.name === 'string',
      `数据里有 ${attachProbe?.name} 吗：${attachProbe?.present}（附件列 = ${attachProbe?.attName}）`,
    )
    await bp(`__bpSetInput('.wiz-search', ${JSON.stringify(String(attachProbe?.stem ?? ''))})`)
    await sleep(500)
    const searched2 = await bp(`__bp.count('.wiz-pick-row')`)
    ok(
      'B11【反向对照】附件文件名能不能搜到，只取决于附件列是否在视图前两列（同 A6/B4 的规则）',
      ((searched2 ?? 0) > 0) === (attachProbe?.inFirstTwo === true),
      `命中 ${searched2} 行；搜的是 ${JSON.stringify(attachProbe?.stem)}；` +
        `附件列在前两列内=${attachProbe?.inFirstTwo}`,
    )
    // ⚠️ 读数打在**绿的那一次**里：`ok()` 只在失败时印 detail，绿的那次是空的。
    // 期望是从 fixture 推导的，不把推导出来的值打出来，事后没法核对"它到底按哪两列在判"。
    console.log(
      `  （收口读数：视图第 1/2 列 = ${firstRowCheck?.s1Name} / ${firstRowCheck?.s2Name}；` +
        `记录 1 的副格 = ${JSON.stringify(firstRowCheck?.record1Sub)}；` +
        `搜索关键词 = ${JSON.stringify(needleInfo?.needle)}（第 2 列）；` +
        `附件名 = ${attachProbe?.name}，词干 = ${attachProbe?.stem}，附件列在前两列内 = ${attachProbe?.inFirstTwo}）`,
    )

    await bp(`__bpSetInput('.wiz-search', '')`)
    await sleep(500)

    // ------------------------------------------------------------
    // [B②] 勾选置顶：勾一条**非首行**的记录，它必须出现在列表首位
    //
    // 为什么要成对压两件事：需求原话是"勾选的置顶"，
    // 但如果置顶区按**点击顺序**排，用户先勾 5 再勾 3 就会得到 5→3，
    // 而"打印顺序徽标"给的是 3→5 —— 两个地方对不上，用户没法预期。
    // 所以 B13 压"勾了要置顶"，B14 压"置顶区内部仍是视图顺序"。
    // 这两条以前**都不存在**：功能验过（验证者的 DOM 读数），但没有常驻守卫。
    // ------------------------------------------------------------
    console.log('\n[B②] 勾选置顶（勾一条非首行 → 它必须在首位）')
    await bp(`__bp.click('button','清空')`)
    await sleep(400)

    /** 按主格文字找到那一行，点它的复选框（= 用户真实路径，不是直接改 state） */
    const clickRowByMain = (v) =>
      bp(`(() => {
        const rows = Array.from(document.querySelectorAll('.wiz-pick-row'));
        const main = (r) => String((r.querySelector('.wiz-pick-main')||{}).innerText||'').trim();
        const row = rows.find(r => main(r) === ${JSON.stringify(v)});
        if (!row) return false;
        const cb = row.querySelector('input[type=checkbox]');
        if (!cb) return false;
        cb.click();
        return true;
      })()`)

    const readList = () =>
      bp(`(() => {
        const rows = Array.from(document.querySelectorAll('.wiz-pick-row'));
        const main = (r) => String((r.querySelector('.wiz-pick-main')||{}).innerText||'').trim();
        return {
          top5: rows.slice(0,5).map(main),
          pinnedOrder: rows.filter(r => r.classList.contains('on')).map(main),
          headOn: rows.slice(0,2).map(r => r.classList.contains('on')),
          thirdOn: rows[2] ? rows[2].classList.contains('on') : null,
          groups: Array.from(document.querySelectorAll('.wiz-pick-group')).map(e => (e.innerText||'').trim()),
          onCount: document.querySelectorAll('.wiz-pick-row.on').length,
        };
      })()`)

    const beforePin = (await readList())?.top5
    // 前提：勾之前「5」**不在**首位 —— 否则"置顶"这件事根本没被观测到
    ok(
      'B12 前提：清空后列表是视图顺序（第 5 行不在首位），置顶才有可观测的位移',
      JSON.stringify(beforePin) === JSON.stringify(['1', '2', '3', '4', '5']),
      `清空后 top5=${JSON.stringify(beforePin)}`,
    )

    const clicked1 = await clickRowByMain('5')
    await sleep(400)
    const pinned1 = await readList()
    ok(
      'B13 勾选一条非首行的记录 → 它被置顶到列表首位，并给出「已勾选 N 条」/「未勾选」两个分组标题',
      clicked1 === true &&
        pinned1?.top5?.[0] === '5' &&
        pinned1?.headOn?.[0] === true &&
        pinned1?.onCount === 1 &&
        JSON.stringify(pinned1?.groups) === JSON.stringify(['已勾选 1 条', '未勾选']),
      `勾之前 top5=${JSON.stringify(beforePin)}；勾之后 top5=${JSON.stringify(pinned1?.top5)}；` +
        `分组=${JSON.stringify(pinned1?.groups)}；已勾选=${pinned1?.onCount}`,
    )

    const clicked2 = await clickRowByMain('3')
    await sleep(400)
    const pinned2 = await readList()
    ok(
      'B14【顺序口径】置顶区内部按**视图顺序**排（先勾 5 再勾 3 → 显示 3、5，不是点击顺序 5、3）',
      clicked2 === true &&
        JSON.stringify(pinned2?.pinnedOrder) === JSON.stringify(['3', '5']) &&
        JSON.stringify(pinned2?.headOn) === JSON.stringify([true, true]) &&
        pinned2?.thirdOn === false,
      `置顶区顺序=${JSON.stringify(pinned2?.pinnedOrder)}；前两行 on=${JSON.stringify(pinned2?.headOn)}；第 3 行 on=${pinned2?.thirdOn}`,
    )
    await bp(`__bp.click('button','清空')`)
    await sleep(400)

    // ------------------------------------------------------------
    // [B③] 空值占位：**内容级**判据
    //
    // 这一条是被"73 条全绿而 DOM 是空的"证明出来的必要性：
    //   · 纯函数层（lib __selftest）只守住 `displayCellText` 本身；
    //   · 它守不住"DOM 有没有用它" —— 把 `return text || EMPTY_CELL` 改成 `return text`
    //     之后 range-picker 依然 73/73，而那一行已经是 `{"main":"51","sub":""}`。
    // 所以判据必须落在**渲染出来的字**上，而不是"这一行有没有两个 span"。
    // B15 是先证明装置里真的存在空格子（否则下一条会退化成"扫一个不存在的模式"）。
    // ------------------------------------------------------------
    console.log('\n[B③] 空值占位：那一格渲染出来的到底是哪串字')
    // ⚠️ 隐含假设收口（team-lead 点名）：上一版把"有值的行"认成 `/薇诺娜/` 的行、
    // 并把行数写死成 `namedRows === 59 && dashedRows === 1` —— 那测的是 **mock fixture
    // 那两列的具体内容**，列序一变（M1 把附件列挪到第 2 位）就三连红（`_r4-8-m1-oldb4.txt`）。
    // 现在两边都改成**从 fixture 推导**：
    //   · 「空格子的行」= 第 2 列取值为空的那条记录（列由 fixture 列序决定，不是写死的列名）；
    //   · 「有值的行」= 第 2 列取值非空的行，且这些行**不许**显示成「—」。
    // 这样 M1 再挪一次列序也不会假红，而"空值不占位" / "全表都是—" 两个变异仍然压得红
    // （见 `_r4-empty-out.txt` / `_r4-alldash-out.txt`）。
    // 「—」这个**字面量**是故意留的：它是需求原话（空值显式显示成「—」），
    // 不是数据里的字面量 —— 它必须在某一层被钉死，纯函数层钉不住"DOM 有没有用它"。
    const emptyProbe = await bp(`(async () => {
      const MS = await import('/src/lib/mock-source.ts');
      const LF = await import('/src/components/wizard/label-fields.ts');
      const FT = await import('/src/lib/field-types.ts');
      const recs = MS.buildMockRecords(60);
      const slots = LF.pickLabelFields(MS.MOCK_FIELDS);
      const s1 = slots[0], s2 = slots[1];
      const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      const disp = (rec, f) => norm(FT.renderCellValue((rec.fields||{})[f.id], f.type));
      // "空"的判据与产品同源：空数组算空（lib/__selftest.mts:328 那条"附件 空数组视为无附件"）
      const isBlank = (rec) => norm(String((rec.fields||{})[s2.id] ?? '')).replace(/[\\[\\],]/g, '') === '';
      const blanks = recs.filter(isBlank);
      const rows = Array.from(document.querySelectorAll('.wiz-pick-row'));
      const main = (r) => norm((r.querySelector('.wiz-pick-main')||{}).innerText || '');
      const subOf = (r) => norm((r.querySelector('.wiz-pick-sub')||{}).innerText || '');
      // 每行反查它属于哪条记录：第 1 列的值 → 记录
      const recOfRow = new Map();
      for (const r of rows) {
        const hit = recs.find(x => norm(disp(x, s1)) === main(r));
        if (hit) recOfRow.set(r, hit);
      }
      const row = blanks.length ? rows.find(x => recOfRow.get(x) === blanks[0]) : null;
      const valued = rows.filter(x => recOfRow.has(x) && !isBlank(recOfRow.get(x)));
      return {
        blankNos: blanks.map(r => r.fields.fld_no),
        blankCount: blanks.length,
        subFieldName: s2 ? s2.name : null,
        rowFound: !!row,
        rowSub: row ? subOf(row) : null,
        rowSubRaw: row ? String((row.querySelector('.wiz-pick-sub')||{}).textContent||'') : null,
        dashedRows: rows.filter(x => subOf(x) === '—').length,
        valuedRows: valued.length,
        valuedNotDashed: valued.filter(x => subOf(x) !== '—').length,
        unmatchedRows: rows.length - recOfRow.size,
        totalRows: rows.length,
      };
    })()`)
    ok(
      'B15 前提：mock 数据里确实存在「视图第 2 列为空」的记录（否则下面那条会退化成"扫一个不存在的模式"而永远绿）',
      (emptyProbe?.blankNos ?? []).length >= 1,
      `空值记录=${JSON.stringify(emptyProbe?.blankNos)}（第 2 列 = ${emptyProbe?.subFieldName}）`,
    )
    ok(
      'B16【内容级】那条记录在列表里渲染出来的格子内容就是「—」（不是空字符串、不是 undefined）',
      emptyProbe?.rowFound === true && emptyProbe?.rowSub === '—',
      `该行副格=${JSON.stringify(emptyProbe?.rowSub)}（原始 textContent=${JSON.stringify(emptyProbe?.rowSubRaw)}）`,
    )
    ok(
      'B17【反向对照】有值的行仍显示真值（不是全表都被替换成「—」；行数按 fixture 推导，不写死）',
      (emptyProbe?.valuedRows ?? 0) > 0 &&
        (emptyProbe?.unmatchedRows ?? 1) === 0 &&
        (emptyProbe?.dashedRows ?? -1) === (emptyProbe?.blankCount ?? -2) &&
        (emptyProbe?.valuedNotDashed ?? -1) === (emptyProbe?.valuedRows ?? -2),
      `空格子的行=${emptyProbe?.blankCount}；显示「—」的行=${emptyProbe?.dashedRows}；` +
        `有值的行=${emptyProbe?.valuedRows}（其中没被替换成「—」的=${emptyProbe?.valuedNotDashed}）；` +
        `反查不到记录的行=${emptyProbe?.unmatchedRows}；总行数=${emptyProbe?.totalRows}`,
    )
    // 同上：期望是从 fixture 推导的，绿的那次也要能看到它推出来的数
    console.log(
      `  （B③ 收口读数：第 2 列 = ${emptyProbe?.subFieldName}；空格子的行 = ${emptyProbe?.blankCount}` +
        `（记录 ${JSON.stringify(emptyProbe?.blankNos)}）；显示「—」的行 = ${emptyProbe?.dashedRows}；` +
        `有值行 = ${emptyProbe?.valuedRows}，其中未被替换成「—」的 = ${emptyProbe?.valuedNotDashed}）`,
    )

    // ------------------------------------------------------------
    console.log('\n[C] 按行数勾选')
    await ensurePicker(cdp)
    await bp(`__bp.click('button','清空')`)
    await sleep(400)
    ok('C0 清空把勾选归零', (await bp(`__bp.count('.wiz-pick-row.on')`)) === 0)

    ok('C1 有「全选前 50」这个快捷按钮', (await bp(`__bp.byText('button','全选前 50').length > 0`)) === true)
    ok('C2 有可输入行数的输入框', (await bp(`__bp.count('.wiz-num') > 0`)) === true)

    await bp(`__bpSetInput('.wiz-num', '5')`)
    await sleep(300)
    await bp(`__bp.click('button','勾选')`)
    await sleep(600)
    const c5 = await bp(`({ on: __bp.count('.wiz-pick-row.on'), hint: __bp.text() })`)
    ok('C3 输入 5 → 勾选 5 条', c5?.on === 5, `实际勾选 ${c5?.on}`)
    ok('C4 给出"已勾选前 5 条"的确认', /已勾选前 5 条/.test(String(c5?.hint ?? '')))

    await bp(`__bpSetInput('.wiz-num', '999')`)
    await sleep(300)
    await bp(`__bp.click('button','勾选')`)
    await sleep(600)
    const c999 = await bp(`({ on: __bp.count('.wiz-pick-row.on'), hint: __bp.text() })`)
    ok('C5 输入 999 → 只勾 50 条（守上限）', c999?.on === 50, `实际勾选 ${c999?.on}`)
    ok(
      'C6 超上限时"明说"而不是静默截断',
      /单次最多 50 条/.test(String(c999?.hint ?? '')) && /999/.test(String(c999?.hint ?? '')),
    )

    await bp(`__bp.click('button','清空')`)
    await sleep(400)
    await bp(`__bpSetInput('.wiz-num', '0')`)
    await sleep(300)
    await bp(`__bp.click('button','勾选')`)
    await sleep(500)
    const c0 = await bp(`({ on: __bp.count('.wiz-pick-row.on'), hint: __bp.text() })`)
    ok('C7 输入 0 → 不勾选，且给出可读提示', c0?.on === 0 && /请输入 1 以上/.test(String(c0?.hint ?? '')))

    await bp(`__bpSetInput('.wiz-num', '3')`)
    await sleep(300)
    await bp(`__bp.click('button','勾选')`)
    await sleep(500)
    const c3 = await bp(`(() => {
      const rows = Array.from(document.querySelectorAll('.wiz-pick-row'));
      return rows.slice(0,5).map(r => r.classList.contains('on'));
    })()`)
    ok(
      'C8 勾选的是"列表最前面的 3 行"（顺序可核对）',
      JSON.stringify(c3) === JSON.stringify([true, true, true, false, false]),
      JSON.stringify(c3),
    )

    await bp(`__bp.click('button','清空')`)
    await sleep(400)

    // ------------------------------------------------------------
    console.log('\n[D] 读取选中行：六条路径 + 提示不能静默')
    const d = await bp(SECTION_D)
    ok('D1 官方选择器可用时返回 id 列表', d?.pickerOk?.status === 'ok' && d.pickerOk.ids.join(',') === 'rec_1,rec_2', JSON.stringify(d?.pickerOk))
    ok('D2 取消（返回 null）→ cancelled', d?.pickerCancel?.status === 'cancelled', JSON.stringify(d?.pickerCancel))
    ok('D3 返回空数组 → empty（与取消区分开）', d?.pickerEmpty?.status === 'empty', JSON.stringify(d?.pickerEmpty))
    ok('D4 抛错 → error（不吞异常）', d?.pickerThrow?.status === 'error' && /host exploded/.test(d.pickerThrow.reason), JSON.stringify(d?.pickerThrow))
    ok('D5 一直不回应 → timeout（不把界面卡死）', d?.pickerHang?.status === 'timeout', JSON.stringify(d?.pickerHang))
    ok('D6 没这个接口 → unsupported', d?.pickerNa?.status === 'unsupported', JSON.stringify(d?.pickerNa))
    ok('D7 表格视图选中行可用时返回 id 列表', d?.gridOk?.status === 'ok' && d.gridOk.ids[0] === 'rec_9', JSON.stringify(d?.gridOk))
    ok('D8 表格视图"没选任何行"→ empty', d?.gridEmpty?.status === 'empty', JSON.stringify(d?.gridEmpty))
    ok('D9 表格视图取消 → cancelled', d?.gridCancel?.status === 'cancelled', JSON.stringify(d?.gridCancel))
    ok('D10 表格视图不回应 → timeout', d?.gridHang?.status === 'timeout', JSON.stringify(d?.gridHang))
    ok('D11 视图没有该接口 → unsupported', d?.gridNa?.status === 'unsupported', JSON.stringify(d?.gridNa))
    ok('D12 数据源没有视图对象 → unsupported', d?.gridNoTable?.status === 'unsupported', JSON.stringify(d?.gridNoTable))
    ok('D13 超时后晚到的结果仍被接收（不丢用户的选择）', d?.late?.status === 'ok' && d.late.ids[0] === 'rec_late', JSON.stringify(d?.late))

    const silent = (h) => !h || typeof h.text !== 'string' || h.text.trim().length < 6
    ok('D14 取消路径有明确提示（不静默）', !silent(d?.hints?.cancel) && /取消/.test(d.hints.cancel.text), JSON.stringify(d?.hints?.cancel))
    ok('D15 空结果有明确提示', !silent(d?.hints?.empty) && d.hints.empty.ok === false, JSON.stringify(d?.hints?.empty))
    ok('D16 超时有明确提示（含无响应说明）', !silent(d?.hints?.timeout) && /没有响应/.test(d.hints.timeout.text), JSON.stringify(d?.hints?.timeout))
    ok('D17 报错有明确提示（带原因）', !silent(d?.hints?.error) && /host exploded/.test(d.hints.error.text), JSON.stringify(d?.hints?.error))
    ok('D18 不支持有明确提示（带原因）', !silent(d?.hints?.unsupported) && /读不到/.test(d.hints.unsupported.text), JSON.stringify(d?.hints?.unsupported))
    ok('D19 成功提示带条数', d?.hints?.ok?.ok === true && /2 条/.test(d.hints.ok.text), JSON.stringify(d?.hints?.ok))
    ok(
      'D20 能力边界说明如实（不支持时明说"没有提供"）',
      /没有提供/.test(String(d?.notes?.none ?? '')),
      String(d?.notes?.none),
    )

    // ------------------------------------------------------------
    console.log('\n[D2] 不可用路径的真实 UI 表现 + 等待期间的"看得见"反馈（同一次点击）')
    // 这一整块必须在**还没点过这个按钮**的状态下跑：`selectCapability` 是粘性的，
    // 一旦判成 `none`，再点就直接走"读光标那一行"、**不会再调用降级链**，也就观察不到进度文案了。
    //
    // 为什么要给原型打补丁：mock 里两级都是瞬间返回，React 根本来不及把"正在…"画出来。
    // 不用 CDP Fetch 拦截（实测那会让 Runtime.evaluate 间歇性卡到 25 秒超时，失败点还随机漂移）。
    // 这里给导出的 `MockDataSource` 原型挂一个受 `window.__bpSlowSel` 控制的慢速开关，
    // 并且让 ② 真的走"宿主不回应"的真实形态（永远不 settle 的 Promise）——
    // 这样连"最坏等 6 秒超时"这条路径也一起被真实 UI 覆盖到了。
    const patched = await bp(`(async () => {
      const url = performance.getEntriesByType('resource')
        .map((e) => e.name).find((n) => /mock-source\\.ts/.test(n));
      if (!url) return { ok: false, why: '资源列表里没有 mock-source.ts' };
      const MS = await import(url);
      const C = MS.MockDataSource;
      if (typeof C !== 'function') return { ok: false, why: '没有导出 MockDataSource' };
      const P = C.prototype;
      if (typeof P.rawTable !== 'function') return { ok: false, why: '原型上没有 rawTable' };
      const origRawTable = P.rawTable;
      const slow = () => new Promise((r) => setTimeout(r, 900));
      // ① 路：给一个"真表格对象"，但它的 getViewList() 慢 ——
      // 关键：慢必须发生在 **onStage('grid') 与 onStage('picker') 之间**，
      // 否则两次 setState 落在同一个 microtask 里，React 会批成一次渲染，① 的文案永远看不见。
      // （早先版本让 rawTable 自己慢，那 900ms 是在进链**之前**，所以只看到 ②。）
      P.rawTable = async function (...a) {
        if (!window.__bpSlowSel) return origRawTable.apply(this, a);
        return { getViewList: async () => { await slow(); return [{ id: 'viw' }]; } };
      };
      // ② 路："永不回应"——和飞书宿主没注册通道时的真实表现一致，
      // 于是界面必须靠 withDeadline 兜底（这也是"最坏等 6 秒"那条路径的真实覆盖）。
      P.rawModules = async function () {
        return window.__bpSlowSel ? { ui: { selectRecordIdList: () => new Promise(() => {}) } } : null;
      };
      return { ok: true, url };
    })()`)

    await ensurePicker(cdp)
    await bp(`window.__bpSlowSel = true`)
    await bp(`__bp.click('button','读取左表勾选（多条）')`)

    const seen = { grid: false, picker: false, order: [] }
    const tStart = Date.now()
    let polls = 0
    while (Date.now() - tStart < 9000) {
      polls += 1
      const txt = await bp(`__bp.text()`)
      if (!seen.grid && txt.includes('正在尝试读取左表勾选')) {
        seen.grid = true
        seen.order.push('grid')
        console.log(`  · t=${Date.now() - tStart}ms 第 ${polls} 次轮询：看到①的进行中文案`)
      }
      if (!seen.picker && txt.includes('正在打开飞书记录选择器')) {
        seen.picker = true
        seen.order.push('picker')
        console.log(`  · t=${Date.now() - tStart}ms 第 ${polls} 次轮询：看到②的进行中文案`)
      }
      if (seen.grid && seen.picker) break
      await sleep(70)
    }

    // ② 走的是"永不回应 → 兜底超时"，所以最终结论要再等一会儿。
    // 上限跟着产品常量走（别把"② 必须正好 6 秒"悄悄写进断言）：
    // 有人**故意**把用户窗口调大时，这里应该跟着等，而不是变红。
    const pickerBudget = d?.budgets?.picker ?? 6000
    let afterWait = ''
    const tWait = Date.now()
    while (Date.now() - tWait < pickerBudget + 6000) {
      afterWait = await bp(`__bp.text()`)
      if (String(afterWait).includes('读不到你在多维表格里选中的行')) break
      await sleep(150)
    }
    await bp(`window.__bpSlowSel = false`)
    const uiNa = { text: afterWait, on: await bp(`__bp.count('.wiz-pick-row.on')`) }
    console.log(`  · 最终结论在 t=${Date.now() - tStart}ms 出现`)

    ok(
      'D21 点「读取左表勾选」后如实说明读不到（不假装支持）',
      /读不到你在多维表格里选中的行/.test(String(uiNa?.text ?? '')),
    )
    ok('D22 读不到时退回读取光标所在那一行（不是点了没反应）', (uiNa?.on ?? 0) >= 1, `已勾选 ${uiNa?.on}`)
    ok('D23 界面里的能力说明随之更新为"没有提供该接口"', /没有提供/.test(String(uiNa?.text ?? '')))
    ok('D32 慢速开关真的挂上了（否则下面三条会"因为没慢下来"而假绿）', patched?.ok === true, JSON.stringify(patched))
    ok(
      'D33【真实 DOM】等待期间页面上确实出现过"正在尝试读取左表勾选…"（点了不是没反应）',
      seen.grid,
      `观察到=${JSON.stringify(seen)}（轮询 ${polls} 次）`,
    )
    ok(
      'D34【真实 DOM】随后出现过"左表勾选不可用（…），正在打开飞书记录选择器…"',
      seen.picker,
      JSON.stringify(seen),
    )
    ok(
      'D35【真实 DOM】两条进度文案按 先①后② 的顺序出现，且最终落到"读不到"的结论',
      JSON.stringify(seen.order) === JSON.stringify(['grid', 'picker']) &&
        /读不到你在多维表格里选中的行/.test(String(uiNa?.text ?? '')),
      `order=${JSON.stringify(seen.order)}`,
    )

    // ------------------------------------------------------------
    console.log('\n[D3] 降级链本身：① 不可用时必须自动走 ②，且用户能看出走的是哪一级')
    ok(
      'D24 ① 可用时就用 ①，且 ② 一次都没被调用（不越级）',
      d?.chainGrid?.level === 'grid' &&
        d.chainGrid.outcome.ids.join(',') === 'rec_g1' &&
        d?.chainGridPickerCalled === 0,
      `level=${d?.chainGrid?.level} ids=${JSON.stringify(d?.chainGrid?.outcome?.ids)} ②被调用 ${d?.chainGridPickerCalled} 次`,
    )
    ok(
      'D25 ① 探测不到时自动降级到 ②（不是静默失败，也不是点了没反应）',
      d?.chainFallback?.level === 'picker' &&
        d.chainFallback.outcome.ids.join(',') === 'rec_p2' &&
        (d?.chainFallback?.skipped?.length ?? 0) === 1,
      `level=${d?.chainFallback?.level} ids=${JSON.stringify(d?.chainFallback?.outcome?.ids)} skipped=${JSON.stringify(d?.chainFallback?.skipped)}`,
    )
    ok(
      'D26 降级到 ② 时，成功提示里明说"左表勾选不可用"及原因（用户不会以为在用 ①）',
      /左表勾选不可用/.test(String(d?.chainFallbackLabel ?? '')) &&
        String(d?.chainFallbackLabel ?? '').includes(String(d?.chainFallback?.skipped?.[0] ?? '\u0000')),
      String(d?.chainFallbackLabel),
    )
    ok(
      'D27 ① 连表格对象都拿不到时，同样自动降级到 ②',
      d?.chainNoTable?.level === 'picker' && d.chainNoTable.outcome.ids.join(',') === 'rec_p3',
      `level=${d?.chainNoTable?.level} ids=${JSON.stringify(d?.chainNoTable?.outcome?.ids)}`,
    )
    ok(
      'D28 两级都不通 → level=none，且两条原因并列说出（不吞、不只报最后一条）',
      d?.chainNone?.level === 'none' &&
        /表格视图/.test(String(d?.chainNoneText ?? '')) &&
        /官方选择器/.test(String(d?.chainNoneText ?? '')),
      String(d?.chainNoneText),
    )

    // ------------------------------------------------------------
    console.log('\n[D4] 等待期间有没有"看得见"的进行中反馈（不是静默等十几秒）')
    const st = d?.stages ?? []
    ok(
      'D29 ①→② 降级时，每一级开始前都先说了话（顺序：先 ① 后 ②）',
      st.length === 2 &&
        st[0][0] === 'grid' &&
        st[1][0] === 'picker' &&
        st[0][1] === d?.stageText?.grid,
      JSON.stringify(st),
    )
    ok(
      'D30 ② 的进行中文案里带上了 ① 失败的原因（用户知道为什么要开选择器）',
      st.length === 2 && st[1][1].includes(String(d?.chainFallback?.skipped?.[0] ?? '\u0000')),
      JSON.stringify(st[1] ?? null),
    )
    ok(
      'D31 ① 可用时只报 ① 的进度，不出现"正在打开选择器"（不误导用户）',
      (d?.stages2 ?? []).length === 1 && d.stages2[0][0] === 'grid',
      JSON.stringify(d?.stages2),
    )

    // ------------------------------------------------------------
    console.log('\n[D5] ① 与 ② 的截止时间各自独立（曾共用一个常量，是留给下一个人的陷阱）')
    const bg = d?.budgets
    ok(
      'D36 两级各有自己的 deadline 常量，且 ② 的用户窗口不短于 ① 的探测时间',
      typeof bg?.grid === 'number' &&
        typeof bg?.picker === 'number' &&
        bg.grid > 0 &&
        bg.picker > 0 &&
        bg.picker >= bg.grid,
      `grid=${bg?.grid} picker=${bg?.picker}`,
    )
    ok(
      'D37 超时文案按级分开（① 说"左表勾选的接口"、② 说"记录选择器"，用户才知道该找谁）',
      /左表勾选的接口/.test(String(bg?.gridTimeoutHint ?? '')) &&
        /记录选择器/.test(String(bg?.pickerTimeoutHint ?? '')) &&
        String(bg?.gridTimeoutHint) !== String(bg?.pickerTimeoutHint),
      JSON.stringify({ grid: bg?.gridTimeoutHint, picker: bg?.pickerTimeoutHint }),
    )
    ok(
      'D38 显式 timeoutMs 仍然优先于两级各自的默认值（拆分没把覆盖路径弄坏）',
      bg?.gridOverride?.status === 'timeout' &&
        bg.gridOverride.waitedMs === 200 &&
        bg?.pickerOverride?.status === 'timeout' &&
        bg.pickerOverride.waitedMs === 200,
      JSON.stringify({ grid: bg?.gridOverride?.waitedMs, picker: bg?.pickerOverride?.waitedMs }),
    )

    // ------------------------------------------------------------
    console.log('\n[E] 截图与运行期错误')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync('.shots/range-after.png', Buffer.from(shot.data, 'base64'))
    const full = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync('.shots/range-after-full.png', Buffer.from(full.data, 'base64'))
    console.log('  已保存 .shots/range-after.png 与 range-after-full.png')

    const realErrors = cdp.consoleErrors.filter((m) => !/favicon|Download the React DevTools/i.test(m))
    const realExceptions = cdp.exceptions.filter((m) => !/favicon/i.test(m))
    ok('E1 无 console 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
    ok('E2 无未捕获异常', realExceptions.length === 0, realExceptions.slice(0, 3).join(' | '))
    ok('E3 期间页面没有意外整页刷新（否则前面所有断言都不可信）', cdp.navigations.length <= 1, cdp.navigations.join(' | '))
  } finally {
    if (cdp && cdp.navigations.length > 0) {
      console.log(`\n（页面导航记录：${cdp.navigations.join(' | ')}）`)
    }
    try {
      if (cdp) await cdp.send('Browser.close')
    } catch {
      /* 忽略 */
    }
    await sleep(300)
    child.kill()
    // 关键：Edge 的实际浏览器进程不是我们 spawn 的那个 launcher，`child.kill()` 杀不掉它，
    // 它会变成孤儿继续占着调试端口（下一次运行就会被它坑）。所以连整棵进程树一起收掉。
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 非 Windows 或进程已退出 */
    }
    await sleep(600)
    if (await isPortBusy(PORT)) {
      console.log(`⚠️ 端口 ${PORT} 在退出后仍被占用 —— 可能有残留浏览器进程，请手动清理`)
    }
  }

  console.log('\n' + '='.repeat(52))
  if (failures.length === 0) {
    console.log(`✅ 打印范围（勾选记录）专项全部通过：${pass} 项`)
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(52))

  /**
   * ⚠️ ASCII 结论行：上面那行中文摘要会被 **OEM 码页吞掉紧邻 `：` 的一个字符**
   * （`：48 项` 曾被读成 `?8 项` → 报成 38）。这一行不含中文，**任何控制台编码下都一样**，
   * 读的人不必"记得先把控制台设成 UTF-8"。
   */
  console.log(`PASS_COUNT=${pass} FAIL_COUNT=${failures.length}`)

  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* 尽力而为 */
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

// 只有"被直接执行"时才跑 main；被 import（例如反向验证脚本要复用 looksJsonDumped）时只取函数，不起浏览器。
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  main().catch((e) => {
    console.error('专项验证脚本崩溃：', e)
    process.exit(1)
  })
}
