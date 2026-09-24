/// <reference types="vite/client" />

/** 构建期由 vite define 注入的版本号（见 vite.config.ts） */
declare const __APP_VERSION__: string
/** 这份产物是**什么时候**构建/启动的（ISO 字符串）—— 排障用，见 `vite.config.ts` 的 define */
declare const __BUILD_TIME__: string

declare module '*.svg' {
  const src: string
  export default src
}
