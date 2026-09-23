/**
 * 断言审计：把 test/ 下那些"看起来在守缺陷、其实永远不会变红"的断言揪出来。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本
 * ────────────────────────────────────────────────────────────────
 * 这个项目已经三次出现"测试全绿但根本没在测"：
 *   ① 断言写成 `doc.kind === 'view'`，而 TemplateDoc 里没有 kind → 整块断言从未执行；
 *   ② `overlapOf` 各自 Math.round 再相减，凭空多 1px，判据方向反了；
 *   ③ "列表不得出现 JSON 碎片"用 `!text.includes('{"')` 判定，而 mock 表里能做标签的
 *      字段是**字符串**，`JSON.stringify("薇诺娜…50g")` 出来带一对引号、既没有 `{` 也没有 `[`
 *      —— 两个条件全不匹配。把实现回退成 dump JSON 之后，这条断言**依然绿**。
 *
 * 判据（这次审计的准绳）：
 *   **一条断言如果跑在"缺陷根本无法显现"的层级上，它就不是断言，是装饰。**
 *
 * ────────────────────────────────────────────────────────────────
 * 方法：代理层变异（不碰磁盘上的 src/）
 * ────────────────────────────────────────────────────────────────
 * "会不会变红"必须实测，不能靠读代码猜。做法：
 *   · 起一个本地反向代理（默认 5191 → 5190），把 Vite 编译好的模块响应在**内存里**
 *     替换成"故障版本"（只改一处、瞄准被审断言想守的那个缺陷）；
 *   · 让被测脚本用 `BP_BASE`（或 argv）指向代理，跑**它们自己的真实断言**；
 *   · 同一脚本跑两遍：基线（不改）与变异版，逐条比对 PASS/FAIL。
 *     基线绿 → 变异红 = 承重；两次都绿 = 装饰。
 *
 * 磁盘一个字节都不动 —— 因为其它队友正在并行工作，改 src/ 会造出"假回归"。
 * 脚本跑前跑后各记一次 src/ 与 test/ 的 sha256 清单并比对，用来证明这一点。
 *
 * ⚠️ 变异必须"确实命中"才有意义。代理记下每个变异在真实响应里替换了几次；
 *    命中数为 0 的变异会被标成「未命中」并作废 —— 这本身也是本项目踩过的坑
 *    （断言找的模式在真实数据里根本不存在，于是永远绿）。
 *
 * 用法：
 *   node test/assertion-audit.mjs                 # 跑全部
 *   node test/assertion-audit.mjs --phase=quick   # 只跑便宜的（range-picker）
 *   node test/assertion-audit.mjs --plan          # 只打印计划，不跑
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const UPSTREAM_PORT = Number(process.env.BP_UPSTREAM_PORT ?? 5190)
const PROXY_PORT = Number(process.env.BP_PROXY_PORT ?? 5191)
const PROXY_BASE = `http://localhost:${PROXY_PORT}`

/** Vite dev server 必须活着；代理只是它的前置 */
async function devServerAlive() {
  try {
    const r = await fetch(`http://localhost:${UPSTREAM_PORT}/`, { method: 'HEAD' })
    return r.ok
  } catch {
    return false
  }
}

// ============================================================
// 变异定义
// ============================================================
//
// 每一条：只改一处，瞄准"被审断言声称要守的那个缺陷"。
// `find` 必须是 **Vite 编译产物里逐字存在**的片段（esbuild 会把单引号换成双引号、
// 把 undefined 换成 void 0、把 6000 压成 6e3 —— 锚点得按编译后的样子写）。
// 代理会统计命中次数，命中 0 次 = 这次变异无效，审计结论作废。

