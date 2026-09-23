/// <reference types="vite/client" />

/** 构建期由 vite define 注入的版本号（见 vite.config.ts） */
declare const __APP_VERSION__: string

declare module '*.svg' {
  const src: string
  export default src
}
