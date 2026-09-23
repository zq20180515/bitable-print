/**
 * 格内子元素（`cell-child.ts`）与版式区原语（`doc-bands.ts`）的 Node 层自测。
 *
 *   node --experimental-strip-types src/components/editor/cell-child.selftest.mts
 *
 * ## 为什么这块必须有单测
 *
 * 这一层守着两条**只靠"跑一遍"抓不到**的契约：
 *
 *   ① **复合 id 的解析与写回**。`child:<tableId>:<cellId>` 是个字符串，它会被塞进
 *      `selectedId`、撤销栈的 `mergeKey`、右键菜单的目标……任何一处解析错了，
 *      表现都是"点一下没反应 / 改的是别的格子"，而不是抛错。写回又必须**只动那一格**，
 *      漏掉"其余部分原样"这条，就会在改一张表的时候把别的版式区一起覆盖掉。
 *
 *   ② **尺寸口径的换算**（`w` 在格内是百分比、自由层是 mm，见 types.ts 第 ④ 条）。
 *      进出格子各换算一次，换算错了肉眼很难发现 —— 图片"看起来小了一点"，
 *      没有任何报错，而画布与打印会一起错（它们读的是同一份数据）。
 *
 * 这两条都是纯函数，在 Node 层比是逐字节的；放到浏览器里比就变成"两次点击的结果凑巧一样"。
 * 浏览器那层只留接线（点格内元素有没有真的选中它、面板有没有换成格内那套控件）。
 *
 * 骨架照 `src/components/editor/__selftest.mts` 抄，不另发明一套（含 registerHooks
 * 与"断言名必须唯一"那条纪律）。
 */

// @ts-ignore -- 项目未安装 @types/node；这行只在 Node 运行时存在
import { registerHooks } from 'node:module'

registerHooks({
  // 参数显式标注：node:module 没有类型声明，不标就是隐式 any（strict 下要报错）
  resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown): unknown {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        /* 补扩展名失败就落回默认解析 */
      }
    }
    return nextResolve(specifier, context)
  },
})

import type { AnyElement, TableCell, TableElement, TableRow, TemplateDoc } from '../../lib/types'

type CellChildMod = typeof import('./cell-child')
type DocBandsMod = typeof import('./doc-bands')
type TypesMod = typeof import('../../lib/types')

/*
 * ⚠️ 这两个**必须是动态 import**：静态 import 在模块体执行前就被解析，
 *    `registerHooks` 还没注册 —— 无扩展名的相对导入直接 ERR_MODULE_NOT_FOUND。
 *    （`import type` 是类型位、会被抹掉，所以留在上面不影响。）
 */
const load = new URL('./', import.meta.url).href
const libLoad = new URL('../../lib/', import.meta.url).href
const C = (await import(`${load}cell-child.ts`)) as CellChildMod
const D = (await import(`${load}doc-bands.ts`)) as DocBandsMod
const T = (await import(`${libLoad}types.ts`)) as TypesMod
const { DEFAULT_PAGE_SETUP, SCHEMA_VERSION } = T

// ============================================================
// 断言脚手架（与 table-actions 套件同款）
// ============================================================

let passed = 0
const failures: string[] = []
/** 断言名收一份，末尾统一验"必须唯一"（重名会让失败行指向错误的断言，方向还是"看起来更安全"） */
const names: string[] = []

function ok(cond: unknown, name: string, detail?: unknown): void {
  names.push(name)
  if (cond) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
}

function eq(actual: unknown, expected: unknown, name: string): void {
  ok(actual === expected, name, { actual, expected })
}

function section(title: string): void {
  console.log(`\n── ${title}`)
}

// ============================================================
// 夹具
// ============================================================

function cell(id: string, children?: AnyElement[]): TableCell {
  const base: TableCell = { id, colspan: 1, rowspan: 1, nodes: [] }
  return children ? { ...base, children } : base
}