const MUTATIONS = {
  /**
   * 历史缺陷：行标签按"字段表第 2 个字段"取（而不是按当前视图的列序取前两个）。
   *
   * ⚠️ 第三批优化**换过口径**，这条也换过锚点（换锚原因逐字记在这里，别删）：
   *   旧实现 `fields.find((f) => f !== primary && isInformative(f, records))` 已随口径取消而删除，
   *   `--verify-anchors` 报 MISS（出现 0 次）—— 也就是说这条变异当时**已经永远绿了**。
   *   新口径（用户原话「改为行高+当前视图表的前面两个字段内容」）= `fields.slice(0, LABEL_SLOT_COUNT)`，
   *   即"视图前两列，顺序不变、空值也不跳"。于是同一个**缺陷家族**里仍然成立的形状是
   *   **取错了那两列**：取末尾两列 ≠ 视图前两列。
   */
  'label-index': {
    file: '/src/components/wizard/label-fields.ts',
    find: 'return fields.slice(0, LABEL_SLOT_COUNT);',
    repl: 'return fields.slice(-LABEL_SLOT_COUNT);',
    defect: '行标签 = 当前视图的前两列（不是别的两列）',
  },

  /**
   * 事故 ③ 的原始形态：取值层把**字符串**值 JSON.stringify 掉。
   * `JSON.stringify("薇诺娜舒敏保湿特护霜 50g")` → `"薇诺娜舒敏保湿特护霜 50g"`（带一对引号）。
   */
  'render-quote-string': {
    file: '/src/lib/field-types.ts',
    find: 'if (typeof v === "string") return v;',
    repl: 'if (typeof v === "string") return JSON.stringify(v);',
    defect: 'renderCellValue 把字符串值 dump 成带引号的 JSON',
  },

  /** 缺陷 A 的原始形态：富文本片段数组 / 对象值被 dump 成 JSON */
  'render-json-object': {
    file: '/src/lib/field-types.ts',
    find: 'case "text":',
    repl: 'case "text": return JSON.stringify(value); case "~dead~":',
    defect: 'renderCellValue 的 text 分支 dump JSON（对象/富文本形态）',
  },

  /**
   * 反方向：行标签**不再封顶两槽**，把视图里的列全塞进一行
   * （回归成"一屏看不完、还是不知道在看什么"）。
   *
   * 换锚原因同 `label-index`：旧锚点 `function isInformative(f, records) {` 随实现删除而 MISS，
   * 而"要不要按信息量过滤字段"这件事本身已经**不存在了**（新口径不再过滤任何字段，
   * 附件/自动编号/时间该显示就显示）。所以这条的"过度放宽"改成**槽位数不封顶**。
   */
  'label-allowall': {
    file: '/src/components/wizard/label-fields.ts',
    find: 'return fields.slice(0, LABEL_SLOT_COUNT);',
    repl: 'return fields;',
    defect: '一行只显示前两列（不把整张表的列都堆上去）',
  },

  /** 搜索范围扩大到"记录里的所有字段"（与列表显示字段不一致） */
  'search-all-fields': {
    file: '/src/components/wizard/Wizard.tsx',
    // ⚠️ 换锚（本轮）：`值 → 显示` 的口径抽成 label-fields.ts 的 `searchCellText` 之后，
    // 旧锚点内联的 `renderCellValue(r.fields[f.id], f.type).toLowerCase()` 在真实编译产物里
    // 出现 **0 次** —— 也就是说这条变异从那次重构起就**再也不会应用**，
    // 它下面的读数全是假的（假绿）。这一行的语义没变，只换了写法。
    find: 'labelFields.some((f) => searchCellText(r.fields[f.id], f.type).includes(needle))',
    // 第一版写成 `Object.keys(r.fields).map(...).toLowerCase()` —— 那个版本会把应用打崩
    // （附件值是数组，用 void 0 当类型渲染出来的东西不一定有 toLowerCase），只跑到 9 条断言，
    // B10/B11 根本判不了。这一版只**放宽范围**、不动类型，稳定且正中缺陷：
    // 附件文件名也能搜到 = "搜索范围 ≠ 列表显示字段"。
    repl:
      'labelFields.some((f) => searchCellText(r.fields[f.id], f.type).includes(needle)) || JSON.stringify(r.fields).toLowerCase().includes(needle)',
    defect: '搜索范围 ≠ 列表显示字段（附件文件名也能搜到）',
  },

  /** 六条读取路径的区分全丢：取消/空/抛错/不支持 一律当成成功 */
  'rs-outcome-always-ok': {
    file: '/src/components/wizard/record-selection.ts',
    find: 'function toOutcome(source, settled) {',
    repl: 'function toOutcome(source, settled) { return { status: "ok", source, ids: ["rec_x"] };',
    defect: '读取选中记录的成败/取消/空/不支持 不再区分',
  },

  /** 提示语不再说人话：失败与取消变静默（正是"异常路径没被测过"栽过三次的那类） */
  'hint-silent': {
    file: '/src/components/wizard/record-selection.ts',
    find: 'function outcomeHint(o, what = "记录") {',
    repl: 'function outcomeHint(o, what = "记录") { return { ok: !!(o && o.status === "ok"), text: "" };',
    defect: '异常/取消路径静默（用户点了没反应）',
  },

  /** 编辑器：双击单元格不再进入就地编辑（其余一切不变，包括点选切换面板） */
  'cell-edit-off': {
    file: '/src/components/editor/Canvas.tsx',
    find: 'beginEditing(el.id, c.id, nodesToText(c.nodes));',
    repl: 'void 0;',
    defect: '双击单元格进入就地编辑',
  },

  /** 编辑器：点单元格不再把属性面板切到「单元格」上下文 */
  'cell-select-off': {
    file: '/src/components/editor/Canvas.tsx',
    find: 'onSelectCell(el.id, c.id);',
    repl: 'void 0;',
    defect: '点单元格 → 属性面板切到单元格上下文',
  },

  /**
   * 受控回流被打断：编辑器每次提交都只把"旧 doc"回传给宿主 ——
   * 宿主拿着永不更新的 doc 再传回来，画布永远画原件（表现：拖动/增删/改字全都没反应）。
   */
  'doc-no-reflow': {
    file: '/src/components/editor/useEditorState.ts',
    find: 'const commit = useCallback((next, mergeKey) => {',
    repl: 'const commit = useCallback((next, mergeKey) => { onChangeRef.current(docRef.current); return;',
    defect: '编辑结果经 onChange 回流成新的受控 doc',
  },

  /** 打印产物渲染失败：buildDocumentHtml 返回空串 → 预览 iframe 里一张纸都没有 */
  'preview-empty': {
    file: '/src/render/html.ts',
    find: 'function buildDocumentHtml(',
    repl: 'function buildDocumentHtml(...__a) { return ""; }\nfunction __unused_buildDocumentHtml(',
    defect: '打印产物真的被渲染出来（iframe 里有纸张页与 @page 规则）',
  },




  /**
   * 反方向「过度收紧」：行标签只留一个槽（用户要的是"前面**两个**字段"，少一列就不知道在看什么）。
   *
   * 换锚原因：旧锚点 `fields.find((f) => f !== primary && isInformative(f, records))` 已 MISS。
   * 新形态直接打**槽位数**这个常量 —— 它正是"两个字段"这句话在代码里的唯一落点。
   */
  'label-onlyprimary': {
    file: '/src/components/wizard/label-fields.ts',
    find: 'export const LABEL_SLOT_COUNT = 2;',
    repl: 'export const LABEL_SLOT_COUNT = 1;',
    defect: '固定两槽（"前两个字段"不能只给一个）',
  },

  /** 读取路径的"挂住"不再被截止：所有调用都立刻当成成功返回 */
  'rs-deadline-broken': {
    file: '/src/components/wizard/record-selection.ts',
    find: 'function withDeadline(p, ms) {',
    repl: 'function withDeadline(p, ms) { return Promise.resolve({ settled: true, ok: true, value: ["rec_x"] });',
    defect: '宿主不回应时必须判为 timeout，不能假装成功',
  },

  /**
   * 所有 "不支持的接口" 分支都改报成"没选中任何记录"（冒充另一种状态）。
   * 第一版是把它们改成 `status: "ok"` —— 那个版本会让 outcomeHint 读 undefined.length 直接抛错，
   * 探针脚本只跑到 31 条断言就崩了，D 组大半判不了。这一版同样能打中"没这个接口必须如实说'不支持'"
   * 这个缺陷，但不会把被测程序打崩，读数可比。
   */
  'rs-no-unsupported': {
    file: '/src/components/wizard/record-selection.ts',
    find: 'status: "unsupported"',
    repl: 'status: "empty"',
    all: true,
    defect: '没有该接口时必须如实说"不支持"，不能既报别的状态、也不给原因',
  },

  /** 能力边界说明与失败并列说明都变空（界面上什么都不说） */
  'note-blank': {
    file: '/src/components/wizard/record-selection.ts',
    find: 'function capabilityNote(capability) {',
    repl: 'function capabilityNote(capability) { return "";',
    defect: '界面底部如实说明能力边界',
  },
  'chain-fail-blank': {
    file: '/src/components/wizard/record-selection.ts',
    find: 'function chainFailureText(chain) {',
    repl: 'function chainFailureText(chain) { return "";',
    defect: '两级都读不到时把两条原因并列说给用户',
  },

  /**
   * 行标签的**第一格不是视图第 1 列**（两槽顺序被弄反 → 主/副格错位）。
   *
   * ⚠️ 换锚原因（这条是 team-lead 没点名、我实测发现的第 4 个 MISS）：
   *   旧锚点 `const primary = fields.find((f) => f.isPrimary) ?? fields[0];` 随实现删除而失效。
   *   **旧缺陷形状本身已经不存在了**：旧口径要"按 isPrimary 挑主字段，忽略字段表下标"，
   *   而新口径按用户原话「当前视图表的前面两个字段」取列 —— `isPrimary` 根本不参与判定，
   *   所以"该按 isPrimary 选却取了第 0 个"这件事在新实现里**无法被做错**。
   *   留着一个无法生效的锚点 = 假绿（正是这次要清的那一族）。
   *   改成同一诉求（"第一格必须是视图第一列"）下仍然成立的形状：**列序被反转**。
   */
  'label-nonprimary': {
    file: '/src/components/wizard/label-fields.ts',
    find: 'return fields.slice(0, LABEL_SLOT_COUNT);',
    repl: 'return fields.slice(0, LABEL_SLOT_COUNT).reverse();',
    defect: '第一格 = 当前视图第 1 列（两槽顺序不被反转）',
  },

  /** 搜索框的占位符与实际匹配范围脱节（不再说明"按哪些字段匹配"） */
  'placeholder-hardcoded': {
    file: '/src/components/wizard/Wizard.tsx',
    find: 'placeholder: labelFields.length > 0 ? `搜索记录（按 ${searchScope} 匹配）` : "搜索记录",',
    repl: 'placeholder: "搜索记录",',
    defect: '搜索框如实说明匹配范围（不会"看得到搜不到"）',
  },

  /** 元素面板里的二维码 / 条形码条目整组拿掉 */
  'palette-no-code': {
    file: '/src/components/editor/Palette.tsx',
    find: 'const CODE_DEFS = [',
    repl: 'const CODE_DEFS = []; const __dead_code_defs = [',
    defect: '元素面板真的提供二维码 / 条形码',
  },

  /**
   * 属性面板里那句"在画布上点选某个单元格"的引导**整段消失**（用户再也不知道单元格能点）。
   *
   * 这条变异专门用来压 editor-cell-edit 的
   * 「点单元格后面板切到单元格上下文（原有的"请点选单元格"引导消失）」——
   * 它的**正面主张**（面板切到单元格）是有据的，但它拿来当证据的那半句是**否定式**的
   * （引导"消失"了）。否定式证据有个天然缺陷：引导**从来就没出现过**时它也成立。
   * 把引导删掉之后，这条断言**依然是绿的** —— 这就是那半句的极限。
   */
  'hint-gone': {
    file: '/src/components/editor/Inspector.tsx',
    find:
      'children: "在画布上点选某个单元格 → 面板会切到该单元格（改内容、绑字段、合并拆分、内边距、底纹）； 双击单元格可直接打字。选中后按 Esc 或点面包屑上的「表格」回到这里。"',
    repl: 'children: "（这段引导被拿掉了）"',
    defect: '属性面板如实把"单元格可以点"告诉用户（否则用户根本不知道有这个入口）',
  },


  /**
   * 循环区「多记录并成一张大表」的**渲染侧判定**整个失效：
   * 声明了 rowsFromRecords 的循环表不再合并，退回"每条记录一张小表"。
   * 这是本项目最核心那条特性（也是第 16 / 21 / 22 号任务的全部内容）。
   */
  'loop-merge-off': {
    file: '/src/render/pipeline.ts',
    find: 'return el.kind === "table" && el.rowsFromRecords === true;',
    repl: 'return false;',
    defect: '声明了 rowsFromRecords 的循环表真的被并成一张跨记录/跨页连续大表',
  },

  // ══════════════════════════════════════════════════════════════════════
  // 任务 7（顶栏工具栏 / 横纵向 / 页内预览 / 字段节点字体 / 系统变量）四组定向变异
  //
  // 这四组是**故意成对**设计的，用来把"两侧各管各的"证明出来：
  //   · `font-render-drop` 只切断**产物**那一侧（画布照旧带楷体）
  //   · `font-canvas-drop` 只切断**画布**那一侧（产物照旧带楷体）
  // 如果两组都只让各自的断言变红、另一侧全绿，就说明那两组断言**真的在量两件不同的事**，
  // 而不是"两边都读同一个数，所以一起红一起绿"。
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 1a. **产物侧**的"节点级字体"通路整个切断。
   *
   * `src/render/html.ts` 的 `inlineCss()` 是节点样式 → 打印产物 span 上 `font-family` 的唯一出口。
   * 切掉它，画布那一枚 chip 仍然带 `font-family: "KaiTi", var(--font-sans)`（那是 Canvas.tsx 的
   * `nodeCss` 画的），但打印产物里 `font-family:KaiTi` 会变成 0 个。
   */
  'font-render-drop': {
    file: '/src/render/html.ts',
    find: '  if (s.fontFamily && s.fontFamily !== "system") parts.push(`font-family:${s.fontFamily}`);',
    repl: '  if (false) parts.push(`font-family:${s.fontFamily}`);',
    defect: '节点级字体真的到达打印产物（html.ts inlineCss 那条通路）',
  },

  /** 1b. **画布侧**的"节点级字体"通路切断（产物那一侧照旧） */
  'font-canvas-drop': {
    file: '/src/components/editor/Canvas.tsx',
    find: '  if (s.fontFamily) out.fontFamily = fontCss(s.fontFamily);',
    repl: '  if (false) out.fontFamily = fontCss(s.fontFamily);',
    defect: '节点级字体真的到达画布那一枚 chip（Canvas.tsx nodeCss 那条通路）',
  },

  /**
   * 2a. 页内预览拿到的是**空的**渲染产物 —— 直接复用上面那条 `preview-empty`
   * （`buildDocumentHtml` 返回空串），不另立一条：同一个缺陷用同一个变异，
   * 这样 editor-interaction 与 e2e-smoke 两处读数才可比。
   */

  /**
   * 2b. 预览**不读当前 doc 的 pageSetup**，改读一份"另一份快照"（写死 A4 纵向）。
   *
   * 这条回答的是"预览到底看的是谁"：它把 `renderDocument` 的入参 `doc` 换成一份
   * 方向/尺寸被钉死的副本。如果"预览的页尺寸跟着刚才切的横向走"那条断言**因此变红**，
   * 就证明它读的确实是当前 doc，而不是恰好蒙对。
   */
  'preview-snapshot': {
    file: '/src/components/editor/preview.ts',
    find: '  const rendered = await renderDocument({\n    doc,',
    repl:
      '  const rendered = await renderDocument({\n' +
      '    doc: { ...doc, pageSetup: { ...doc.pageSetup, orientation: "portrait", widthMm: 210, heightMm: 297 } },',
    defect: '页内预览读的是**当前这份 doc** 的 pageSetup（不是另一份快照）',
  },

  /**
   * 3. 横 / 纵向**只点了按钮、没写进 doc**：`setPageSetup` 照常被调用、照常 commit，
   * 但写进去的 orientation 永远是旧值 —— 也就是"按钮点了没反应"。
   *
   * 注意这是**最保守**的一种写法：不动其它 pageSetup 字段（纸张/网格/吸附照旧能改），
   * 只把 orientation 这一项钉死，因此能更精确地定位到"方向"这条链路。
   */
  'orient-ui-only': {
    file: '/src/components/editor/useEditorState.ts',
    find: '      commit({ ...cur, pageSetup: { ...cur.pageSetup, ...patch } });',
    repl: '      commit({ ...cur, pageSetup: { ...cur.pageSetup, ...patch, orientation: cur.pageSetup.orientation } });',
    defect: '横/纵向切换真的写进 doc.pageSetup（不是只点了一下按钮）',
  },

  /**
   * 4a. 「显示总页数」开关**不生效**：合并形态永远带「共 N 页」那半句。
   * 断言是"关掉之后产物里只剩「第 X 页」" —— 变红才算数。
   */
  'sysvar-hidetotal-off': {
    file: '/src/render/html.ts',
    find: '      return node.hideTotal === true ? `第 ${TOK_PAGE_NO} 页` : `第 ${TOK_PAGE_NO} 页 / 共 ${TOK_PAGE_COUNT} 页`;',
    repl: '      return `第 ${TOK_PAGE_NO} 页 / 共 ${TOK_PAGE_COUNT} 页`;',
    defect: '「显示总页数」开关真的到达打印产物',
  },

  /**
   * 4b. 节点上的**时间格式被忽略**：日期永远按默认格式输出。
   * 断言是"选了「星期三」之后产物里真的出现「星期四」" —— 变红才算数。
   */
  'sysvar-format-off': {
    file: '/src/render/html.ts',
    find: '      return resolveTimeVar(ctx.today, node.format, DEFAULT_TODAY_FORMAT);',
    repl: '      return resolveTimeVar(ctx.today, void 0, DEFAULT_TODAY_FORMAT);',
    defect: '「这一处的时间格式」真的到达打印产物',
  },

  /**
   * t8-c. **智能对齐线整个失效**：判定函数不再产出任何线。
   *
   * 落点选 `Canvas.tsx` 的 `guidesFor`（移动与缩放两条路都走它），
   * 而不是渲染那一行 —— 掐判定层 = "这个功能没了"，掐渲染层 = "线算出来但没画"。
   * 两者对 `【对齐线·承重】` 等价（它读的是 DOM 里的 `.bp-guide`），
   * 取更上游的那个，语义更干净：**对齐线判定一次都不产出**。
   *
   * 注意这条变异**只影响画线、不影响吸附**（`guidesFor` 的返回值只喂给 `setGuides`，
   * 吸附由网格那条路 `snapMm` 负责）—— 所以它是一次"只掐对齐线"的定向变异，
   * 不会把别的读数搅浑。
   */
  'align-guides-off': {
    file: '/src/components/editor/Canvas.tsx',
    find: '      return dedupeGuides(computeGuides({ moving: box, others }).guides);',
    repl: '      return [];',
    defect: '拖动时真的会画出智能对齐线（不是"判定完就丢掉"）',
  },

  /**
   * t9-a. **列宽改了、元素总宽 `w` 忘了同步**（打破 E-45 的约束）。
   *
   * `setColWidthPatch` 是**三个入口共用的那一份**（画布拖列边框 / 右栏列宽输入框 / 其它调用方），
   * 所以这一处错、三处一起错 —— 这正是"把变异打在共享函数上"比打在调用点更值的地方。
   *
   * 症状：画布上这一列看得见地变宽了，但元素总宽还是旧值 → 表格右边缘与 `w` 脱节，
   * 打印产物的列宽占比与画布对不上。
   */
  'colwidth-w-desync': {
    file: '/src/components/editor/table-actions.ts',
    find: 'return { colWidthsMm: next, w: round1(next.reduce((a, b) => a + b, 0)) };',
    repl: 'return { colWidthsMm: next, w: el.w };',
    defect: '改列宽时元素总宽 w 与列宽数组之和保持同步（E-45）',
  },

  /**
   * t9-b. **行高拖到下限时「钳成 6mm」，而不是换态成「自适应」**。
   *
   * `Canvas.tsx` 这一行是**拖动**这条路的换态点（`mm < MIN_ROW_MM ? void 0 : round1(mm)`）。
   * 改成"取 max"就复现了那条被点名排除的缺陷形态：那一行永远是 6mm，**再也长不回去**、
   * 内容溢出 —— `table-actions.ts:228` 的注释逐字写了这件事。
   *
   * 注意这条变异**只打"拖动"这一条路**：双击复位走 `onRowBorderReset`（直接传 `undefined`，不经过这里），
   * 所以 `【双击行边框】` 在这条变异下**应当仍然绿** —— 那正好是"两条路通向同一终态"的对照实验。
   */
  'rowheight-floor-clamp': {
    file: '/src/components/editor/Canvas.tsx',
    find: 'const p = setRowHeightPatch(el, index, mm < MIN_ROW_MM ? void 0 : round1(mm));',
    repl: 'const p = setRowHeightPatch(el, index, Math.max(MIN_ROW_MM, round1(mm)));',
    defect: '拖行高到下限以下时换态成「自适应」，而不是把行高钳在下限值',
  },

  /**
   * t10-a. **兜底 `default:` 分支 dump JSON**（收网后 team-lead 点名的"阴性对照"）。
   *
   * ✅ 第六轮：**已由 Node 级装置复验完毕**（装置 `.shots/_mut-node-run.mjs`，读数 `.shots/_mut-node-run-*.txt`，
   *    报告 §10）。此处**仅保留缺陷形状登记，不挂浏览器相位** —— t10/t11 相位已删（原因见 PLAN 末尾）。
   *
   * ⚠️ 但这条变异**打在一条运行时不可达的分支上** —— 机械核对见
   * `.shots/_t10-reachability.txt`：`renderCellValue` 的 switch **覆盖了 `RenderKind`
   * 联合的全部 11 个取值**（text / number / date / select / person / checkbox /
   * attachment / link / progress / rating / currency），而 `renderKind` 只有两个来源
   * （`FIELD_TYPES` —— 全部经 `M(...)` 构造 —— 与 `UNKNOWN`），两者都在这个联合里。
   * ⇒ **`default:` 是死代码，改它改变不了任何行为。**
   *
   * 所以它跑出来"0 条变红"**不能**读作"断言层对这个口子是敞着的" ——
   * 那是把"**缺陷无法显现**"记到了"**断言看不见**"的账上。按本项目自己的规矩，
   * 这份读数**作废**：代理命中了字符串，却没命中**会执行的代码** ——
   * 比"命中 0 次"更隐蔽的一种失效（命中计数是 1，看起来完全正常）。
   *
   * 保留它，因为它本身是一条证据：**"变异命中"与"变异生效"是两件事**。
   * 真正回答"断言层抓不抓得住 dump JSON"的是已有那条 `render-json-object`（`case "text":`）。
   */
  'default-dump-json': {
    file: '/src/lib/field-types.ts',
    find: 'default:\n      return anyText(value);',
    repl: 'default: return JSON.stringify(value);',
    defect: '兜底 default 分支 dump JSON（**注意：该分支运行时不可达**）',
  },

  /**
   * t10-b. **日期兜底分支 dump JSON**（team-lead 修正后的活靶点 ①）。
   *
   * ✅ 第六轮：**已由 Node 级装置复验完毕**（装置 `.shots/_mut-node-run.mjs`，读数 `.shots/_mut-node-run-*.txt`，
   *    报告 §10）。此处**仅保留缺陷形状登记，不挂浏览器相位** —— t10/t11 相位已删（原因见 PLAN 末尾）。
   *
   * 与 `default-dump-json` 的关键差别：这条打在**活分支**上。
   * `case "date"` 是 `RenderKind` 11 个取值之一，字段类型里的
   * 创建时间 / 修改时间 / 日期 全都落到这里；
   * `if (!Number.isFinite(ms))` 这一支在**控制流上可达**（机械提取见
   * `.shots/_t10-anytext-sites.txt`：8 个 anyText 调用点里，7 个在活路径上，
   * 这条是其中之一；第 8 个才是死的 `default:`）。
   *
   * 锚点唯一性：`ms` 只出现在 date 分支，`if (!Number.isFinite(ms)) return anyText(value);`
   * 在编译产物里**恰好 1 次**（`Number.isFinite(n)` 另有 4 处，但变量名不同）。
   *
   * 读数怎么读（**两种结果都有信息**）：
   *   · 跑红 → 这条兜底**确实被真实数据喂到**，而且有断言连带察觉到 —— 双重收获；
   *   · 跑绿 → 控制流可达但**本次覆盖没喂到它**，按本项目口径记「**本轮没有证据**」，
   *            **不是**"断言层装饰"。这两者必须分清（这正是 default-dump-json 教的那件事）。
   */
  'date-fallback-dump-json': {
    file: '/src/lib/field-types.ts',
    find: 'if (!Number.isFinite(ms)) return anyText(value);',
    repl: 'if (!Number.isFinite(ms)) return JSON.stringify(value);',
    defect: '日期字段拿到非数值（对象 / 数组 / 非法串）时 dump JSON',
  },

  /**
   * t10-c. **关联/网址字段的"只剩 recordIds"兜底 dump JSON**（team-lead 的活靶点 ②）。
   *
   * ✅ 第六轮：**已由 Node 级装置复验完毕**（装置 `.shots/_mut-node-run.mjs`，读数 `.shots/_mut-node-run-*.txt`，
   *    报告 §10）。此处**仅保留缺陷形状登记，不挂浏览器相位** —— t10/t11 相位已删（原因见 PLAN 末尾）。
   *
   * `case "link"` 里那个内部 `one(v)`：对象既没有 `text` 也没有 `link` 时，
   * 源码给的是 `return scalarText(v)` / `return ""`（"印一串 open_id 比印空更糟"那条注释
   * 就在隔壁的 person 分支）。这条变异把 link 分支的**该类兜底**改成 dump JSON ——
   * 复现"关联字段只带 recordIds 时，纸面上出现 `{"recordIds":[…]}`"。
   *
   * ⚠️ 锚点为什么不用 `return one(value);`：它在编译产物里出现 **3 次**
   * （select / person / link 三个分支同形）—— 只换第一处会打到 select 上去。
   * 所以用 link 分支独有的 `o.link` 那一行 + 其后两行一起做锚点，**唯一性由那行保证**。
   * （这就是 §6 第 19 条"找到第一处 ≠ 找到那一处"在锚点上的用法。）
   */
  'link-records-dump-json': {
    file: '/src/lib/field-types.ts',
    find: 'if (typeof o.link === "string") return o.link;\n        }\n        return "";',
    repl: 'if (typeof o.link === "string") return o.link;\n        }\n        return JSON.stringify(v);',
    defect: '关联 / 网址字段只剩 recordIds 时 dump JSON',
  },

  /**
   * ⑦b 的靶：把「完成」那一步的**落库**整段挖掉（`commitEditor` 里那次 `store.saveTemplate`）。
   * `if (false)` 让它永不执行，编辑器其余行为一字不变 —— 若 ⑦b 仍绿，
   * 说明那条"闭环"什么都没守（它本该一次守住四件事：**调了**、写的是**同一条**、
   * 表里**没多出一条**、落进去的内容**变长**了）。
   *
   * 实测（本组自己的跑器）：`test/e2e-smoke.mjs` → `PASS_COUNT=46 FAIL_COUNT=1`，
   * 红的正是 `⑦b 闭环 …`，而 `⑦b 前提…`（观测装置还挂着）**仍绿** ——
   * 证明变的是"有没有写库"，不是"钩子没装上"。
   *
   * 归一：`_r4-spec-7b.json`（重跑：`node _r4-mutrun.mjs '_r4-spec-7b.json' test/e2e-smoke.mjs`）。
   */
  'wizard-save-not-called': {
    file: '/src/components/wizard/useWizardState.ts',
    find: '    await store.saveTemplate({\n      recordId: active.recordId,',
    repl: '    if (false) await store.saveTemplate({\n      recordId: active.recordId,',
    defect: '编辑器里「完成」之后，"那一条"模板的内容真的被改写（调了 + 同一条 + 没多出一条 + 内容变长）',
  },

  /**
   * ⚠️ **阴性对照（不是靶）**：把 mock 的附件列挪到**视图第 2 列**。
   *
   * **期望 = 0 条红。** 它验的不是"某个行为坏了"，而是**期望来源已与列序解耦**：
   * 用户把附件列排到前面，列表就**该**显示文件名 —— 这是正确行为，不是缺陷。
   *
   * 为什么需要它（它是一条**回归钉**）：
   *   · 收口**前**，这些断言的期望被写死成"前两列 = 单据编号 / 产品名称"，
   *     同一条变异会压红 **8 条**（`_r4-8-m1-oldb4.txt`：`71/8`，红 =
   *     B4 / B8 / B8b / B10 / B11 / B15 / B16 / B17）—— 那是**假红**，
   *     因为产品侧一行没改、产品行为并没有错；
   *   · 收口**后**（期望改成从 fixture 现算），同一条变异 `79/0`，而且**派生读数自己跟着变了**
   *     （`_r4-9-m1.txt`：`视图第 1/2 列 = 单据编号 / 附件；记录 1 的副格 = "photo_1_1.png"；
   *     附件列在前两列内 = true`）—— 这才是"期望是算出来的"，不是"换个字面量再写死一次"。
   *
   * ⚠️ **不给它挂 `targets`**（这一句是这条登记的关键，别"顺手补上"）：
   *   机械规则是"被瞄准了却仍绿 ⇒ 装饰"。一条**本该 0 红**的变异一旦挂上
   *   `targets: [/^A6/, /^B4/, /^B8/, /^B11/, /^B15/]`，它会报
   *   "这些断言在一个瞄准它们的变异下仍然绿" ⇒ 判成 **「装饰」**。
   *   而这 4 条恰恰是刚修好的（它们绿，是因为**期望与列序解耦**，正是修的目的）——
   *   挂 targets 等于**拿修复去自证装饰**，会**凭空造出 4 条假"装饰"**；
   *   而"装饰"在台账里**是要人出面处理的**，假的那一批会白耗一轮。
   *   ⇒ 它只作阴性对照：`targets` 缺省（`runScript` 里 `p.targets ?? []`），
   *     被它覆盖的断言一律记「未涉及」——这正是"没瞄准它"的如实说法。
   *
   * 归一：`_r4-spec-8-m1.json`（重跑：`node _r4-mutrun.mjs '_r4-spec-8-m1.json' test/range-picker.mjs`）。
   */
  'mock-attach-2nd': {
    file: '/src/lib/mock-source.ts',
    find: '  { id: "fld_title", name: "',
    repl: '  { id: "fld_photo", name: "附件", type: FT.Attachment },\n  { id: "fld_title", name: "',
    defect: '阴性对照：这份数据下"列序说了算"的口径必须原样成立（期望不该被列序改写）—— 期望 0 条红',
  },
}

