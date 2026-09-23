/**
 * 「renderCellValue 不许把值 dump 成 JSON」——**这条护栏本身还有没有牙**？
 *
 * ============================================================
 * 1. 这个脚本验证什么
 * ============================================================
 * `src/lib/field-types.ts` 里的 `renderCellValue()` 曾经会把对象值 dump 成 JSON
 * （富文本片段数组 `[{type:'text',text:'张三'}]` 直接印在纸面上），修好之后
 * `test/range-picker.mjs` 用两条断言守住它：
 *
 *   · A7 —— fixture 层：列表标签文本里不能出现 JSON 片段
 *   · B5 —— 真实 DOM 层：勾选列表渲染出来的文本里不能出现 JSON 片段
 *
 * 但**断言写着不等于断言有牙**。这个项目已经出现过三次"测试全绿、断言其实从没生效"，
 * 其中最阴的一种是"断言形式只能覆盖一半的失败形态"。所以这个脚本的职责只有一个：
 * **把回归人为制造出来，看这两条断言会不会红。** 会红 = 有效；还是绿 = 空转，必须换形式。
 *
 * 这不是一次性检查 —— `B5` 就是在第一次跑它的时候被查出空转的
 * （mock 表里能做标签的字段都是字符串，字符串 dump 后是 `"薇诺娜…50g"`，
 * 既没有 `{` 也没有 `[`，原来那两条判定一个都不匹配）。补强后复跑，双红。
 *
 * ============================================================
 * 2. 手法原理：非侵入式，不影响正在并行工作的队友
 * ============================================================
 * **不修改磁盘上的 `src/lib/field-types.ts`。** 理由不是洁癖：
 * 任何改盘的方案都会在一个时间窗口里对其他队友的测试生效，
 * 他们那边会看到"莫名其妙的 JSON dump 失败"，然后去查一个根本不存在的回归。
 *
 * 改用 CDP `Fetch` 域拦截：给浏览器会话挂上 `Fetch.enable`（只匹配 `*field-types.ts*`），
 * 在 `Fetch.requestPaused` 里把 Vite 编译出来的**产物**替换掉
 * （`return anyText(` → `return JSON.stringify(`），再用 `Fetch.fulfillRequest` 回给页面。
 * 于是：
 *   · 真实模块图、真实 React 组件、真实 DOM —— 全都在
 *   · 只有这一个模块的实现在**这一个无头会话里**被回退
 *   · 磁盘文件一个字节都不动，跑前跑后各校验一次 sha256 自证（见输出最后两行）
 *
 * 为了让"测试"和"验证脚本"用的是**同一份**判定（否则会漂移成验证了别的东西），
 * 判定函数是从 `test/range-picker.mjs` 里 import 的：`looksJsonDumped()`。
 *
 * 判据（两态对比，缺一不可）：
 *   正常态绿 + 回退态红 → 有效
 *   正常态绿 + 回退态绿 → 空转
 *
 * ============================================================
 * 3. 什么时候该跑它
 * ============================================================
 * **任何改动 `src/lib/field-types.ts` 里取值/渲染逻辑之后，都要跑一次。**
 * 它约 40 秒，比自己推理"这条断言应该没问题"便宜得多。
 * 改动 `test/range-picker.mjs` 的 A 段/B 段或 `looksJsonDumped()` 之后同样要跑。
 *
 * 用法（在项目根目录）：`node test/field-types-revert-check.mjs`
 * 退出码：0 = 两条断言都有牙；1 = 有空转断言（会明确指出是哪一条）
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://localhost:5190'
const PORT = 9385
const PORT_NO = 9386
const FT_PATH = 'src/lib/field-types.ts'
const OUT = '.field-types-revert-result.txt'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))

// 从被测脚本里取"同一份"判定函数（该脚本有 isEntry 保护，import 不会起浏览器）
const { looksJsonDumped } = await import('./range-picker.mjs')

const sha = (b) => createHash('sha256').update(b).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HELPERS = `
window.__bp = {
  count(sel) { return document.querySelectorAll(sel).length; },
  text() { return document.body.innerText || ''; },
  rowTexts() { return Array.from(document.querySelectorAll('.wiz-pick-row')).map(r => (r.querySelector('.wiz-pick-text')||{}).innerText || ''); },
  click(sel, t) { const e = Array.from(document.querySelectorAll(sel)).filter(x => (x.textContent||'').includes(t))[0]; if (!e) return false; e.click(); return true; },
};
true`

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result?.value
  }
}

/** 同一个 fixture 表达式，A7 部分与 test/range-picker.mjs 的 SECTION_A 完全一致 */
const SEL5 = `(async () => {
  const LF = await import('/src/components/wizard/label-fields.ts');
  const FT = await import('/src/lib/field-types.ts');
  const NAME_PRIMARY = { id: 'f_title', name: '名称', type: 1, isPrimary: true };
  const RICH = { id: 'f_rich', name: '备注', type: 1 };
  const rec = { recordId: 'r1', fields: { f_title: '张三', f_rich: [{ type: 'text', text: '张三' }] } };
  // 第三批起 pickLabelFields 只收一个参数（视图列序 → 前两列），与 range-picker 的 SECTION_A 同步
  const sel5 = LF.pickLabelFields([NAME_PRIMARY, RICH]);
  const sel5Text = sel5.map(f => FT.renderCellValue(rec.fields[f.id], f.type).trim()).filter(Boolean).join(' | ');
  return { sel5: sel5.map(f => f.name), sel5Text };
})()`

