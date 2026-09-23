/**
 * 骨架库自测：结构正确性 + 版式正确性。
 *
 * 光"能构建"不算数 —— 骨架最容易出的问题是**元素重叠或间距错乱**，
 * 而那只有把骨架真的渲染一遍、看每个块落到了哪里才能发现。
 * 所以这里对每个骨架都跑一次 renderDocument，并断言：
 *   · 没有 NaN（NaN 会让浏览器整条丢弃样式声明）
 *   · 块按 y 排序后**互不重叠**（这正是刚修掉的那个布局 bug 的回归防线）
 *   · 块都落在纸张版心范围内
 *   · 字段绑定符合预期（有匹配字段时绑定，没有时留未绑定而不是丢格）
 *
 * 运行：esbuild 打包成 cjs 后 node 执行
 */

import { renderDocument } from '../src/render/pipeline'
import { SKELETONS, buildSkeleton, countUnbound, contentWidthMm } from '../src/lib/skeletons'
import { emptyRenderContext } from '../src/render/context'
import { contentBoxSize } from '../src/lib/types'
import type { FieldMeta, RecordItem } from '../src/lib/data-source'

let pass = 0
const failures: string[] = []

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

/** 覆盖常见中文单据字段名的一组字段（骨架里声明的候选名必须全部能命中） */
const FIELDS: FieldMeta[] = [
  { id: 'f1', name: '单号', type: 1, isPrimary: true },
  { id: 'f2', name: '日期', type: 5 },
  { id: 'f3', name: '供应商', type: 1 },
  { id: 'f4', name: '产品名称', type: 1 },
  { id: 'f5', name: '规格型号', type: 1 },
  { id: 'f6', name: '数量', type: 2 },
  { id: 'f7', name: '单位', type: 1 },
  { id: 'f8', name: '备注', type: 1 },
  { id: 'f9', name: '部门', type: 1 },
  { id: 'f10', name: '巡检区域', type: 1 },
  { id: 'f11', name: '验收结论', type: 1 },
  { id: 'f12', name: '仓库', type: 1 },
  { id: 'f13', name: '经办人', type: 1 },
  { id: 'f14', name: '联系电话', type: 13 },
  { id: 'f15', name: '验收人', type: 1 },
  { id: 'f16', name: '采购单号', type: 1 },
  { id: 'f17', name: '产品批号', type: 1 },
  { id: 'f18', name: '领用部门', type: 1 },
  { id: 'f19', name: '领料人', type: 1 },
  { id: 'f20', name: '用途', type: 1 },
  { id: 'f21', name: '物料编码', type: 1 },
  { id: 'f22', name: '巡检人', type: 1 },
  { id: 'f23', name: '班次', type: 1 },
  { id: 'f24', name: '设备编号', type: 1 },
  { id: 'f25', name: '检查项目', type: 1 },
  { id: 'f26', name: '结果', type: 1 },
  { id: 'f27', name: '名称', type: 1 },
  { id: 'f28', name: '编号', type: 1 },
  { id: 'f29', name: '合计数量', type: 2 },
  { id: 'f30', name: '入库数量', type: 2 },
]

function makeRecords(n: number): RecordItem[] {
  return Array.from({ length: n }, (_, i) => ({
    recordId: `r${i}`,
    fields: {
      f1: `RK-2026${String(i + 1).padStart(4, '0')}`,
      f2: Date.now() + i * 86400000,
      f3: '昆明某某供应商',
      f4: `产品名称${i + 1}`,
      f5: 'BTN-A-1001 / 50g',
      f6: (i + 1) * 12,
      f7: '箱',
      f8: '外观完好，无破损',
      f9: '生产部',
      f10: '灌装车间 A 区',
      f11: '合格',
      f12: '马金铺中央仓',
    },
  }))
}