// ============================================================
// 运行计划：哪些脚本在哪些变异下跑
// ============================================================

/**
 * `targets` 极重要：**只有被这条变异"瞄准"的断言才允许判定**。
 * 一条断言在这次变异下不变红，可能只是"这条变异跟它无关" —— 那不是装饰。
 * 把它算成装饰，就是审计自己在制造假结论。未命中 targets 的断言记作「未涉及」。
 *
 * 定 targets 的规则（**先于**看读数就定死，不能看到"它红了"再把某个变异收进 targets）：
 *   当且仅当这条断言的**声明主体**正是该变异改变的那个行为时，才算瞄准。
 *   "在某些数据下才可能被触发"不算 —— 那属于"覆盖不足"，另行在报告里说明。
 * 注意 targets 宽窄只影响"未涉及 → 装饰"这一个方向：
 *   一条已经因别的变异变红的断言，再加宽它的 targets 也不会改变它的结论（仍是承重）。
 */
/**
 * 第三批（行标签口径改成「当前视图前两列」）之后的 targets。
 *
 * 划法沿用上面的老规矩：**这条断言的声明主体**必须是该变异改变的那个行为。
 * 旧口径下的 LABEL_2ND / LABEL_FILTER 已经作废（它们瞄的是 A1/A2/A4/A5/A6/A9，
 * 而 A 组现在量的是"列序说了算"，语义换了、编号沿用）。
 */
