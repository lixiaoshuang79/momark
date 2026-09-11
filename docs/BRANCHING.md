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

## 提交信息

Conventional commits：`feat(ui): …` / `fix(muya): …`，描述用中文。

## 版本 tag

- 格式 `momark/<x.y.z>`（前缀与上游 marktext 的 `v*` tag 区分，避免冲突）
- 只在验收通过、合入 `main` 之后打
- 当前基线：`momark/1.2.0`（V1.2.0 正式发布：网页 PC/移动端切换 + 分屏顶部紧凑；历史：`momark/0.1.0` 13 项定制清单全量验收、`momark/1.0.0` 首个正式发布、`momark/1.1.0` HTML 内嵌渲染与分屏优化）

## 验收约定

- 构建产物路径由开发者**报告**，用户自行打开验收；开发者不自动安装到 `/Applications`
- 交付安装包（dmg/zip）放 OneDrive `deepseek/2026-09-05/momark-electron/`

## 远端说明

- `origin` → github.com/lixiaoshuang79/momark（发布仓库）
- `upstream` → github.com/marktext/marktext（上游同步用）
- `hub` → 本地 bare 仓库（多 agent 协作中枢），仅开发期共享，不推送 GitHub