function img(id: string, over: Partial<AnyElement> = {}): AnyElement {
  return {
    id,
    kind: 'image',
    x: 0,
    y: 0,
    w: 40,
    h: 30,
    dataUrl: 'data:image/png;base64,AAAA',
    fit: 'contain',
    ...over,
  } as AnyElement
}

/** 一张 2×2 的表，可给某一格挂子元素 */
function makeTable(childrenByCell: Record<string, AnyElement[]> = {}, over: Partial<TableElement> = {}): TableElement {
  const rows: TableRow[] = [0, 1].map((r) => ({
    id: `row_${r}`,
    cells: [0, 1].map((c) => cell(`c_${r}_${c}`, childrenByCell[`c_${r}_${c}`])),
  }))
  return {
    id: 'tbl_1',
    kind: 'table',
    x: 10,
    y: 20,
    w: 100,
    h: 'auto',
    colWidthsMm: [40, 60],
    rows,
    border: { widthPt: 0.5, color: '#d0d3d9', mode: 'all' },
    ...over,
  }
}

/**
 * 把一张表放进指定版式区，另外两个区各放一个**哨兵**元素 —— 用来验"写回没碰别的地方"。
 *
 * ⚠️ 哨兵 id 必须**按区区分**（`sent_<band>`）：三个区共用一个 id 时，
 * `moveElementToBand` 那一类断言会算出"目标区里有两个"这种假红
 * （第一版就是这么写的，被自己的测试拦下来了）。
 */
function makeDoc(table: TableElement, band: 'header' | 'loop' | 'footer' = 'header'): TemplateDoc {
  const sentinel = (b: string): AnyElement =>
    ({
      id: `sent_${b}`,
      kind: 'text',
      x: 5,
      y: 6,
      w: 50,
      h: 'auto',
      nodes: [{ type: 'text', text: '别动我' }],
    }) as AnyElement
  const doc: TemplateDoc = {
    schemaVersion: SCHEMA_VERSION,
    pageSetup: { ...DEFAULT_PAGE_SETUP, margin: { ...DEFAULT_PAGE_SETUP.margin } },
    bands: {
      header: band === 'header' ? [table] : [sentinel('header')],
      loop: { elements: band === 'loop' ? [table] : [sentinel('loop')], offsetMm: 15 },
      footer: band === 'footer' ? [table] : [sentinel('footer')],
    },
  }
  return doc
}

const inBand = (doc: TemplateDoc, band: 'header' | 'loop' | 'footer'): AnyElement[] => D.readBand(doc, band)
const firstChild = (doc: TemplateDoc, band: 'header' | 'loop' | 'footer' = 'header'): AnyElement | undefined => {
  const t = inBand(doc, band).find((e) => e.id === 'tbl_1')
  return t && t.kind === 'table' ? t.rows[0]?.cells[0]?.children?.[0] : undefined
}

// ============================================================
// 1. 复合 id 的拼装与解析
// ============================================================

section('复合 id：拼装 / 解析 / 拒绝非法输入')

eq(C.cellChildId('tbl_1', 'c_0_0'), 'child:tbl_1:c_0_0', '拼装：child:<tableId>:<cellId>')
eq(C.parseCellChildId('child:tbl_1:c_0_0')?.tableId, 'tbl_1', '解析：取回 tableId')
eq(C.parseCellChildId('child:tbl_1:c_0_0')?.cellId, 'c_0_0', '解析：取回 cellId')
/*
 * id 里带冒号时**用最后一个冒号切**（tableId 与 cellId 都是 `newId()` 生成的，本不含冒号；
 * 这条钉的是"将来万一允许"也不至于错位 —— 而不是"带冒号就解析失败"）。
 * 别把这条写成 `=== null`：那是把"更稳的实现"判成错的。
 */
{
  const weird = C.parseCellChildId(C.cellChildId('a b', 'c:d'))
  eq(weird?.tableId, 'a b:c', '解析：id 含冒号时按最后一个冒号切（tableId 吃掉前面的冒号）')
  eq(weird?.cellId, 'd', '解析：id 含冒号时 cellId = 最后一段')
}