const LABEL_PICK = [/^A1\b/, /^A2\b/, /^A3\b/, /^A5\b/, /^A6\b/, /^A9\b/] // 主体是"取到的是哪两列"
const LABEL_WIDE = [/^A1\b/, /^A9\b/] // 主体是"槽位封顶"（不封顶时列会多出来）
const LABEL_SLOTS = [/^A0\b/, /^B6\b/] // 主体是"槽位数 / 每行两格"
const LABEL_ORDER = [/^A1\b/, /^A2\b/, /^A3\b/, /^A5\b/] // 主体是"第一格必须是视图第 1 列"
const RENDER_TEXT = [/^A7\b/, /^B5\b/, /^B8b\b/] // 主体是"渲染出来的字面长什么样"

/**
 * `search-all-fields` 的 targets 只能写**声明主体就是"匹配范围"**的那一条。
 *
 * 为什么收紧（第三批实测）：这一条原来写着 `[/^B7\b/, /^B10\b/, /^B11\b/]`，跑出来 B10
 * 与「B11 前提」都是「装饰」——**不是断言没牙，是 targets 划宽了**（审计自己造假结论那一族）：
 *   · B7「搜索框的匹配范围与列表显示的字段一致」量的是**占位符文案**（它由 placeholder-hardcoded
 *     那条变异负责，实测变红 ✓），把范围放宽并不会改占位符；
 *   · B10「搜索还能用第二个字段的关键词命中」量的是**正向命中**，放宽范围只会命中更多，
 *     它天然抓不到"放宽"这件事；
 *   · B11 前提量的是**固定装置里有没有那个附件名**，与匹配范围无关。
 * 真正声明"附件不在匹配范围里"的只有 B11【反向对照】，实测在 `search-all-fields` 下变红 ✓。
 */
const SEARCH_SCOPE = [/^B11【反向对照】/]
// D 组逐条按"这条断言读的是哪条链路"划 targets —— 六条读取路径各有各的分支，
// 一条变异只可能压到走那条分支的断言。划宽了就会把"够不到"误算成"装饰"。
const D_SETTLE = [/^D[1-4]\b/, /^D[7-9]\b/, /^D13\b/, /^D14\b/, /^D15\b/, /^D17\b/, /^D19\b/, /^D24\b/, /^D25\b/, /^D27\b/]
const D_DEADLINE = [/^D[1-5]\b/, /^D[7-9]\b/, /^D10\b/, /^D1[3-7]\b/, /^D19\b/, /^D2[1-5]\b/, /^D27\b/, /^D3[45]\b/]
const D_HINT = [/^D1[4-9]\b/, /^D2[1-5]\b/, /^D28\b/]
const D_UNSUPPORTED = [/^D6\b/, /^D11\b/, /^D12\b/, /^D18\b/, /^D20\b/, /^D23\b/]