async function checkSkeleton(key: string, fields: FieldMeta[], records: RecordItem[]): Promise<void> {
  const def = SKELETONS.find((s) => s.key === key)
  if (!def) {
    ok(`${key} 存在`, false)
    return
  }
  const doc = buildSkeleton(key, fields)
  const w = contentWidthMm(doc.pageSetup)
  const { h: contentH } = contentBoxSize(doc.pageSetup)

  // ---- 结构断言 ----
  const all = [...doc.bands.header, ...doc.bands.loop.elements, ...doc.bands.footer]
  if (key.startsWith('blank')) {
    // 空白骨架本来就是空的，别把"空"当失败
    ok(`${key} 是空白模板`, all.length === 0, `元素数 ${all.length}`)
    return
  }
  ok(`${key} 有元素`, all.length > 0, `元素数 ${all.length}`)
  ok(
    `${key} 元素 x 不越界`,
    all.every((e) => e.x >= -0.01 && e.x + e.w <= w + 0.51),
    all.filter((e) => e.x + e.w > w + 0.51).map((e) => `${e.kind}:${e.x}+${e.w}`).join(','),
  )
  ok(
    `${key} 循环区元素 y 严格递增（不重叠、无幽灵同排）`,
    (() => {
      const loop = [...doc.bands.loop.elements].sort((a, b) => a.y - b.y)
      for (let i = 1; i < loop.length; i++) {
        if (loop[i].y < loop[i - 1].y + 0.5) return false
      }
      return true
    })(),
    doc.bands.loop.elements.map((e) => `y=${e.y}`).join(','),
  )
  ok(
    // 表格例外：表格的真实高度必须由行高推出（显式 h 只是下限），所以它保留 'auto' 是对的
    `${key} 非表格元素都给了显式数字高度（否则浏览器实测值会与游标估算不一致）`,
    all.filter((e) => e.kind !== 'table').every((e) => typeof e.h === 'number'),
    all.filter((e) => e.kind !== 'table' && typeof e.h !== 'number').map((e) => e.kind).join(','),
  )
  // ⚠️ 用 def.kind 而不是 doc.kind —— `TemplateDoc` 上**没有** kind 字段，
  // 早先这里写成 `doc.kind === 'view'` 导致整块断言是死代码（永远不执行、
  // 计数也不增长，所以"85 项全过"看起来一切正常）。视图骨架因此一直没被检查，
  // 列头与循环区重叠的 bug 才漏了过去。
  if (def.kind === 'view') {
    ok(`${key} 视图模板有表尾（页码）`, doc.bands.footer.length > 0)
    ok(`${key} loop.offsetMm 为正`, doc.bands.loop.offsetMm > 0, String(doc.bands.loop.offsetMm))
    // ⚠️ 回归防线：offsetMm 必须 ≥ 重复区里**最后一个元素的 y**。
    // 早先用 hOf(el) 逐元素累加时，表格的 h 是 'auto' 被当成 0，
    // 导致 offsetMm 偏小 → 画布上列头表格与循环区表格叠在一起（导出侧看不出来）。
    const headerLastY = doc.bands.header.reduce((m, e) => Math.max(m, e.y), 0)
    ok(
      `${key} loop.offsetMm 不早于重复区末尾（否则画布上会与列头重叠）`,
      doc.bands.loop.offsetMm >= headerLastY + 1,
      `offsetMm=${doc.bands.loop.offsetMm}，重复区最后元素 y=${headerLastY}`,
    )
  }

  // ---- 渲染断言 ----
  const ctx = emptyRenderContext({
    fields,
    fieldMap: new Map(fields.map((f) => [f.id, f])),
    today: '2026-09-15',
    totalRows: records.length,
  })
  const out = await renderDocument({
    doc,
    records,
    ctx,
    skipMeasure: true, // Node 无 DOM
    forPreview: false,
    title: key,
  })

  ok(`${key} 渲染有页`, out.pages.length >= 1, String(out.pages.length))
  ok(`${key} 输出不含 NaN`, !out.html.includes('NaN'))

  let overlap: string | null = null
  let outOfBounds: string | null = null
  for (const p of out.pages) {
    const sorted = [...p.blocks].sort((a, b) => a.yMm - b.yMm || a.xMm - b.xMm)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      // 只检查"纵向堆叠"的块（x 区间重叠才算真正压在一起）
      const xOverlap = cur.xMm < prev.xMm + prev.wMm - 0.5
      if (xOverlap && cur.yMm < prev.yMm + prev.hMm - 0.5) {
        overlap = `第${p.index + 1}页 ${prev.kind}(y=${prev.yMm.toFixed(1)},h=${prev.hMm.toFixed(1)}) 与 ${cur.kind}(y=${cur.yMm.toFixed(1)}) 重叠`
        break
      }
    }
    if (overlap) break
    for (const b of p.blocks) {
      if (b.yMm + b.hMm > contentH + 1) {
        outOfBounds = `第${p.index + 1}页 ${b.kind} 底部 ${(b.yMm + b.hMm).toFixed(1)} > 版心高 ${contentH.toFixed(1)}`
        break
      }
    }
    if (outOfBounds) break
  }
  ok(`${key} 无块重叠`, overlap === null, overlap ?? '')
  ok(`${key} 无块超出页高`, outOfBounds === null, outOfBounds ?? '')

  // ---- 字段绑定断言 ----
  const { total, unbound } = countUnbound(doc)
  ok(`${key} 含字段占位符`, total > 0, String(total))
  ok(
    `${key} 候选名能覆盖常见字段（未绑定 ${unbound}/${total}）`,
    unbound === 0,
    `有占位符没绑上，说明候选名没覆盖到：${unbound}/${total}`,
  )
}

async function main(): Promise<void> {
  const one = makeRecords(1)
  const many = makeRecords(8)

  console.log('【结构 + 渲染】逐骨架检查')
  for (const s of SKELETONS) {
    await checkSkeleton(s.key, FIELDS, s.kind === 'view' ? many : one)
  }

  console.log('\n【字段缺失时的降级】给一张完全无关的表')
  const alien: FieldMeta[] = [
    { id: 'x1', name: '工号', type: 1, isPrimary: true },
    { id: 'x2', name: '照片', type: 17 },
  ]
  const doc = buildSkeleton('doc-acceptance', alien)
  const { total, unbound } = countUnbound(doc)
  ok('无关表上仍生成完整单据结构', total > 0)
  ok('字段对不上时留未绑定（而不是丢掉整格）', unbound === total, `${unbound}/${total}`)

  console.log('\n【未知 key 兜底】')
  const fb = buildSkeleton('__not_exist__', FIELDS, 'view')
  ok(
    '未知 key 回退成空白模板而不抛错',
    fb.bands.loop.elements.length === 0 && fb.bands.header.length === 0 && fb.bands.footer.length === 0,
    `元素数 ${fb.bands.loop.elements.length}`,
  )

  console.log('\n' + '='.repeat(52))
  if (failures.length === 0) console.log(`✅ 全部通过：${pass} 项`)
  else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log('='.repeat(52))
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('自测崩溃：', e)
  process.exit(1)
})
