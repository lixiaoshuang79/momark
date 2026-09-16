# 分支与发布规范

## 分支模型

| 分支          | 用途                                                    |
| ------------- | ------------------------------------------------------- |
| `main`        | 主干 = 已验收可交付状态。**禁止直接提交**，只接受合并。 |
| `feat/<主题>` | 新功能 / 需求轮次，kebab-case，如 `feat/table-ime`      |
| `fix/<主题>`  | 缺陷修复，如 `fix/theme-merge`                          |

## 每轮开发流程

1. `git checkout main && git pull`
2. `git checkout -b feat/<主题>`
3. 开发 + 自验（CDP 逐项验证）
4. 构建产物，把 **app 路径报告给用户**，由用户自行打开人工验收
5. 验收通过 → 合入 `main` → 打 tag → 推送 `origin`

## 打包铁律：必须经 pnpm 触发

`pnpm build:mac*` / `pnpm exec electron-builder` —— **不要**在 `packages/desktop`
下用 `npm run` 触发打包。electron-builder 26 先按 `package.json#packageManager`
（根 `pnpm@10.33.4`）+ lockfile 探测包管理器，探测不到才退回环境变量；从
`packages/desktop` 用 npm 触发时两者都拿不到，判定为 npm → 用 npm 收集依赖树 →
在 pnpm 树上报 `ELSPROBLEMS` / `extraneous` → **静默丢掉平台可选依赖**：
`@vscode/ripgrep-darwin-arm64` 不进 asar，成品启动即弹「A JavaScript error
occurred in the main process: Could not find @vscode/ripgrep-darwin-arm64」。
判别方法：打包日志出现 `detected workspace root for project using packageManager
field pm=pnpm` 才对；成品自检 `npx asar list …/app.asar | grep ripgrep-darwin-arm64`。

## 提交信息

Conventional commits：`feat(ui): …` / `fix(muya): …`，描述用中文。

## 版本 tag

- 格式 `momark/<x.y.z>`（前缀与上游 marktext 的 `v*` tag 区分，避免冲突）
- 只在验收通过、合入 `main` 之后打
- 当前基线：`momark/1.2.3`（V1.2.3：右栏网页面板 dock 地址栏几何与快捷键归属——多页态「+」hover 即展开且与 Dock 同列右对齐、⌘+/⌘-/⌘0 归属按焦点判定（面板网页态缩放网页、编辑器聚焦时保留段落级别快捷键）、底部缩放改为显式菜单；历史：`momark/1.2.2` 右栏网页面板三处体验修复——SPA 路由后底部地址栏同步、Cmd +/-/0 缩放网页、适应面板宽度双向跟随；`momark/1.2.1` 右栏 Cmd+S 保存、dock 悬停关闭、新建未命名文档分栏、网址栏点击不收起、底部地址栏回车建页；`momark/1.2.0` 网页 PC/移动端切换 + 分屏顶部紧凑；`momark/0.1.0` 13 项定制清单全量验收、`momark/1.0.0` 首个正式发布、`momark/1.1.0` HTML 内嵌渲染与分屏优化）

## 验收约定

- 构建产物路径由开发者**报告**，用户自行打开验收；开发者不自动安装到 `/Applications`
- 交付安装包（dmg/zip）放 OneDrive `deepseek/2026-09-05/momark-electron/`

## 远端说明

- `origin` → github.com/lixiaoshuang79/momark（发布仓库）
- `upstream` → github.com/marktext/marktext（上游同步用）
- `hub` → 本地 bare 仓库（多 agent 协作中枢），仅开发期共享，不推送 GitHub