/*
 * ⚠️ 下面四条是**否定式判据**，所以每一条都同时钉一个"肯定式对照"：
 * 只写 `eq(parse(x), null)` 的话，一个"永远返回 null"的实现也能全绿 —— 那样的守卫没有牙。
 */
eq(C.parseCellChildId('tbl_1'), null, '拒绝：普通元素 id 不是子元素')
eq(C.parseCellChildId('child:tbl_1'), null, '拒绝：只有两段（缺 cellId）')
eq(C.parseCellChildId('child:'), null, '拒绝：空的复合 id')
eq(C.parseCellChildId(''), null, '拒绝：空串')
eq(C.parseCellChildId(null), null, '拒绝：null（选中态的初始值）')
ok(C.parseCellChildId('child:tbl_1:c_0_0') !== null, '肯定式对照：同一组的合法输入确实能解析出来')

eq(C.isCellChildId('child:tbl_1:c_0_0'), true, 'isCellChildId：复合 id → true')
eq(C.isCellChildId('tbl_1'), false, 'isCellChildId：普通 id → false')
ok(C.isCellChildId('child:tbl_1:c_0_0') && !C.isCellChildId('tbl_1'), 'isCellChildId：两个方向都验过（不是恒真/恒假）')

// ============================================================
// 2. 只读定位
// ============================================================

section('findCellChild：定位')

{
  const doc = makeDoc(makeTable({ c_0_0: [img('img_1')] }))
  const hit = C.findCellChild(doc, 'child:tbl_1:c_0_0')
  eq(hit?.tableId, 'tbl_1', '定位：找到子元素时带回 tableId')
  eq(hit?.cellId, 'c_0_0', '定位：带回 cellId')
  eq(hit?.child.id, 'img_1', '定位：带回子元素本身')
  eq(hit?.band, 'header', '定位：带回**表所在的版式区**（写回要靠它）')
  eq(C.findCellChild(doc, 'child:tbl_1:c_1_1'), null, '定位：空格子 → null')
  eq(C.findCellChild(doc, 'child:nope:c_0_0'), null, '定位：表不存在 → null')
  eq(C.findCellChild(doc, 'child:tbl_1:c_nope'), null, '定位：格子不存在 → null')
  eq(C.findCellChild(doc, 'tbl_1'), null, '定位：非复合 id → null')
}

{
  // 表在**循环区**里也要能定位：版式区不能写死 header（这次真机就踩过"表在表头区/循环区"两种）
  const doc = makeDoc(makeTable({ c_0_0: [img('img_1')] }), 'loop')
  eq(C.findCellChild(doc, 'child:tbl_1:c_0_0')?.band, 'loop', '定位：表在循环区 → band = loop')
  const doc2 = makeDoc(makeTable({ c_0_0: [img('img_1')] }), 'footer')
  eq(C.findCellChild(doc2, 'child:tbl_1:c_0_0')?.band, 'footer', '定位：表在表尾区 → band = footer')
}

// ============================================================
// 3. 写回：只动那一格，别处原样
// ============================================================

section('patchCellChild：写回只影响目标那一格')