const PLAN = [
  // ---- range-picker（最便宜，先拿它把装置跑通）----
  { phase: 'quick', script: 'range-picker.mjs', mut: null, note: '基线' },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'label-index', targets: LABEL_PICK },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'render-quote-string', targets: RENDER_TEXT },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'render-json-object', targets: RENDER_TEXT },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'label-allowall', targets: LABEL_WIDE },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'label-onlyprimary', targets: LABEL_SLOTS },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'search-all-fields', targets: SEARCH_SCOPE },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'rs-outcome-always-ok', targets: D_SETTLE },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'rs-deadline-broken', targets: D_DEADLINE },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'rs-no-unsupported', targets: D_UNSUPPORTED },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'hint-silent', targets: D_HINT },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'note-blank', targets: [/^D20\b/, /^D23\b/] },
  { phase: 'quick', script: 'range-picker.mjs', mut: 'chain-fail-blank', targets: [/^D21\b/, /^D28\b/] },

  // ---- 补充：把"同源期望值"和"存在性"两类也压一次 ----
  { phase: 'quick2', script: 'range-picker.mjs', mut: null, note: '基线' },
  { phase: 'quick2', script: 'range-picker.mjs', mut: 'placeholder-hardcoded', targets: [/^B7\b/] },
  { phase: 'quick2', script: 'range-picker.mjs', mut: 'label-nonprimary', targets: LABEL_ORDER },

  // ══════════════════════════════════════════════════════════════════════
  // labels3（第三批优化收口）：行标签口径换成「当前视图前两列」之后，
  // 四个锚点**全部换过位**（旧锚点全部 MISS = 已经永远绿），这一相位是换完之后的实测。
  //
  // 为什么单独开一个相位而不是塞回 quick/quick2：
  //   1) targets 的语义随口径一起换了（旧 LABEL_2ND/LABEL_FILTER 作废），混在旧相位里
  //      会让"这一批读数到底按哪版 targets 判的"说不清；
  //   2) 一次基线 + 6 个变异 = 一屏可读、一遍跑完，读数可比。
  // 顺带把 team-lead 以为坏了、其实**没坏**的两条（search-all-fields / placeholder-hardcoded）
  // 也在同一基线里复测一遍 —— 它们的锚点哈希没变，读数应当与旧相位一致。
  // ══════════════════════════════════════════════════════════════════════
  { phase: 'labels3', script: 'range-picker.mjs', mut: null, note: '基线（行标签=视图前两列的新口径断言）' },
  { phase: 'labels3', script: 'range-picker.mjs', mut: 'label-index', targets: LABEL_PICK },
  { phase: 'labels3', script: 'range-picker.mjs', mut: 'label-allowall', targets: LABEL_WIDE },
  { phase: 'labels3', script: 'range-picker.mjs', mut: 'label-onlyprimary', targets: LABEL_SLOTS },
  { phase: 'labels3', script: 'range-picker.mjs', mut: 'label-nonprimary', targets: LABEL_ORDER },
  { phase: 'labels3', script: 'range-picker.mjs', mut: 'search-all-fields', targets: SEARCH_SCOPE },
  { phase: 'labels3', script: 'range-picker.mjs', mut: 'placeholder-hardcoded', targets: [/^B7\b/] },

  // ══════════════════════════════════════════════════════════════════════
  // wizardr4（向导 / 勾选组的收口相位）：两条新登记的变异，**一正一负**。
  //
  // 为什么单独开一个相位而不是塞回 quick / rest：
  //   本批只需要 4 次运行（2 个脚本各一条基线 + 各一条变异）。塞进 quick 会把那一整
  //   相位的十几次运行连着重跑一遍，读数还混在一起。单独一相位 = 一屏可读、一遍跑完。
  //
  // 两条的性质完全不同（这一点必须写在计划里，不能只藏在 MUTATIONS 的注释里）：
  //   1) `wizard-save-not-called` —— **正常靶**：瞄 ⑦b 闭环。期望"该红的红、不该红的绿"。
  //   2) `mock-attach-2nd`       —— **阴性对照**：期望 **0 条红**，**故意不挂 `targets`**。
  //      （理由见 MUTATIONS 里那条的长注释：给"本该 0 红"的变异挂 targets，
  //        机械规则会把被瞄准的断言判成「装饰」—— 那是拿修复去自证装饰。）
  //      ⇒ 本相位里 range-picker 的断言应**全部**落在「未涉及」，**不得出现新的「装饰」**。
  // ══════════════════════════════════════════════════════════════════════
  { phase: 'wizardr4', script: 'range-picker.mjs', mut: null, note: '基线（阴性对照必须与基线同版才可比）' },
  { phase: 'wizardr4', script: 'range-picker.mjs', mut: 'mock-attach-2nd' },
  { phase: 'wizardr4', script: 'e2e-smoke.mjs', mut: null, note: '基线' },
  { phase: 'wizardr4', script: 'e2e-smoke.mjs', mut: 'wizard-save-not-called', targets: [/^⑦b 闭环/] },

  // ---- editor-cell-edit ----
  { phase: 'editor', script: 'editor-cell-edit.mjs', mut: null, note: '基线' },
  { phase: 'editor', script: 'editor-cell-edit.mjs', mut: 'cell-edit-off', targets: [/双击后出现就地编辑控件/, /双击后有可编辑控件出现/] },
  { phase: 'editor', script: 'editor-cell-edit.mjs', mut: 'cell-select-off', targets: [/面板切到单元格上下文/, /面板里出现单元格专属控件/] },

  { phase: 'editor2', script: 'editor-cell-edit.mjs', mut: null, note: '基线' },
  { phase: 'editor2', script: 'editor-cell-edit.mjs', mut: 'palette-no-code', targets: [/二维码/, /条形码/] },

  // ---- 定点补测：否定式「证据」的极限（引导文案整段消失）----
  { phase: 'probe', script: 'editor-cell-edit.mjs', mut: null, note: '基线' },
  { phase: 'probe', script: 'editor-cell-edit.mjs', mut: 'hint-gone', targets: [/面板切到单元格上下文/] },

  // ---- 其余脚本：基线 + 一条定向变异（预算所限，各挑最可疑的那一条）----


  // 重跑专用：doc-no-reflow 的变异目标是 useEditorState.ts，而它正被并行队友改写，
  // 上一次窗口里它的哈希变了 —— 单独再跑一遍，看能不能拿到一个干净的窗口。

  { phase: 'rest', script: 'e2e-smoke.mjs', mut: null, note: '基线' },
  { phase: 'rest', script: 'e2e-smoke.mjs', mut: 'preview-empty', targets: [/预览/, /iframe/, /纸张/, /@page/] },

  // loop-table-browser 自己内置了对照 A/B（把开关关掉、断言必须翻转）——
  // 那是脚本内的受控实验；但"对照 A"只压住了**开关**这条链路，
  // 压不住**渲染侧**（开关开着时到底有没有真的合并），所以额外加一条渲染侧变异。
  { phase: 'rest', script: 'loop-table-browser.mjs', mut: null, note: '基线' },
  {
    phase: 'rest',
    script: 'loop-table-browser.mjs',
    mut: 'loop-merge-off',
    targets: [/循环区元素下 <table> 数 = 1/, /循环 <table> 总数 = 页数/, /续排片段/, /改造生效/],
  },


  // ⛔ 这里原来还有一组 `wire` 相位的条目（针对 `editor-window-wiring.mjs` 的硬编码 BASE 问题）。
  //    该脚本随"独立窗口编辑"整体删除（2026-09-21），条目连同它的说明一并撤掉。

  // ⛔ `paste` / `paste2` 两个相位的条目（针对 `paste-roundtrip.mjs` 的畸形输入组）已撤掉：
  //    该脚本与它测的「粘贴编辑结果」面板随"独立窗口编辑"整体删除（2026-09-21）。
  //    结论本身仍然成立、也仍值得记住（写在别处）：**给一组断言加个"前提控制"**，
  //    否则"面板不在场"时那一整段否定式读数会**照样绿**，看不出是装饰还是没牙。

  // 重跑专用：e2e-smoke 的两条"层级错位"已做层级修正（把测量挪进 iframe / 两边对上），
  // 复核它们是否长出了牙齿。e2e-smoke 很快（单次约 11s），单独跑一轮。
  { phase: 'e2e', script: 'e2e-smoke.mjs', mut: null, note: '基线（层级修正后重跑）' },
  { phase: 'e2e', script: 'e2e-smoke.mjs', mut: 'preview-empty', targets: [/预览/, /iframe/, /纸张/, /@page/] },

  // ⛔ `panel` / `panel3` 两个相位的条目（「粘贴编辑结果」入口空转 + 三变异并集判决）已撤掉：
  //    面板与脚本都随"独立窗口编辑"整体删除（2026-09-21）。
  //    ⚠️ 但那轮排查留下的一条教训必须留住 —— **把 `targets` 定太宽 = 审计自己造假结论**：
  //    第一版写了宽泛的 `/编辑器/`，把「进入内联编辑器」「能开出编辑器窗口」这些**前置步骤**
  //    也扫了进来，它们跟"面板在场"无关、变异够不到，于是被机械统计打成"装饰"。
  //    ⇒ 判 targets 时只放"这个变异**理论上够得到**的断言"，前置步骤一律归"未涉及（没有证据）"。

  // ══════════════════════════════════════════════════════════════════════
  // 任务 7 的四组定向变异（team-lead「画布收工」后授权）
  //
  // **顺序即优先级**：这个会话会被反复中断，65 分钟的单批后台任务活不过两次中断
  // （第四轮实测连续两轮死在"只跑完基线就被掐"）。所以这一相位按 team-lead 划的
  // 价值顺序排，用 `--skip=N --limit=3` 一批 3 次地跑：
  //
  //   ① baseline（其它都要跟它比）
  //   ② sysvar-hidetotal-off / sysvar-format-off ← 最高优先
  //      那 6 条系统变量断言在上一轮**一次都没执行过**（旧产物只跑到 120 条，
  //      缺的 10 条里整整 6 条是系统变量）。"它们守住了"至今没有运行时刻的证据。
  //   ③ preview-empty / preview-snapshot ← 次高（"预览与第③步同源"只有变异能收口）
  //   ④ font-render-drop / font-canvas-drop
  //   ⑤ orient-ui-only
  //
  // 跨批复用基线：第二批起 `--skip=3` 不再重跑基线，改为读
  // `.shots/audit-baseline-editor-interaction.mjs.json`（第一批跑完就落盘），
  // 并**校验快照哈希一致** —— 哈希对不上就拒绝复用，绝不拿两版脚本的读数比对。
  //
  // targets 一律**点名到断言**（不写 /预览/、/字体/ 这种宽泛词）：
  // 上一轮就是因为 targets 写宽，把三条前置步骤扫进射程、凭空造出三条假装饰。
  // ══════════════════════════════════════════════════════════════════════
  { phase: 't7', script: 'editor-interaction.mjs', mut: null, note: '基线（任务 7 新断言）' },
  {
    // ②-1：显示总页数开关不生效 → "关掉之后只剩第 X 页"必须红
    phase: 't7',
    script: 'editor-interaction.mjs',
    mut: 'sysvar-hidetotal-off',
    targets: [/【系统变量·承重】关掉/],
  },
  {
    // ②-2：时间格式被忽略 → "选了星期三产物里真的出现星期四"必须红
    phase: 't7',
    script: 'editor-interaction.mjs',
    mut: 'sysvar-format-off',
    targets: [/【系统变量·承重】把这一处的时间格式/],
  },
  {
    // ③-1：预览产物整个变空 → 【预览·核心】【预览】必须红
    phase: 't7',
    script: 'editor-interaction.mjs',
    mut: 'preview-empty',
    targets: [/【预览·核心】/, /^【预览】/],
  },
  {
    // ③-2：预览改读"另一份快照"的 pageSetup → 页尺寸那条必须红
    phase: 't7',
    script: 'editor-interaction.mjs',
    mut: 'preview-snapshot',
    targets: [/【横向·闭环】/],
  },
  {
    // ④-1：只断产物侧字体 → 打印产物那两条必须红，画布那两条应当**仍然绿**
    phase: 't7',
    script: 'editor-interaction.mjs',
    mut: 'font-render-drop',
    targets: [/【承重·打印产物】/, /【反向对照·产物】/],
  },
  {
    // ④-2：只断画布侧字体 → 画布那两条必须红，产物那两条应当**仍然绿**
    phase: 't7',
    script: 'editor-interaction.mjs',
    mut: 'font-canvas-drop',
    targets: [/把「这一处的字体」设成楷体/, /【分层·反向对照】/],
  },
  {
    // ⑤：方向只点不写 → 画布对调 / 按钮同步 / 版心 / 可逆 / 预览页尺寸 五条必须红
    //
    // `干净 doc 上切到横向` 那条是 [14] 段里 C 组的前提断言，它量的**就是**这件事
    // （切到横向之后纸张是不是 297×210），所以它跟 #9/#11 是同一条链路上的承重断言，
    // 一并瞄准。这不是"写宽"：它跟这条变异问的是同一个问题。
    phase: 't7',
    script: 'editor-interaction.mjs',
    mut: 'orient-ui-only',
    targets: [
      /【横向·核心】/,
      /aria-label 与 aria-pressed 同步/,
      /版心宽度也真的换了方向/,
      /【反向对照·横纵向】/,
      /【横向·闭环】/,
      /干净 doc 上切到横向/,
    ],
  },

  // ══════════════════════════════════════════════════════════════════════
  // t8（B 批之后）：**独立复验三条"刚被修过"的断言**
  //
  // 三条都是"改前是装饰/恒假，owner 改完之后必须实测变红"的类型 ——
  // 判据是 team-lead 定的：**改的人不能自己宣布成功**。
  //
  //   (a) preview-empty    → 【预览·承重】必须红
  //        原断言读的是 `PreviewPane.tsx` 里**硬编码的 JSX 文案**（测的是"文案在不在"），
  //        改后是"面板 meta 的 N 页 == iframe 里 section.bp-page 的条数"（对账两个独立来源）。
  //   (b) orient-ui-only   → 【反向对照·横纵向】必须红
  //        原判据读"第二次点击**之后**的状态"，而这条变异让方向压根不变 → 恒真。
  //        改后是"第二次点击**前后必须不同**"。
  //   (c) align-guides-off → 【对齐线·承重】必须红
  //        它首跑（run19）在 149 条里是 148 PASS / 1 FAIL —— **真 FAIL**：
  //        两个靶子文本块左缘都在 121px，位移 0 的拖动进不去"移动"分支（阈值 3px），
  //        `setGuides` 一次都没被调用 → 断言恒假。改法是"先挪开 40px、再拖回来对齐"。
  //
  // targets 一律点名到断言。**注意 `【预览·存在性】` 故意不在这里瞄准**：
  //   它的声明主体是"那句文案还在不在"，而 `preview-empty` 改的是"产物 HTML 变空" ——
  //   文案是硬编码的、空产物也不是失败分支，所以这条变异**没有改变它声明的主体**。
  //   瞄准它就会凭空造出一条假装饰。它的读数会在报告里单独给（观察），判定栏记「未涉及」。
  //   要判它有没有牙，得用一条"把文案删掉"的变异（本轮预算不够，如实挂账）。
  // ══════════════════════════════════════════════════════════════════════
  { phase: 't8', script: 'editor-interaction.mjs', mut: null, note: '基线（B 批后，149 条）' },
  {
    phase: 't8',
    script: 'editor-interaction.mjs',
    mut: 'preview-empty',
    targets: [/【预览·承重】/],
  },
  {
    phase: 't8',
    script: 'editor-interaction.mjs',
    mut: 'orient-ui-only',
    targets: [/【反向对照·横纵向】/],
  },
  {
    phase: 't8',
    script: 'editor-interaction.mjs',
    mut: 'align-guides-off',
    targets: [/【对齐线·承重】/],
  },

  // ══════════════════════════════════════════════════════════════════════
  // t9（收网批）：[15] 段里两条"判据最容易写歪"的断言
  //
  // 为什么挑这两条：它们的判据都是**合取**，且各有一半是"看着像废话、其实承重"的那半 ——
  //   · 【拖列边框·总宽同步】：`|Δ画布宽 − 指针位移| ≤ 3` **且** `|列宽之和 − 总宽| ≤ 0.5`
  //     前半在"列宽没同步"时也会红，所以真正要单验的是**后半**（列宽数组与 `w` 是否脱节）。
  //   · 【拖行边框·第三态】：它点名排除了"被钳在 6mm 那种下限值"这个形态 ——
  //     那就直接把缺陷造成那个形态，看它认不认得出来。
  //
  // 基线不重跑：t9 与 t8 是**同一个冻结快照**（088b5cd9bd61），装置会自动复用
  // `.shots/audit-baseline-editor-interaction.mjs.json`（复用前仍校验哈希）。
  // ══════════════════════════════════════════════════════════════════════
  { phase: 't9', script: 'editor-interaction.mjs', mut: null, note: '基线（同 t8 快照，走缓存）' },
  {
    phase: 't9',
    script: 'editor-interaction.mjs',
    mut: 'colwidth-w-desync',
    targets: [/【拖列边框·总宽同步】/],
  },
  {
    phase: 't9',
    script: 'editor-interaction.mjs',
    mut: 'rowheight-floor-clamp',
    targets: [/【拖行边框·第三态】/],
  },

  // ══════════════════════════════════════════════════════════════════════
  // t10 / t11 两个相位：**已删除**（team-lead 裁决，第六轮收口时执行）
  //
  // 为什么删：这两个相位挂在**浏览器代理装置**上，而该装置在本轮被证明**跑不完** ——
  // `.shots/audit-t10.log` 只有 881 字节、停在基线那一行；无 state / 无 evidence；
  // 端口无监听、`msedge` 进程数 0。归因：长任务丢后台之后回合结束，**子进程随回合被回收**
  // （§8.1 早就写过这件事）。⇒ t10/t11 **一条读数都没产出** ——
  // 把它们留在 PLAN 里，只会让下一个人以为"跑过了"。
  //
  // 这三条变异改由 **Node 级装置**复验完毕（装置 `.shots/_mut-node-run.mjs`；
  // 读数 `.shots/_mut-node-run-*.txt`；报告 §10）。逐字结论：
  //   · `date-fallback-dump-json`  命中 1 次 · exit 1 · 217/214/**3 红**
  //   · `link-records-dump-json`   命中 1 次 · exit 1 · 217/215/**2 红**
  //   · `default-dump-json`        命中 1 次 · exit 0 · 217/217/**0 红**（分支不可达；
  //      写盘四验证明变异确实写进去了 ⇒ **只**证明"命中 ≠ 生效"）
  //
  // 三条**变异定义**保留在 MUTATIONS 里（那是缺陷形状的登记），各自带一行去向注释。
  // `render-json-object` 保持原样 —— 它本来就与 t10/t11 无关。
  // ══════════════════════════════════════════════════════════════════════
]

