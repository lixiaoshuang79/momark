# MoMark 墨记

墨记（MoMark）是一款基于 [MarkText](https://github.com/marktext/marktext) 深度定制的 **Electron Markdown 编辑器**，使用全新 TypeScript Muya 引擎（@muyajs/core），按 Claude 风格设计语言重塑界面。

> 上游：marktext/marktext（MIT License © 2017-present Luo Ran）

## 定制特性（相对上游）

- **品牌**：App 名「墨记」、三角形底 + DeepSeek 鲸鱼角标 App 图标、Claude 风格主题（墨蓝 `#3D5A80`、Anthropic 字体、画布 `#FCFCFB`）
- **界面**：左右侧栏非线性滑块动效、右侧「网页/文档」双模面板、标签拖拽分屏、`+` 按钮一体两态展开搜索栏、dock 网页 hover 关闭、全局滚动条美化
- **中文**：底栏状态 / 侧栏 / 面板全量中文化，默认语言 zh-CN
- **修复**：表格单元格 IME 中文输入（空单元格渲染、多段合成追加、光标回跳）
- **隔离**：运行时数据目录 `~/Library/Application Support/墨记`，与上游 marktext 互不影响

## 开发

```bash
pnpm install   # pnpm 10.x，Node 22
pnpm dev       # 开发实例（渲染进程 localhost:9333）
```

## 构建（macOS）

```bash
pnpm build:mac          # 默认 arm64，或 build:mac:arm64 / build:mac:x64
```

产物：

- App：`dist/mac-arm64/墨记.app`
- 安装包：`dist/momark-mac-arm64-0.1.0.dmg` / `momark-mac-arm64-0.1.0.zip`

## 分支与版本

见 [docs/BRANCHING.md](docs/BRANCHING.md)。约定概览：

- `main` 只进合并，不做直接提交
- 开发分支 `feat/<主题>`、`fix/<主题>`，验收通过后合入
- 验收版本打 tag `momark/<x.y.z>`（当前基线 `momark/0.1.0`）

## License

[MIT](LICENSE)，继承上游 © 2017-present Luo Ran；墨记定制部分 © 2026 MoMark。