/**
 * @param {boolean} revert true = 在浏览器里把兜底换回 JSON.stringify
 */
async function run(revert) {
  const port = revert ? PORT : PORT_NO
  const profileDir = join(tmpdir(), `bp-rv-${revert ? 'on' : 'off'}-${Date.now().toString(36)}`)
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=390,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const served = []
  let cdp = null
  try {
    let target = null
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        target = list.find((t) => t.type === 'page')
        if (target?.webSocketDebuggerUrl) break
      } catch {
        /* 还没起来 */
      }
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
      width: 390, height: 1000, deviceScaleFactor: 2, mobile: false,
    })

    if (revert) {
      cdp.on('Fetch.requestPaused', async (p) => {
        const url = p.request.url
        if (!/field-types\.ts/.test(url)) {
          try {
            await cdp.send('Fetch.continueRequest', { requestId: p.requestId })
          } catch {
            /* 忽略 */
          }
          return
        }
        try {
          const res = await fetch(url)
          const orig = await res.text()
          const n = (orig.match(/return anyText\(/g) || []).length
          const patched = orig.replace(/return anyText\(/g, 'return JSON.stringify(')
          served.push({
            url,
            hits: n,
            changed: patched !== orig,
            head: patched.slice(patched.indexOf('function renderCellValue'), patched.indexOf('function renderCellValue') + 260),
          })
          await cdp.send('Fetch.fulfillRequest', {
            requestId: p.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/javascript' }],
            body: Buffer.from(patched, 'utf8').toString('base64'),
          })
        } catch (e) {
          served.push({ url, error: String(e?.message ?? e) })
          try {
            await cdp.send('Fetch.continueRequest', { requestId: p.requestId })
          } catch {
            /* 忽略 */
          }
        }
      })
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*field-types.ts*' }] })
    }

    await cdp.send('Page.navigate', { url: `${BASE}/?mock=1&tab=wizard` })
    await sleep(3500)
    await cdp.eval(HELPERS)
    await sleep(800)

    const a = await cdp.eval(SEL5)

    // 切到「手动勾选」把列表渲染出来
    await cdp.eval(`(window.__bp && __bp.click('button','手动勾选')) || false`)
    let rows = 0
    for (let i = 0; i < 30; i++) {
      await sleep(300)
      rows = await cdp.eval(`__bp.count('.wiz-pick-row')`)
      if (rows > 0) break
    }
    const rowTexts = await cdp.eval(`__bp.rowTexts().slice(0, 6)`)
    const rowBlob = (rowTexts ?? []).join('\n')

    const A7 = !/[{[]\s*"/.test(String(a?.sel5Text ?? '')) && !String(a?.sel5Text ?? '').includes('{"')
    // 调的是 test/range-picker.mjs 里**导出的同一份**判定，不是这里复制的一份 —— 否则两处会漂移
    const b5 = looksJsonDumped(rowTexts)

    return { revert, served, sel5: a?.sel5, sel5Text: a?.sel5Text, rows, rowTexts, A7, B5: !b5.dumped, b5 }
  } finally {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    await sleep(500)
    rmSync(profileDir, { recursive: true, force: true })
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
  }
}

const lines = []
const say = (s = '') => {
  lines.push(s)
  console.log(s)
}

const before = readFileSync(FT_PATH)
say(`磁盘 ${FT_PATH} 跑前 sha256: ${sha(before)}`)

say('\n===== ① 回退态（浏览器里把 return anyText( 换成 return JSON.stringify(）=====')
const on = await run(true)
say(`拦截到的 field-types 模块请求数: ${on.served.length}`)
for (const s of on.served) {
  say(`  ${s.url}`)
  say(`    'return anyText(' 出现 ${s.hits} 次；已替换 = ${s.changed}`)
  if (s.head) say(`    替换后的 renderCellValue 片段:\n${s.head.split('\n').map((x) => '      ' + x).join('\n')}`)
}
say(`  A7 计算值: sel5Text = ${JSON.stringify(on.sel5Text)}   选中 = ${JSON.stringify(on.sel5)}`)
say(`  A7 断言结果: ${on.A7 ? 'PASS（绿）' : 'FAIL（红）'}`)
say(`  B5 列表行数 = ${on.rows}`)
say(`  B5 rowTexts = ${JSON.stringify(on.rowTexts, null, 0)}`)
say(`  B5 判定明细: jsonShape=${on.b5.hasJsonShape} 引号包裹=${JSON.stringify(on.b5.quoted.slice(0, 3))}`)
say(`  B5 断言结果: ${on.B5 ? 'PASS（绿）' : 'FAIL（红）'}`)

const after = readFileSync(FT_PATH)
say(`\n磁盘 ${FT_PATH} 跑后 sha256: ${sha(after)}`)
say(`磁盘文件是否被改动: ${sha(after) === sha(before) ? '否（未改动，反向验证是非侵入的）' : '是（异常！）'}`)

say('\n===== ② 正常态（不拦截，同一套断言）=====')
const off = await run(false)
say(`  A7 计算值: sel5Text = ${JSON.stringify(off.sel5Text)}`)
say(`  A7 断言结果: ${off.A7 ? 'PASS（绿）' : 'FAIL（红）'}`)
say(`  B5 列表行数 = ${off.rows}`)
say(`  B5 rowTexts = ${JSON.stringify(off.rowTexts, null, 0)}`)
say(`  B5 断言结果: ${off.B5 ? 'PASS（绿）' : 'FAIL（红）'}`)

say('\n===== 结论 =====')
const a7Teeth = off.A7 && !on.A7
const b5Teeth = off.B5 && !on.B5
say(`A7（fixture 层）: 正常态 ${off.A7 ? '绿' : '红'} / 回退态 ${on.A7 ? '绿' : '红'} → ${a7Teeth ? '有效（能抓到回归）' : '空转（抓不到）'}`)
say(`B5（真实 DOM 层）: 正常态 ${off.B5 ? '绿' : '红'} / 回退态 ${on.B5 ? '绿' : '红'} → ${b5Teeth ? '有效（能抓到回归）' : '空转（抓不到）'}`)
const intact = sha(readFileSync(FT_PATH)) === sha(before)
say(`磁盘文件未被改动: ${intact ? '是' : '**否 —— 非侵入前提被破坏，本次结论不可信**'}`)

const vacuous = [!a7Teeth && 'A7', !b5Teeth && 'B5'].filter(Boolean)
say(
  vacuous.length === 0
    ? '\n✅ A7 / B5 都有牙：制造出回归时会红，正常态是绿。'
    : `\n❌ 有空转断言：${vacuous.join('、')} —— 回退态下仍然是绿的，等于没在守。请改断言形式。`,
)

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`\n已写入 ${OUT}`)
process.exit(vacuous.length === 0 && intact ? 0 : 1)