// ============================================================
// sha256 清单（证明没碰过磁盘）
// ============================================================

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.shots') continue
      walkFiles(p, out)
    } else if (e.isFile()) {
      out.push(p)
    }
  }
  return out
}

function manifest() {
  const map = new Map()
  for (const dir of ['src', 'test']) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const f of walkFiles(abs)) {
      // 本脚本自己会被创建/改写，排除掉
      if (f.endsWith('assertion-audit.mjs')) continue
      const st = statSync(f)
      map.set(relative(ROOT, f).replace(/\\/g, '/'), `${st.size}:${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)}`)
    }
  }
  return map
}

function diffManifest(a, b) {
  const changed = []
  for (const [k, v] of a) if (b.get(k) !== v) changed.push(k)
  for (const [k] of b) if (!a.has(k)) changed.push(`${k}（新增）`)
  return changed
}

// ============================================================
// 反向代理：把命中变异的模块响应在内存里换掉
// ============================================================

const state = {
  /** 当前生效的变异（null = 透传） */
  active: null,
  /** 每个变异的命中计数 */
  hits: new Map(),
  /** 代理内部错误（命中 0 / 上游挂了都靠它发现） */
  problems: [],
  served: 0,
}

function shouldMutate(url, mut) {
  if (!mut || !mut.file) return false
  const path = url.split('?')[0]
  return path === mut.file
}

function applyMutation(body, mut) {
  if (typeof mut.apply === 'function') return mut.apply(body)
  if (!mut.find) return null
  const idx = body.indexOf(mut.find)
  if (idx < 0) return null
  // 默认只替换第一处（其它同形片段不该被波及）；`all: true` 才全替换
  if (mut.all) return body.split(mut.find).join(mut.repl)
  return body.slice(0, idx) + mut.repl + body.slice(idx + mut.find.length)
}

const proxy = http.createServer((req, res) => {
  const headers = { ...req.headers }
  // 要求上游不要压缩，否则改不动 body
  delete headers['accept-encoding']
  delete headers['if-none-match']
  delete headers['if-modified-since']
  headers.host = `127.0.0.1:${UPSTREAM_PORT}`

  const up = http.request(
    { host: '127.0.0.1', port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (upRes) => {
      const mut = state.active
      if (!shouldMutate(req.url, mut)) {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
        return
      }
      const chunks = []
      upRes.on('data', (c) => chunks.push(c))
      upRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const text = applyMutation(raw, mut)
        if (text === null) {
          state.problems.push(`变异 ${mut.id} 在 ${req.url} 里没有命中锚点（响应 ${raw.length} 字节）`)
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          res.end(Buffer.concat(chunks))
          return
        }
        const mutated = Buffer.from(text, 'utf8')
        const h = { ...upRes.headers }
        delete h['content-encoding']
        delete h['content-length']
        delete h['etag']
        h['content-length'] = String(mutated.length)
        h['cache-control'] = 'no-store'
        state.served += 1
        state.hits.set(mut.id, (state.hits.get(mut.id) ?? 0) + 1)
        res.writeHead(upRes.statusCode ?? 200, h)
        res.end(mutated)
      })
    },
  )
  up.on('error', (e) => {
    state.problems.push(`代理上游请求失败 ${req.url}：${e.message}`)
    try {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('proxy upstream error')
    } catch {
      /* 忽略 */
    }
  })
  req.pipe(up)
})

// Vite 的 HMR 走 WebSocket —— 不代理的话页面会因 HMR 客户端连不上而报 console 错误，
// 而 e2e-smoke 之类脚本把"无 console 错误"当断言，会污染基线。
proxy.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(UPSTREAM_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(req.headers)) {
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

// ============================================================
// 跑一个脚本并解析它的 PASS/FAIL
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 「断言名 → 读数」的分流分隔符。
 *
 * 为什么是一个数组而不是一个常量：**不同的脚本用不同的分隔符**。
 *   · ` — `（单破折号）—— e2e-smoke / wiring / paste / range-picker / handshake / loop-table 都用这个；
 *   · `  →  `（**双空格**箭头）—— 只有 `editor-interaction.mjs` 用（它第 84 行
 *     `const tail = detail ? \`  →  ${detail}\` : ''`，PASS 与 FAIL 两侧都带）。
 *
 * 这个坑是第四轮审计开工前实测出来的，**不修的话整轮 t7 会静默作废**：
 * `editor-interaction.mjs` 的 130 条断言里有 129 条带 `  →  detail`，旧解析器只认 ` — `，
 * 于是 detail 被原样并进**断言名**。基线那一轮的 key 是「…【预览·核心】…  →  页数=4 产物长度=111953」，
 * 变异那一轮同样一条断言变成「…  →  页数=0 产物长度=…」—— 两个 key 对不上，
 * 判定分支走到 `变异后未跑到`，38 条全部落进"未判定"，而日志看起来"跑了、有矩阵、有结论"。
 * 这正是本审计要抓的那种"读数齐全但一条都没判"的假绿。
 *
 * 分流必须用**双空格**箭头：实测 `editor-interaction.mjs` 有 29 条断言**名字体里**就含单空格 ` → `
 * （例：`【横向·核心】点顶栏方向按钮 → **画布纸张宽高真的对调**`），按单空格切会把名字切碎。
 *
 * 顺序：` — ` 优先（沿用旧行为，一个字都不影响既有读数）。实测这 129 行里
 * 「同时含两种分隔符」的是 **0 条**，所以先后顺序对 editor-interaction 无影响、对老脚本也不变。
 */
const NAME_SEPARATORS = [' — ', '  →  ']

function parseResults(out) {
  const map = new Map()
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(PASS|FAIL)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    let name = m[2]
    let detail = ''
    for (const sep of NAME_SEPARATORS) {
      const i = name.indexOf(sep)
      if (i >= 0) {
        detail = name.slice(i + sep.length)
        name = name.slice(0, i)
        break
      }
    }
    map.set(name, { pass: m[1] === 'PASS', detail })
  }
  return map
}

const fileHash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/**
 * 子进程输出的**收尾几行**，连同它的哈希。
 *
 * 为什么不能只看"断言 N 条 / 失败 0"：本项目已经栽过一次 ——
 * 脚本中途崩掉、只跑到 120 条，照样打出一条 `✅ …全部通过：120 项` 的绿横幅。
 * 于是"N 条里 0 条失败"这句话在"少跑了一截"的情况下**同样成立**。
 * 唯一没法伪造的是**脚本自己那行收尾结论**，而它在结尾才打印。
 * 把它记进状态文件，复查"这一批到底跑完没有"就只看状态文件即可，
 * 不必翻日志、更不必拿耗时去猜（耗时是环境敏感量，实测同一版脚本
 * 113s 与 488.7s 都能跑完同样的 130 条）。
 */
