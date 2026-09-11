# packages —— 多包工作区

墨记的 pnpm monorepo 工作区，包含桌面端、编辑器引擎、引擎构建产物与官网四个包：

| 包        | 说明                                       |
| --------- | ------------------------------------------ |
| `desktop` | Electron 桌面端（主进程 + Vue 3 渲染进程） |
| `muya`    | Muya 编辑器引擎（TypeScript 重写版）       |
| `muyajs`  | Muya 引擎构建产物（发布为 @muyajs/core）   |
| `website` | 官网 / 文档站                              |

依赖编排见根目录 `pnpm-workspace.yaml`。