{
  const doc = makeDoc(makeTable({ c_0_0: [img('img_1', { w: 100, h: 'auto' })] }))
  const next = C.patchCellChild(doc, 'child:tbl_1:c_0_0', { w: 50 })
  ok(next !== null, '写回：合法 id → 返回新文档（不是 null）')
  eq(firstChild(next!)?.w, 50, '写回：目标子元素的字段被改到')
  eq(firstChild(next!)?.h, 'auto', '写回：没传的字段保持原值（不是被抹掉）')
  eq(firstChild(next!)?.id, 'img_1', '写回：id 不变（不能因为写回就换个新 id）')

  // 哨兵：别的版式区必须**引用不变**（结构共享），不然撤销栈里全是无关快照
  eq(next!.bands.loop.elements, doc.bands.loop.elements, '写回：其它版式区的数组引用不变（结构共享）')
  eq(next!.bands.footer, doc.bands.footer, '写回：表尾区引用不变')
  eq(next!.pageSetup, doc.pageSetup, '写回：pageSetup 引用不变')
  eq(next!.bands.header.length, 1, '写回：表头区仍然只有一张表（没被追加/丢掉）')

  // 原文件不能被就地改（纯函数）
  eq(doc.bands.header[0] && doc.bands.header[0].kind === 'table' ? doc.bands.header[0].rows[0].cells[0].children?.[0].w : 'x', 100, '写回：原文档没被就地修改（纯函数）')
}

{
  const doc = makeDoc(makeTable({ c_1_1: [img('img_1')] }))
  const next = C.patchCellChild(doc, 'child:tbl_1:c_1_1', { w: 25 })
  ok(next !== null, '写回：改第二行第二列 → 返回新文档')
  /* 收窄成非空：下面要连着读好几处，不然每一步都得写 `!`（而 `!` 会把真正的 null 藏起来） */
  if (next) {
    eq(firstChild(next, 'header'), undefined, '写回：改的是第二行第二列，第一格仍然空')
    const t = next.bands.header[0]
    eq(t && t.kind === 'table' ? t.rows[1]?.cells[1]?.children?.[0].w : null, 25, '写回：第二行第二列真的改到了')
  }
  eq(C.patchCellChild(doc, 'child:tbl_1:c_nope', { w: 1 }), null, '写回：定位失败 → null（不回退成整份覆盖）')
  eq(C.patchCellChild(doc, 'not-a-child-id', { w: 1 }), null, '写回：非复合 id → null')
}

// ============================================================
// 4. 摘掉 / 取出
// ============================================================

section('dropCellChild / takeOutCellChild')

{
  const doc = makeDoc(makeTable({ c_0_0: [img('img_1')] }))
  const next = C.dropCellChild(doc, 'child:tbl_1:c_0_0')
  ok(next !== null, '摘掉：返回新文档')
  eq(firstChild(next!), undefined, '摘掉：子元素没了')
  const t = next!.bands.header[0]
  eq(t && t.kind === 'table' ? (t.rows[0]?.cells[0]?.children ?? []).length : -1, 0, '摘掉：children 变成空数组（不是整格被删）')
  eq(t && t.kind === 'table' ? t.rows.length : -1, 2, '摘掉：行列数不变')
  ok(firstChild(doc) !== undefined, '摘掉：肯定式对照 —— 原文档里它还在（不然上面那条就是"本来就空"）')
}

{
  const doc = makeDoc(makeTable({ c_0_0: [img('img_1', { w: 100, h: 'auto' })] }))
  const out = C.takeOutCellChild(doc, 'child:tbl_1:c_0_0')
  ok(out !== null, '取出：返回 { doc, child }')
  eq(out?.child.id, 'img_1', '取出：带回子元素本身')
  eq(firstChild(out!.doc), undefined, '取出：原格子里已经摘掉')
  eq(C.takeOutCellChild(doc, 'child:tbl_1:c_1_1'), null, '取出：空格子 → null（不产生空提交）')
}

// ============================================================
// 5. 尺寸口径：百分比 / 盒高
// ============================================================

section('childWidthPct / childHeightMm：口径与容错')