function childTail(out, n = 4) {
  const lines = String(out ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
  const last = lines.slice(-n)
  return { lines: last, tailHash: createHash('sha256').update(last.join('\n')).digest('hex').slice(0, 16) }
}

// ============================================================
// 冻结快照：读数可比的前提
// ============================================================
//
// 并行队友随时可能在改 test/*.mjs。第一次跑的时候实测到了这个后果：
// range-picker.mjs 在 6 分钟里被改了 4 次，基线与各个变异跑的根本不是同一版脚本，
// 断言数在 0 / 69 / 31 之间乱跳 —— 那种读数**没法比对**，硬拿来下结论就是编。
//
// 办法：开跑前把本次计划里的每个脚本复制一份到 os.tmpdir()，跑**那一份快照**。
//   · 不写项目目录，其它队友看不到、也不会被"假回归"干扰；
//   · 基线与所有变异共用同一份字节，比对成立；
//   · 快照的 sha256 与"磁盘上那一版"的 sha256 都记下来，
//     如果开跑前后磁盘版本变了，就在结论里明确说"这版已经过时了"。
//
// 这些脚本都用 `process.env.BP_BASE ?? process.argv[2]` 取地址、用 os.tmpdir() 放 profile，
// 不依赖自身所在目录，所以搬走照样跑得动（range-picker 用 argv[1] 判"是否主入口"，也成立）。
const FREEZE_DIR = join(tmpdir(), `bp-audit-freeze-${process.pid}-${Date.now().toString(36)}`)

function freeze(script) {
  const src = join(ROOT, 'test', script)
  const dst = join(FREEZE_DIR, script)
  mkdirSync(FREEZE_DIR, { recursive: true })
  copyFileSync(src, dst)
  return { dst, frozenHash: fileHash(dst), frozenSha256: sha256(dst) }
}

/**
 * 基线缓存文件：分批跑法下，第二批起没有自己的基线，从这里读第一批落盘的那份。
 * 文件名带脚本名，避免多个脚本互相盖。
 */
function baselineCachePath(script) {
  return join(ROOT, '.shots', `audit-baseline-${script.replace(/[^\w.-]/g, '_')}.json`)
}

function runScript(script, mutId, timeoutMs, frozenPath) {
  const mut = mutId ? { ...MUTATIONS[mutId], id: mutId } : null
  state.active = mut
  if (mut) state.hits.set(mutId, 0)

  // 跑的是冻结快照；同时记下"此刻磁盘上那一版"是什么，用来披露并发改动。
  const livePath = join(ROOT, 'test', script)
  const liveHash = existsSync(livePath) ? fileHash(livePath) : 'missing'
  const scriptHash = frozenPath ? fileHash(frozenPath) : liveHash

  return new Promise((resolve) => {
    const args = [frozenPath ?? livePath]
    // 一部分脚本走 argv[2]，一部分只认 BP_BASE —— 两个都给
    args.push(PROXY_BASE)
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, BP_BASE: PROXY_BASE, BP_UPSTREAM_PORT: String(UPSTREAM_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(killer)
      state.active = null
      resolve({
        code,
        out,
        err,
        results: parseResults(out),
        hits: mut ? state.hits.get(mutId) ?? 0 : null,
        timedOut: code === null,
        scriptHash,
        liveHash,
        scriptChanged: existsSync(livePath) && fileHash(livePath) !== liveHash,
      })
    })
    child.on('error', (e) => {
      clearTimeout(killer)
      state.active = null
      resolve({
        code: -1,
        out,
        err: err + String(e),
        results: parseResults(out),
        hits: 0,
        timedOut: false,
        scriptHash,
        liveHash,
        scriptChanged: false,
      })
    })
  })
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const argv = process.argv.slice(2)
  const onlyPlan = argv.includes('--plan')
  const phaseArg = argv.find((a) => a.startsWith('--phase='))
  const phase = phaseArg ? phaseArg.slice('--phase='.length) : null
  const timeoutMin = Number((argv.find((a) => a.startsWith('--timeoutMin=')) ?? '--timeoutMin=25').split('=')[1])

  // ------------------------------------------------------------
  // 自检：每个变异的锚点必须在**真实的 Vite 编译产物**里命中。
  // 命中 0 次 = 这次变异根本没生效，基于它的结论全部作废 —— 这正是本项目
  // 反复踩到的坑（断言找的模式在真实数据里根本不存在，于是永远绿）。
  // ------------------------------------------------------------
  if (argv.includes('--verify-anchors')) {
    if (!(await devServerAlive())) {
      console.log(`❌ dev server 不可达（http://localhost:${UPSTREAM_PORT}）`)
      return 2
    }
    let bad = 0
    console.log('锚点自检（对着 5190 的真实编译产物数出现次数）\n')
    for (const [id, m] of Object.entries(MUTATIONS)) {
      const url = `http://localhost:${UPSTREAM_PORT}${m.file}`
      let body = ''
      try {
        const r = await fetch(url)
        if (!r.ok) {
          console.log(`  HTTP${r.status} ${id.padEnd(24)} ${m.file}`)
          bad++
          continue
        }
        body = await r.text()
      } catch (e) {
        console.log(`  ERR    ${id.padEnd(24)} ${String(e.message)}`)
        bad++
        continue
      }
      let n = 0
      let i = -1
      while ((i = body.indexOf(m.find, i + 1)) >= 0) n++
      const flag = n === 0 ? '❌ MISS' : n === 1 ? '✅ OK  ' : m.all ? `✅ DUP${n}` : `⚠️ DUP(${n})→只换第 1 处`
      if (n === 0) bad++
      console.log(`  ${flag} ${id.padEnd(24)} ${m.file}  出现 ${n} 次`)
    }
    console.log(`\n结论：${Object.keys(MUTATIONS).length - bad} 个锚点可用${bad ? `，${bad} 个不可用（这些变异必须删除或改锚点）` : '，全部可用'}`)
    return bad ? 1 : 0
  }

  const limitArg = argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 0
  /**
   * `--skip=N`：跳过前 N 次运行。
   *
   * 为什么要它：这个会话会被反复中断，65 分钟的单批后台任务活不过两次中断
   * （第四轮实测连续两轮死在"只跑完基线就被掐"）。所以改成**分批 + 可续跑**：
   * 每批最多 3 次运行（约 24 分钟），跑完落盘、报一次、再跑下一批。
   * `--skip` 让第二批从第 4 次接着跑，而不是把基线重跑一遍（重跑一次要 8 分钟）。
   *
   * 跨批复用的基线见下面的 `baselineCache`。
   */
  const skipArg = argv.find((a) => a.startsWith('--skip='))
  const skip = skipArg ? Number(skipArg.split('=')[1]) : 0
  const planAll = PLAN.filter((p) => !phase || p.phase === phase)
  let plan = planAll.slice(skip > 0 ? skip : 0)
  if (limit > 0) plan = plan.slice(0, limit)

  console.log('='.repeat(70))
  console.log('断言审计：代理层变异 + 真实断言读数')
  console.log('='.repeat(70))
  console.log(`上游 dev server : http://localhost:${UPSTREAM_PORT}`)
  console.log(`代理            : ${PROXY_BASE}`)
  console.log(`本次计划        : ${plan.length} 次运行（${new Set(plan.map((p) => p.script)).size} 个脚本）`
    + `${skip > 0 ? `［全相位共 ${planAll.length} 次，本次从第 ${skip + 1} 次续跑］` : ''}`)
  for (const p of plan) console.log(`   · ${p.script.padEnd(26)} ${p.mut ?? '（基线）'}`)
  if (onlyPlan) return 0

  if (!(await devServerAlive())) {
    console.log(`\n❌ dev server 不可达（http://localhost:${UPSTREAM_PORT}）。这是后台的，不要自己起 —— 请联系 team-lead。`)
    return 2
  }

  const before = manifest()

  // 冻结快照（见文件上方说明）：本次计划里出现的脚本，各复制一份到 os.tmpdir()
  const frozen = new Map()
  for (const s of new Set(plan.map((p) => p.script))) {
    const f = freeze(s)
    frozen.set(s, f)
    console.log(`冻结 ${s.padEnd(26)} → ${f.frozenHash}（磁盘当前那一版）`)
  }

  await new Promise((res) => proxy.listen(PROXY_PORT, '127.0.0.1', res))
  console.log(`\n代理已就绪。\n`)

  // ------------------------------------------------------------
  // 跨批复用基线（分批跑法的关键零件）
  //
  // 本批没有 baseline（`--skip>0` 的续跑批）时，去读上一批落盘的基线。
  // **硬约束**：缓存里的 `scriptHash` 必须与本批冻结快照的哈希一致 ——
  // 不一致就拒绝复用（宁可不判，也不能拿两版脚本的读数比对）。
  // 复用了哪一条会在日志里明写，绝不让"这次的基线是缓存来的"这件事隐身。
  // ------------------------------------------------------------
  const baselineCache = new Map()
  for (const s of new Set(plan.map((p) => p.script))) {
    if (plan.some((p) => p.script === s && !p.mut)) continue // 本批自己会跑基线
    const cf = baselineCachePath(s)
    if (!existsSync(cf)) {
      console.log(`⚠️ 本批没有基线，也找不到缓存 ${cf} —— ${s} 的判定会被跳过`)
      continue
    }
    try {
      const j = JSON.parse(readFileSync(cf, 'utf8'))
      const want = frozen.get(s)?.frozenHash
      if (j.scriptHash !== want) {
        console.log(`⚠️ 缓存基线快照不匹配（缓存 ${j.scriptHash} ≠ 本批 ${want}）—— 拒绝复用，判定跳过`)
        continue
      }
      baselineCache.set(s, {
        code: j.code,
        scriptHash: j.scriptHash,
        liveHash: j.liveHash,
        hits: 0,
        results: new Map((j.results ?? []).map((r) => [r.name, { pass: r.pass, detail: r.detail }])),
        cached: true,
      })
      console.log(`♻️ 复用缓存基线 ${s}（快照 ${j.scriptHash}，${j.results?.length ?? 0} 条读数，来自 ${cf.replace(ROOT, '.')}）`)
    } catch (e) {
      console.log(`⚠️ 缓存基线读不动（${e.message}）—— 判定跳过`)
    }
  }

  /** script → { baseline, mutated: Map(mutId → result) } */
  const collected = new Map()
  for (const [s, r] of baselineCache) collected.set(s, { baseline: r, mutated: new Map() })
  const runs = []

  try {
    for (const p of plan) {
      const t0 = Date.now()
      console.log(`\n${'─'.repeat(70)}\n▶ ${p.script}  ${p.mut ? `[变异 ${p.mut}]` : '[基线]'}  ${p.note ?? ''}`)
      const r = await runScript(p.script, p.mut, timeoutMin * 60 * 1000, frozen.get(p.script)?.dst)
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      const failNames = [...r.results.values()].filter((v) => !v.pass).length
      console.log(
        `  退出码 ${r.code}｜断言 ${r.results.size} 条（失败 ${failNames}）｜变异命中 ${r.hits ?? '-'} 次｜耗时 ${secs}s｜快照 ${r.scriptHash}${r.scriptChanged ? ' ⚠️窗口内磁盘版被改' : ''}`,
      )
      if (r.timedOut) console.log('  ⚠️ 超时被杀')
      if (r.err.trim()) console.log(`  stderr 摘要：${r.err.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300)}`)

      if (p.mut && r.hits === 0) {
        console.log(`  ⚠️ 变异 ${p.mut} 未命中真实响应 —— 这次读数作废`)
      }

      if (!collected.has(p.script)) collected.set(p.script, { baseline: null, mutated: new Map() })
      const slot = collected.get(p.script)
      if (p.mut) slot.mutated.set(p.mut, { ...r, mutId: p.mut, targets: p.targets ?? [] })
      else slot.baseline = r
      runs.push({ ...p, ...r })

      // 把**子进程的原样输出**落盘。
      //
      // 为什么要它：审计装置的日志里只有"断言 130 条（失败 0）"，看不到脚本自己那行
      // 收尾结论（`✅ …全部通过：130 项`）与耗时账本。而"它到底跑没跑完"恰恰是
      // 本项目反复栽的地方 —— 上一轮就是脚本停在 120 条照样打绿横幅。
      // 有这份原样输出，就能逐字核对收尾行，而不是靠推断。
      try {
        const childLog = join(
          ROOT,
          '.shots',
          `audit-child-${phase ?? 'all'}-${(p.mut ?? 'baseline').replace(/[^\w.-]/g, '_')}.log`,
        )
        writeFileSync(childLog, `# ${p.script} ｜ ${p.mut ?? '（基线）'} ｜ 退出码 ${r.code} ｜ 耗时 ${secs}s ｜ 命中 ${r.hits ?? '-'}\n\n` + (r.out ?? '') + (r.err ? `\n\n--- stderr ---\n${r.err}` : ''))
      } catch (e) {
        console.log(`  ⚠️ 子进程原样输出落盘失败：${e.message}`)
      }

      // 每跑完一次就把结果落盘（不只是整批结束才写）：
      // 这个会话随时可能被掐，基线那 8 分钟不能白跑 —— 下一批要复用它。
      if (!p.mut && r.results.size > 0) {
        try {
          writeFileSync(
            baselineCachePath(p.script),
            JSON.stringify(
              {
                script: p.script,
                scriptHash: r.scriptHash,
                liveHash: r.liveHash,
                code: r.code,
                at: new Date().toISOString(),
                results: [...r.results.entries()].map(([name, v]) => ({ name, pass: v.pass, detail: v.detail })),
              },
              null,
              1,
            ),
          )
          console.log(`  ♻️ 基线已落盘备用：.shots/audit-baseline-${p.script.replace(/[^\w.-]/g, '_')}.json`)
        } catch (e) {
          console.log(`  ⚠️ 基线落盘失败：${e.message}`)
        }
      }
    }

    // ---------------- 报告 ----------------
    console.log(`\n\n${'='.repeat(70)}\n逐条比对：基线绿 → 变异红 = 承重；两次都绿 = 装饰\n${'='.repeat(70)}`)

    let nLoad = 0
    let nDeco = 0
    let nLayer = 0
    let nUnknown = 0

    for (const [script, slot] of collected) {
      console.log(`\n── ${script} ──`)
      if (!slot.baseline || slot.baseline.results.size === 0) {
        console.log('  （基线没有产出任何断言读数，跳过）')
        for (const [id, r] of slot.mutated) console.log(`   变异 ${id}：读数 ${r.results.size} 条`)
        continue
      }
      const base = slot.baseline.results
      const baseFails = [...base.entries()].filter(([, v]) => !v.pass)
      if (baseFails.length) {
        console.log(`  ⚠️ 基线本身有 ${baseFails.length} 条不通过：${baseFails.map(([k]) => k).join(' / ')}`)
      }
      // 快照保证了"基线与变异同版"；但磁盘上那一版可能中途被并行队友改掉 —— 必须披露
      const frozenHashes = new Set([slot.baseline.scriptHash, ...[...slot.mutated.values()].map((r) => r.scriptHash)])
      if (frozenHashes.size > 1) {
        console.log(`  ⚠️ 装置异常：同一脚本的多次运行用了不同快照（${[...frozenHashes].join(' / ')}）—— 读数不可比`)
      }
      const liveAsRun = new Set([slot.baseline.liveHash, ...[...slot.mutated.values()].map((r) => r.liveHash)])
      if (liveAsRun.size > 1) {
        console.log(`  ⚠️ 本次窗口内 test/${script} 在磁盘上被**并行队友**改过（${[...liveAsRun].join(' / ')}）——`)
        console.log(`     下面所有读数都取自冻结快照 ${slot.baseline.scriptHash}（可比、可复现）；`)
        console.log(`     但磁盘上那一版可能已有新断言/新修法**没被这次审计覆盖**，判读时请留意。`)
      }
      for (const [name, bv] of base) {
        // 关键设计：**每个变异对这条断言的原始读数全部记下来**（不管有没有瞄准它），
        // 只有"判定"时才用 targets 过滤。理由很实在：第一版审计把 targets 定得太宽
        // （把所有 A 组都当成 label 变异的受审对象），于是"变异没触到它的证据"
        // 被误算成"装饰" —— 那是审计自己在造假结论。把原始矩阵落进日志，
        // 事后调整判定口径就不必重跑（重跑一次要十几分钟，而且并行队友还在改脚本）。
        const raw = []
        const aimed = []
        for (const [id, r] of slot.mutated) {
          const mv = r.results.get(name)
          const applied = (r.hits ?? 0) > 0
          let verdict
          if (!applied) verdict = '变异未命中'
          else if (!mv) verdict = '变异后未跑到'
          else if (bv.pass && !mv.pass) verdict = '红'
          else if (bv.pass && mv.pass) verdict = '仍绿'
          else verdict = '基线本就不绿'
          raw.push(`${id}=${verdict}`)
          if ((r.targets ?? []).some((re) => re.test(name))) aimed.push(`${id}=${verdict}`)
        }
        const concrete = aimed.filter((s) => s.endsWith('=红') || s.endsWith('=仍绿'))
        const anyRed = aimed.some((s) => s.endsWith('=红'))
        let tag
        if (aimed.length === 0) {
          tag = '未涉及（本次没有瞄准它的变异）'
          nUnknown += 1
        } else if (anyRed) {
          tag = '承重'
          nLoad += 1
        } else if (concrete.length > 0) {
          tag = '装饰'
          nDeco += 1
        } else {
          tag = '待判定（变异未命中/未跑到）'
          nUnknown += 1
        }
        console.log(`  [${tag}] ${name}`)
        console.log(`        基线 ${bv.pass ? 'PASS' : 'FAIL'}${bv.detail ? ` ｜ ${bv.detail.slice(0, 170)}` : ''}`)
        console.log(`        瞄准它的：${aimed.join('  ') || '（无）'}`)
        console.log(`        全部变异：${raw.join('  ')}`)
      }
    }

    console.log(`\n${'='.repeat(70)}`)
    console.log('审计读数汇总（基线阶段的机械统计）')
    console.log(`  承重（有变异令其变红）  : ${nLoad}`)
    console.log(`  装饰（变异后仍绿）      : ${nDeco}`)
    console.log(`  未做变异 / 待判定       : ${nUnknown}`)
    console.log('='.repeat(70))

    console.log(`\n变异命中统计：`)
    for (const [id] of Object.entries(MUTATIONS)) {
      const h = state.hits.get(id)
      if (h === undefined) continue
      console.log(`   ${id.padEnd(24)} 命中 ${h} 次${h === 0 ? '   ⚠️ 作废' : ''}`)
    }
    if (state.problems.length) {
      console.log(`\n⚠️ 代理期间的问题（${state.problems.length} 条）：`)
      for (const p of state.problems.slice(0, 10)) console.log(`   · ${p}`)
    }
  } finally {
    await new Promise((res) => proxy.close(res))
  }

  const after = manifest()
  const changed = diffManifest(before, after)

  // 原始读数落盘：报告要写"同一变异下的改前绿 / 改后红"，两侧的 detail 都得留底。
  // 日志里只印了基线一侧的 detail，够不上这个要求 —— 所以另存一份完整的证据 JSON。
  try {
    const evidence = {}
    for (const [script, slot] of collected) {
      evidence[script] = {
        baseline: slot.baseline
          ? {
              hash: slot.baseline.scriptHash,
              code: slot.baseline.code,
              results: [...slot.baseline.results.entries()].map(([n, v]) => ({ name: n, pass: v.pass, detail: v.detail })),
            }
          : null,
        mutated: {},
      }
      for (const [id, r] of slot.mutated) {
        evidence[script].mutated[id] = {
          hits: r.hits,
          code: r.code,
          results: [...r.results.entries()].map(([n, v]) => ({ name: n, pass: v.pass, detail: v.detail })),
        }
      }
    }
    // 分批跑时**每批一份**，不要互相覆盖：第二批的证据里只有第二批那几个变异，
    // 覆盖掉第一批就等于把已跑完的读数扔了。
    const batchTag = skip > 0 ? `-b${skip}` : ''
    const outPath = join(ROOT, '.shots', `audit-evidence-${phase ?? 'all'}${batchTag}.json`)
    writeFileSync(outPath, JSON.stringify(evidence, null, 1))
    console.log(`\n原始读数已落盘：${outPath.replace(ROOT, '.')}（含每条断言在每一次运行里的 detail）`)
  } catch (e) {
    console.log(`\n⚠️ 证据 JSON 落盘失败：${e.message}`)
  }

  // ------------------------------------------------------------
  // 分批可续跑的状态文件（team-lead 要求的 `.shots/audit-<phase>-state.json`）
  //
  // 每批跑完就写、和上一批的合并。恢复时读它就知道从哪继续（`--skip=`），
  // 不需要重新跑基线、也不需要人记。**已完成的才算数**：写进去的都是这次真的
  // 跑完并有读数的运行，没跑完的留在 pending 里。
  // ------------------------------------------------------------
  try {
    const statePath = join(ROOT, '.shots', `audit-${phase ?? 'all'}-state.json`)
    let prev = {}
    if (existsSync(statePath)) {
      try {
        prev = JSON.parse(readFileSync(statePath, 'utf8'))
      } catch {
        prev = {}
      }
    }
    /**
     * 状态的 key 必须是 **(脚本, 变异)** 二元组，不能只按变异名。
     *
     * 踩过的坑（`wizardr4` 相位实测）：一个相位里有**两个以上脚本**时，它们的**基线**
     * 都会写成同一个 `baseline` 键 —— 4 次运行只记成 3 个 key，于是日志出现
     * `已完成 3/4 ｜ 待跑：（无）` 这种**自相矛盾**的两句话（"还有 1 条没跑"和"没有待跑的"同时成立）。
     * 它不影响承重/装饰判定（判定读的是 `collected`，不是这里），但它是一句**错的话**，
     * 而错的话会以等号的形式被下一个人引用。所以按 (script, mut) 分开记。
     *
     * ⚠️ 兼容性（想清楚了才敢动）：旧状态文件里的 `done` 是**裸键**（`baseline` / 变异名），
     * 新写法下这些旧条目匹配不上，会重新显示成「待跑」。这是**安全**的，因为：
     *   · `--skip=N` 一直是由人按日志决定的（本处的 done/pending **从来不参与**任何自动续跑决策）；
     *   · 基线复用读的是**另一份文件** `.shots/audit-baseline-<script>.json`，与本处无关；
     *   · 本处的 done/pending 只被**打印**、并原样写进状态 JSON 供人看。
     * ⇒ 最坏效果是新旧状态文件交替时多显示几条「待跑」（偏保守），不会漏跑、不会判错。
     *
     * 另外：只有落在**本相位 key 空间**里的 done 才算数（`planKeys` 过滤）。不这么写的话，
     * 拿旧状态文件重跑同一相位会变成 `已完成 7/4` —— 把"自相矛盾"从一个地方挪到另一个地方。
     * 顺带把旧裸键清理掉，状态文件下一批就自愈。
     */
    const stateKey = (script, mut) => `${script}::${mut ?? 'baseline'}`
    const planKeys = new Set(planAll.map((p) => stateKey(p.script, p.mut)))
    const done = new Set([...(prev.done ?? [])].filter((k) => planKeys.has(k)))
    // `results` 用**同一把尺子**过滤，否则文件自己就不自洽：done 记 4 条、results 记 7 条
    // （旧裸键 + 新组合键混在一起），下一个人会以为"跑过 7 次"。
    // 丢掉的只是**已经不在本相位计划里**的旧键 —— 原始读数在
    // `.shots/audit-evidence-<phase>.json` 里另存着，不会因此丢证据。
    const results = {}
    for (const [k, v] of Object.entries(prev.results ?? {})) if (planKeys.has(k)) results[k] = v
    for (const r of runs) {
      const key = stateKey(r.script, r.mut)
      if (r.results.size === 0) continue // 没读到断言 = 没真正跑完，不记 done
      const passN = [...r.results.values()].filter((v) => v.pass).length
      results[key] = {
        script: r.script,
        pass: passN,
        fail: r.results.size - passN,
        hits: r.hits ?? 0,
        code: r.code,
        // ------------------------------------------------------------
        // 收尾行的哈希 + 原文（team-lead 要求）。
        //
        // 为什么它是硬需求：本项目已经栽过一次"**停在 120 条照样打绿横幅**"——
        // 断言条数和失败数都可能骗人（少跑一截也照样是"130 条里 0 条失败"），
        // 唯一没法伪造的是**脚本自己那行收尾结论**。
        // 把它连同哈希记进状态文件，以后任何人想复查"这一批到底跑完没有"，
        // 只看状态文件就能定，不必翻日志、更不必靠耗时推断。
        // ------------------------------------------------------------
        childTail: childTail(r.out),
      }
      done.add(key)
    }
    const pending = planAll.map((p) => stateKey(p.script, p.mut)).filter((k) => !done.has(k))
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          phase: phase ?? 'all',
          frozen: [...frozen.values()].map((f) => f.frozenHash),
          done: [...done],
          results,
          pending,
          baselineFromCache: [...collected.values()].some((s) => s.baseline?.cached),
          updatedAt: new Date().toISOString(),
          note: '每批跑完就写。恢复时读 done/pending 决定下一批的 --skip；基线从 .shots/audit-baseline-<script>.json 复用；results[*].childTail 是子进程收尾行的哈希与原文（证明它真的跑到了结尾）。done/pending/results 的 key 一律是 `<script>::<变异名|baseline>` —— 一个相位里有多个脚本时，它们的基线必须各占一个键。',
        },
        null,
        1,
      ),
    )
    console.log(`状态文件已写：${statePath.replace(ROOT, '.')} ｜ 已完成 ${done.size}/${planAll.length} ｜ 待跑：${pending.join(', ') || '（无）'}`)
  } catch (e) {
    console.log(`⚠️ 状态文件写失败：${e.message}`)
  }

  // 最要紧的硬指标：**被变异的那些模块**在磁盘上必须一字未动
  const targetFiles = [...new Set(Object.values(MUTATIONS).map((m) => m.file))]
    .map((f) => f.replace(/^\//, ''))
  const targetChanged = targetFiles.filter((f) => before.get(f) !== after.get(f))

  console.log(`\n${'─'.repeat(70)}`)
  console.log('磁盘完整性（脚本跑前 vs 跑后，src/ 与 test/ 全量 sha256 清单）')
  console.log('  本脚本不写任何文件：变异只发生在代理进程的内存里。硬证据：')
  console.log(`    被变异的模块（${targetFiles.length} 个）哈希前后一致：${targetChanged.length === 0 ? '✅ 是' : `❌ 否 → ${targetChanged.join(', ')}`}`)
  for (const f of targetFiles) console.log(`      ${before.get(f) === after.get(f) ? '＝' : '≠'}  ${f}  [${before.get(f) ?? '-'}]`)
  console.log(`  全量：文件数 ${before.size} → ${after.size}；窗口内发生变化 ${changed.length} 个`)
  if (changed.length) {
    console.log('    以下是**并行队友**在本次运行窗口内的改动（不是本次审计写的，列出仅供参考 ——')
    console.log('    它们会让某些读数带上噪声，判读时需要考虑）：')
    for (const f of changed) console.log(`      ! ${f}`)
  }
  console.log(`${'─'.repeat(70)}\n`)

  return 0
}

main()
  .then((code) => {
    console.log(`\n审计脚本结束（exit ${code}）`)
    try {
      // profile 之类都建在 os.tmpdir()，此处无需清理项目根
      void tmpdir()
      void mkdirSync
    } catch {
      /* 忽略 */
    }
    process.exitCode = code
  })
  .catch((e) => {
    console.error('审计脚本崩溃：', e)
    process.exitCode = 1
  })
