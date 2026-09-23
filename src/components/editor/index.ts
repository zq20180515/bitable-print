/**
 * 在线模板编辑器（PRD F2 / P3）公共出口。
 *
 * 使用方式：
 *   import { EditorShell } from './components/editor'
 *   <EditorShell doc={doc} fields={fields} templateName={name}
 *                onChange={setDoc} onDone={save} onCancel={back} />
 *
 * 样式随模块一起注入，调用方不需要单独 import css。
 */

import './editor.css'

export { EditorShell, default } from './EditorShell'
export type { EditorShellProps } from './EditorShell'

export { Canvas } from './Canvas'
export type { CanvasProps, CanvasHandle, DropHit } from './Canvas'

export { Palette } from './Palette'
export type { PaletteProps, PaletteTab, PaletteDrag, PaletteInsert } from './Palette'

export { Inspector } from './Inspector'
export type { InspectorProps } from './Inspector'

export { Popover } from './Popover'
export type { PopoverProps } from './Popover'

export {
  CapsuleSelect,
  ColorInput,
  Field,
  FieldPicker,
  Num,
  Section,
  Seg,
  Switch,
} from './Controls'
export type { CapsuleOption, FieldPickerProps, SegOption } from './Controls'

export {
  analyzeTemplate,
  applyDefaultTextStyle,
  computeBandLayout,
  createDefaultElement,
  elementHeightMm,
  elementLabel,
  findElement,
  nodesToText,
  readBand,
  textToNodes,
  useEditorState,
  BAND_HINT,
  BAND_LABEL,
  ELEMENT_LABEL,
  MAX_HISTORY,
  MERGE_WINDOW_MS,
  SYSVAR_KEYS,
  SYSVAR_LABEL,
} from './useEditorState'
export type {
  BandKey,
  BandLayout,
  EditorApi,
  FoundElement,
  IssueKind,
  NewElementSpec,
  TemplateAnalysis,
  TemplateIssue,
  UseEditorStateArgs,
} from './useEditorState'