eq(C.childWidthPct({ w: 100 } as AnyElement), 100, '宽度：100 → 100')
eq(C.childWidthPct({ w: 50 } as AnyElement), 50, '宽度：50 → 50')
eq(C.childWidthPct({ w: 200 } as AnyElement), 100, '宽度：超过 100 夹回 100（格内元素不许横向溢出）')
eq(C.childWidthPct({ w: 0 } as AnyElement), 100, '宽度：0 → 100（0 宽 = 看不见，必须兜住）')
eq(C.childWidthPct({ w: -5 } as AnyElement), 100, '宽度：负数 → 100')
eq(C.childWidthPct({ w: 3 } as AnyElement), C.MIN_CELL_CHILD_PCT, '宽度：过小抬到下限')
eq(C.childWidthPct({ w: Number.NaN } as AnyElement), 100, '宽度：NaN → 100（NaN 进 style 会让整条声明被丢）')
eq(C.childWidthPct({ w: undefined } as unknown as AnyElement), 100, '宽度：缺字段 → 100（老数据）')

eq(C.childHeightMm({ h: 12 } as AnyElement), 12, '高度：数字 → 数字')
eq(C.childHeightMm({ h: 'auto' } as AnyElement), null, '高度：auto → null（由内容决定）')
eq(C.childHeightMm({ h: 0 } as AnyElement), null, '高度：0 → null（0 = 由内容决定，不是"零高盒子"）')
eq(C.childHeightMm({ h: -3 } as AnyElement), null, '高度：负数 → null')

section('normalizeChildInCell / normalizeChildOutOfCell：跨边界换算')

{
  const free = img('img_1', { w: 40, h: 25 })
  const inside = C.normalizeChildInCell(free)
  eq(inside.w, 100, '进格子：宽度归一化成 100%（不是把 40mm 读成 40%）')
  eq(inside.h, 'auto', '进格子：高度改由内容决定')
  eq(inside.id, 'img_1', '进格子：id 不变')
  /* `dataUrl` 只在 image 这一类上；`AnyElement` 是联合类型，所以这里显式收窄一下再比 */
  eq((inside as { dataUrl?: string }).dataUrl, (free as { dataUrl?: string }).dataUrl, '进格子：内容字段原样带过去')
  eq(free.w, 40, '进格子：原来的自由层对象没被就地改（纯函数）')
}

{
  // 40mm 宽的一列，占 50% ⇒ 出格子应该是 20mm
  const out = C.normalizeChildOutOfCell(img('img_1', { w: 50, h: 'auto' }), 40)
  eq(out.w, 20, '出格子：50% × 40mm → 20mm（视觉宽度不跳）')
  eq(out.x, 0, '出格子：x 归零（格内没有坐标可言）')
  eq(out.y, 0, '出格子：y 归零')
  eq(out.h, 'auto', '出格子：h 原样（auto 在自由层同样合法）')
  eq(C.normalizeChildOutOfCell(img('i', { w: 100 }), 30).w, 30, '出格子：100% × 30mm → 30mm')
  eq(C.normalizeChildOutOfCell(img('i', { w: 50 }), 0).w, 10, '出格子：列宽拿不到（0）→ 用 20mm 兜底再算百分比')
  eq(C.normalizeChildOutOfCell(img('i', { w: 50 }), Number.NaN).w, 10, '出格子：列宽 NaN → 同样兜底，不出 NaN')
  ok(C.normalizeChildOutOfCell(img('i', { w: 50 }), 40).w > 0, '出格子：肯定式对照 —— 换算结果是个正数宽度')
}

// ============================================================
// 6. doc-bands：这次下沉出来的版式区原语（不能被漏在外）
// ============================================================

section('doc-bands：版式区读写（下沉后仍是一份实现）')

