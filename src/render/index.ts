/**
 * 渲染与分页引擎的公共入口。
 *
 * 使用顺序（对应 PRD BP-5）：
 *   1. 取数 + **重新获取附件图片 URL**（在进入预览前，见 BP-6），构造 RenderContext；
 *   2. `renderDocument()` 拿到 RenderedDoc（pages / html / warnings）；
 *   3. 预览：把 `doc.html` 直接注入预览 iframe（不要另写一套 React 渲染，否则必然与打印不一致）；
 *   4. 打印：`printDocument(doc.html, ...)`；导出：`exportPdf(doc.html, ...)`；
 *   5. 收尾：`releaseObjectUrls()` 释放全部图片 blob。
 */

export type {
  ResolvedImage,
  RenderContext,
  RenderWarning,
  RenderWarningKind,
  PageModel,
  PlacedBlock,
  RenderedDoc,
} from './context'
export { imageKey, emptyRenderContext, dedupeWarnings } from './context'

export type {
  MeasuredBlock,
  MeasuredRow,
  MeasuredTableRow,
  RecordGroup,
  LayoutInput,
  LayoutResult,
} from './layout'
export { paginate, paginatePages, groupIntoRows, PAGE_EPS } from './layout'

export type { RenderScope, AttachmentItem, AttachmentLayoutResult, RenderElementResult, HtmlOptions } from './html'
export {
  FONT_STACK,
  escapeHtml,
  renderInline,
  renderElement,
  renderTableRows,
  tableRepeatHeader,
  tableHeaderRowCount,
  layoutAttachmentGroup,
  buildDocumentHtml,
  contentBoxOf,
  PAGE_TOKENS,
} from './html'

export type { MeasureItem, MeasuredBox, MeasureHost, MeasureOptions } from './measure'
export { canMeasure, createMeasureHost, measureBlocks } from './measure'

export type { QrOptions, BarcodeOptions } from './code-elements'
export { qrCodeSvg, barcodeSvg, isCode128Encodable, utf8ByteLength, QR_MAX_BYTES } from './code-elements'

export type { PipelineInput } from './pipeline'
export { renderDocument } from './pipeline'

export type { PrintOptions, ExportResult, ExportStatus } from './print'
export {
  printDocument,
  exportPdf,
  saveHtmlFile,
  triggerDownload,
  releaseObjectUrls,
  PDF_GUIDANCE,
} from './print'
