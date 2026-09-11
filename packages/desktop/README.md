# desktop —— Electron 桌面端

墨记（MoMark）桌面应用。主进程（TypeScript / Node）与渲染进程（Vue 3 + Pinia）构成，基于 electron-vite 构建，支持 macOS arm64 / x64。

- 构建：`pnpm build:mac`，产物为 `dist/mac-arm64/墨记.app` 与对应 dmg / zip
- 开发：`pnpm dev`
- 目录：`src/main`（主进程）、`src/renderer`（渲染进程）、`static/`（图标、字体、locale 与默认偏好种子）