{
  const doc = makeDoc(makeTable(), 'loop')
  eq(D.readBand(doc, 'loop').length, 1, 'doc-bands：readBand(loop) 读到表')
  eq(D.readBand(doc, 'header')[0]?.id, 'sent_header', 'doc-bands：readBand(header) 读到表头区的哨兵')
  eq(D.findElement(doc, 'tbl_1')?.band, 'loop', 'doc-bands：findElement 找到循环区里的表')
  eq(D.findElement(doc, 'sent_header')?.band, 'header', 'doc-bands：findElement 找到表头区里的哨兵')
  eq(D.findElement(doc, 'nope'), null, 'doc-bands：找不到 → null')
  eq(D.findElement(doc, 'sent_header')?.el.id, 'sent_header', 'doc-bands：找到时带回元素本身')

  const dropped = D.dropElement(doc, 'sent_header')
  eq(D.findElement(dropped, 'sent_header'), null, 'doc-bands：dropElement 删掉了它')
  eq(D.findElement(dropped, 'tbl_1')?.band, 'loop', 'doc-bands：删一个不动另一个')
  eq(dropped.bands.header.length, 0, 'doc-bands：删完 header 为空数组')
  eq(D.findElement(doc, 'sent_header')?.band, 'header', 'doc-bands：dropElement 不改原文档')

  const moved = D.moveElementToBand(doc, 'sent_header', 'footer')
  eq(D.findElement(moved, 'sent_header')?.band, 'footer', 'doc-bands：moveElementToBand 移到了表尾区')
  eq(D.findElement(moved, 'sent_header')?.el.x, 5, 'doc-bands：搬家保留原坐标 x')
  eq(D.readBand(moved, 'header').length, 0, 'doc-bands：搬家后原区不再有它')
  eq(D.readBand(moved, 'footer').length, 2, 'doc-bands：搬家后目标区 = 原来的哨兵 + 搬来的它')
  eq(D.readBand(moved, 'footer').filter((e) => e.id === 'sent_header').length, 1, 'doc-bands：搬来的它只出现一次（没被复制两份）')

  const same = D.moveElementToBand(doc, 'sent_header', 'header')
  eq(same, doc, 'doc-bands：移到原区 → 返回同一个引用（不产生无意义的快照）')
  eq(D.moveElementToBand(doc, 'nope', 'footer'), doc, 'doc-bands：移不存在的 id → 原样返回（幂等）')

  const once = D.withBand(doc, 'footer', [img('only_1')])
  eq(D.readBand(once, 'footer').length, 1, 'doc-bands：withBand 写回表尾区')
  eq(D.readBand(once, 'footer')[0]?.id, 'only_1', 'doc-bands：写进去的就是给的那个元素')
  eq(D.readBand(once, 'header').length, 1, 'doc-bands：写一个区不动另一个区')
  /*
   * ⚠️ `offsetMm` 挂在 `bands.loop`（LoopBand）上，**不在** `readBand` 的返回值里 ——
   *    `readBand` 给的是元素数组。第一版把它写成 `readBand(...).offsetMm`，
   *    量到的是 `undefined`：那种"看着像在验结构、其实永远读不到"的断言没有牙。
   */
  eq(once.bands.loop.offsetMm, 15, 'doc-bands：写别的区时 loop 的 offsetMm 不能被抹掉')
  eq(D.readBand(once, 'loop').length, 1, 'doc-bands：循环区元素数不变（表还在）')
  eq(D.readBand(once, 'loop')[0]?.id, 'tbl_1', 'doc-bands：循环区里还是那张表，没被换成别的')
}

// ============================================================
// 7. cellWidthMm：百分比 ↔ mm 换算的**基准**（唯一实现）
// ============================================================

