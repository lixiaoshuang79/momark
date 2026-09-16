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
- 当前基线：`momark/1.2.4`（V1.2.4：底部缩放按钮单行化（原 grid 基类把「状态读数 + caret」排成两行）+ 多页 Dock「+」hover 展开动效与单页悬浮落点完全一致（同一 0.46s + --ease-grow 过渡，原先 dock 是瞬弹）；历史：`momark/1.2.3` 右栏网页面板 dock 地址栏几何与快捷键归属——多页态「+」hover 即展开且与 Dock 同列右对齐、⌘+/⌘-/⌘0 归属按焦点判定（面板网页态缩放网页、编辑器聚焦时保留段落级别快捷键）、底部缩放改为显式菜单；历史：`momark/1.2.2` 右栏网页面板三处体验修复——SPA 路由后底部地址栏同步、Cmd +/-/0 缩放网页、适应面板宽度双向跟随；`momark/1.2.1` 右栏 Cmd+S 保存、dock 悬停关闭、新建未命名文档分栏、网址栏点击不收起、底部地址栏回车建页；`momark/1.2.0` 网页 PC/移动端切换 + 分屏顶部紧凑；`momark/0.1.0` 13 项定制清单全量验收、`momark/1.0.0` 首个正式发布、`momark/1.1.0` HTML 内嵌渲染与分屏优化）

## 验收约定

- 构建产物路径由开发者**报告**，用户自行打开验收；开发者不自动安装到 `/Applications`
- 交付安装包（dmg/zip）放 OneDrive `deepseek/2026-09-05/momark-electron/`

## GitHub Release 铁律：每一版都必须发

**只推 tag 不算交付。** 每次合入 `main`、打完 tag 之后，必须同步在 GitHub 上为这个 tag 建立 Release，
并把 dmg / zip 作为附件上传（`momark/1.0.0`、`1.2.0`、`1.2.1` 的 Release 都带附件；`1.2.2` / `1.2.3`
漏发，用户 2026-09-16 因此追问「release 也得更新啊」）。

约定：

- 标题 `墨记 V<x.y.z>`，tag 用已推上 `origin` 的 `momark/<x.y.z>`，target `main`
- 正文含：一句话产品定位 → 本版改了什么（分「修复与优化」，按面板/模块分组）→「## 安装」段
  （下载 dmg/zip、拖入「应用程序」、arm64 架构说明、未公证签名的 `xattr -cr /Applications/墨记.app`）
- 附件命名与 OneDrive 一致：`momark-mac-arm64-<x.y.z>.dmg` + `.zip`（dmg 用 `application/octet-stream`，
  zip 用 `application/zip`）
- **若中间版本漏发 Release，最新一版的正文要把这些改动一并收录**（用户看到的是 1.2.1 → 最新版），
  并在回复里说明漏发的版本
- 本机无 `gh` CLI：用 REST API 建 Release 与传附件，令牌取钥匙串里既有的 GitHub 凭据
  （`printf "protocol=https\nhost=github.com\n\n" | git credential fill`），**不要把令牌写进文件或输出**

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | awk -F= '/^password=/{print substr($0,10)}')
# 建 Release（正文用 --data-binary @file，避免中文被 shell 转义）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/lixiaoshuang79/momark/releases --data-binary @release.json
# 传附件（uploads.github.com，大文件用 -T 流式上传，别 --data-binary 整个读进内存）
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  -T momark-mac-arm64-<x.y.z>.dmg \
  "https://uploads.github.com/repos/lixiaoshuang79/momark/releases/<id>/assets?name=momark-mac-arm64-<x.y.z>.dmg"
```

## 远端说明

- `origin` → github.com/lixiaoshuang79/momark（发布仓库）
- `upstream` → github.com/marktext/marktext（上游同步用）
- `hub` → 本地 bare 仓库（多 agent 协作中枢），仅开发期共享，不推送 GitHub