section('table-actions / cellWidthMm：这一格多宽')
{
  const TA = (await import(`${load}table-actions.ts`)) as typeof import('./table-actions')

  const simple = makeTable() // 列宽 [40, 60]
  eq(TA.cellWidthMm(simple, 'c_0_0'), 40, '格宽：第 1 列 → 40mm')
  eq(TA.cellWidthMm(simple, 'c_0_1'), 60, '格宽：第 2 列 → 60mm')
  eq(TA.cellWidthMm(simple, 'c_1_0'), 40, '格宽：第 2 行同一列 → 同样 40mm（与行无关）')
  eq(TA.cellWidthMm(simple, 'c_nope'), 100, '格宽：格子不存在 → 退回整表宽')
  eq(
    TA.cellWidthMm(makeTable({}, { colWidthsMm: [] }), 'c_0_0'),
    100,
    '格宽：列宽数组是空的 → 退回整表宽（不许返回 0，那会算出 0 宽的元素）',
  )
  eq(
    TA.cellWidthMm(makeTable({}, { colWidthsMm: [0, 0] }), 'c_0_0'),
    100,
    '格宽：列宽全是 0 → 同样退回整表宽',
  )

  /*
   * 合并单元格：**跨列之和**。这一条是 `colWidthsMm[colIdx]` 那种写法的死穴 ——
   * 数组下标 ≠ 网格列号（被合并覆盖的格子不在数组里），而错的方式是"尺寸差一点"，不报错。
   */
  {
    /*
     * ⚠️ 这张表必须是 **3 列**：第 1 格跨 2 列之后，第 2 格要落在第 3 个网格列上。
     *    第一版写成"2 列 + 第 1 格跨 2 列"，第 2 格就没地方放了（`tableGrid` 会跳过它），
     *    于是量到的是"退回整表宽"—— 被自己的测试拦下来了。
     */
    const merged: TableElement = {
      ...makeTable({}, { colWidthsMm: [40, 60, 30] }),
      rows: [
        {
          id: 'row_0',
          cells: [
            { id: 'm_0', colspan: 2, rowspan: 1, nodes: [] },
            { id: 'm_1', colspan: 1, rowspan: 1, nodes: [] },
          ],
        },
      ],
    }
    eq(TA.cellWidthMm(merged, 'm_0'), 100, '格宽：跨两列合并 → 40 + 60 = 100mm')
    eq(TA.cellWidthMm(merged, 'm_1'), 30, '格宽：合并旁边那格落在第 3 网格列 → 30mm')
    ok(
      TA.cellWidthMm(merged, 'm_0') !== TA.cellWidthMm(simple, 'c_0_0'),
      '【反向对照】合并格的宽度与第 1 列**不同**（否则上面那条可能是碰巧相等）',
    )
  }

  /* 它给的是"取出的基准"：100% 的子元素取出后应该正好等于格宽 */
  eq(
    C.normalizeChildOutOfCell(img('i', { w: 100 }), TA.cellWidthMm(simple, 'c_0_0')).w,
    40,
    '换算闭环：100% × 第 1 列格宽 40mm → 40mm（取出后与格内视觉宽度一致）',
  )
  eq(
    C.normalizeChildOutOfCell(img('i', { w: 50 }), TA.cellWidthMm(simple, 'c_0_1')).w,
    30,
    '换算闭环：50% × 第 2 列格宽 60mm → 30mm',
  )
}

// ============================================================
// 8. 本轮（2026-09-23 第二批）新增行为的守卫
// ============================================================

section('进格子：码要拿默认高度（否则跟着格宽长成大方块）')
{
  const qr = {
    id: 'qr_1',
    kind: 'qrcode' as const,
    x: 0,
    y: 0,
    w: 40,
    h: 30,
    source: { kind: 'static' as const, value: 'https://example.com' },
  } as unknown as AnyElement
  const inside = C.normalizeChildInCell(qr)
  eq(inside.w, 100, '进格子：码的宽度同样归一化成 100%')
  eq(inside.h, C.CELL_CHILD_CODE_H_MM, '进格子：码拿**默认高度**（不跟着格宽长成大方块，第 8 条）')
  ok(C.CELL_CHILD_CODE_H_MM > 0 && C.CELL_CHILD_CODE_H_MM <= 40, '默认高度是个"能看"的码尺寸（0..40mm）')
  /* 反向对照：图片仍然是"高度由内容决定"，码这条特例没有误伤图片 */
  eq(C.normalizeChildInCell(img('i2', { h: 30 })).h, 'auto', '【反向对照】图片仍然是 h=auto（码的特例没误伤图片）')
}

section('表格：新插入的列继承邻格样式（标题行效果不丢）')
{
  const TA = (await import(`${load}table-actions.ts`)) as typeof import('./table-actions')
  const base = makeTable({}, { colWidthsMm: [30, 40, 50] })
  /* 把首行设成标题行（带样式）后，在中间插一列 */
  const head = TA.setHeaderRowsPatch(base, { r1: 0, c1: 0, r2: 0, c2: 2 }, true)
  const withHead = { ...base, ...head!.patch } as TableElement
  const ins = TA.insertColAt(withHead, 1, 'right')
  ok(ins !== null, '插列：返回补丁')
  const rows = (ins!.patch.rows ?? []) as TableRow[]
  eq(rows[0]?.cells[2]?.style?.bold, true, '插列：**标题行里的新格子继承了加粗**（第 4 条）')
  eq(rows[0]?.cells[2]?.style?.background, '#f2f3f5', '插列：底纹也继承（不然白底一眼就看出来）')
  ok(
    (rows[1]?.cells[2]?.style?.bold ?? false) === false,
    '【反向对照】数据行里的新格子**没有**被顺手加粗（只继承邻格，不是无脑套标题样式）',
  )
}

section('表格：标题行 / 标题列是两个独立的位（角格不再被连带清掉）')
{
  const TA = (await import(`${load}table-actions.ts`)) as typeof import('./table-actions')
  const base = makeTable()

  /* 只开标题行 ⇒ 标题列那一位必须还是 false（第 5 条的根子） */
  const rowOnly = { ...base, ...TA.setHeaderRowsPatch(base, { r1: 0, c1: 0, r2: 0, c2: 1 }, true)!.patch } as TableElement
  eq(TA.isFirstColHeaderStyled(rowOnly), false, '只勾标题行 ⇒ 标题列**仍是未勾**（不再从角格样式反推）')
  eq(TA.isHeaderCellAt(rowOnly, 'c_0_0'), true, '只勾标题行 ⇒ 角格算标题格（不许插字段）')

  /* 再开标题列，然后关掉标题行：角格必须留着标题样式 */
  const both = { ...rowOnly, ...TA.setHeaderColPatch(rowOnly, true)!.patch } as TableElement
  eq(TA.isFirstColHeaderStyled(both), true, '勾上标题列 ⇒ 读回来是 true')
  eq(TA.isHeaderCellAt(both, 'c_1_0'), true, '标题列里的格子（第 2 行第 1 列）也算标题格')
  const rowOff = { ...both, ...TA.setHeaderRowsPatch(both, { r1: 0, c1: 0, r2: 0, c2: 1 }, false)!.patch } as TableElement
  eq(rowOff.rows[0]?.cells[0]?.style?.bold, true, '取消标题行**不动角格**（它还属于标题列，第 5 条）')
  eq(rowOff.headerCol, true, '取消标题行不影响 headerCol 这一位')

  /* 反过来：关标题列时，角格（行还开着）也不许被清 */
  const colOff = { ...both, ...TA.setHeaderColPatch(both, false)!.patch } as TableElement
  eq(colOff.rows[0]?.cells[0]?.style?.bold, true, '取消标题列**不动角格**（它还属于标题行）')
  eq(colOff.rows[1]?.cells[0]?.style?.bold ?? false, false, '取消标题列确实清掉了第 2 行第 1 列（不是整列都不动）')
}

// ============================================================
// 9. 断言名唯一（本项目的一条纪律）
// ============================================================

section('结构：断言名必须唯一')
{
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  ok(dup.length === 0, '断言名唯一（重名会让失败行指向错误的断言）', dup)
}

console.log(`\n${'='.repeat(54)}`)
if (failures.length === 0) {
  console.log(`✅ 格内子元素自测全部通过：${passed} 项`)
  console.log(`${'='.repeat(54)}`)
} else {
  console.log(`❌ 格内子元素自测：${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
  for (const f of failures) console.log(`   · ${f}`)
  console.log(`${'='.repeat(54)}`)
  throw new Error(`格内子元素自测失败：${failures.length} 项`)
}
