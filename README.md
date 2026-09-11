<p align="center">
  <img src="packages/desktop/static/logo-96px.png" alt="MoMark 墨记" width="96" />
</p>

<h1 align="center">墨记 MoMark</h1>

<p align="center">
  基于 MarkText 深度定制的 macOS Markdown 编辑器 —— 新一代 TypeScript Muya 引擎 · Claude 风格设计语言
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.0-3D5A80" alt="version" />
  <img src="https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20x64-lightgrey" alt="platform" />
  <img src="https://img.shields.io/badge/license-MIT-7BA3C9" alt="license" />
  <img src="https://img.shields.io/github/stars/lixiaoshuang79/momark?style=social" alt="stars" />
</p>

## 简介

墨记（MoMark）是 [MarkText](https://github.com/marktext/marktext) 的深度定制分支。它在保留 MarkText 完整 Markdown 编辑能力的基础上，全面重塑了视觉与交互：界面遵循 Claude 风格设计语言，同时针对中文写作场景修复了大量上游遗留问题。

编辑内核采用 Muya 的 TypeScript 重写版（`@muyajs/core`）——基于块结构（block-based）的编辑器引擎，为组件化扩展预留了清晰边界。

## ✨ 特性

### 设计语言

- **Claude 风格主题**：墨蓝 `#3D5A80` 主色、Anthropic 字体、暖白画布 `#FCFCFB`
- **侧栏**：左右侧栏非线性滑块动效，左侧栏支持拖拽调宽
- **滚动条**：全局极简化设计——细线滑块，滚动时淡入淡出

### 分屏工作流

- **标签拖拽分屏**：左右两栏并行编辑文档，标签页拖拽即可分屏/合屏
- **边距规范**：外侧 2.5% 起始内边距、内侧贴分隔线，保证文档与分隔线的视觉对齐
- **滚动条布局**：左栏滚动条居中于分屏分隔带，不侵占文档内容区

### 右侧面板

- **双模面板**：任意网页浏览与文档阅读一键切换
- **面板交互**：网页卡片 hover 关闭、dock 面板卡片化

### 编辑体验

- **HTML 内嵌渲染**：HTML 代码块以 iframe 实时预览，支持右下角缩放控制（50%–200%）与拖拽调整视口
- **中文 IME 修复**：表格单元格中文输入全链路修复（空单元格渲染、多段合成追加、光标回跳）；软换行场景 IME 提交内容完整保留（上游 #5279）
- **分屏渲染稳定**：本地文件 iframe 双开加载竞态修复，左右文档图表均可靠渲染

### 中文本地化

- 界面全量中文化，默认语言 zh-CN
- 运行时数据目录与上游隔离（`~/Library/Application Support/墨记`），互不影响

## 安装

下载对应平台的构建产物，将 `墨记.app` 拖入「应用程序」。

> macOS 版本当前未做公证签名，首次打开若提示「已损坏」，执行：
>
> ```bash
> xattr -cr /Applications/墨记.app
> ```

## 从源码构建

前置要求：Node.js ≥ 20.19（推荐 22）、pnpm ≥ 10

```bash
pnpm install
pnpm build:mac          # 默认 arm64；另有 build:mac:x64
```

产物：

- 应用：`dist/mac-arm64/墨记.app`
- 安装包：`dist/momark-mac-arm64-1.1.0.dmg` / `dist/momark-mac-arm64-1.1.0.zip`

## 开发

```bash
pnpm dev      # 开发实例，渲染进程运行于 localhost:9333
```

技术栈：Electron · Vue 3 · Pinia · TypeScript，pnpm monorepo 组织桌面端与引擎包。

## 项目结构

| 目录               | 说明                                        |
| ------------------ | ------------------------------------------- |
| `packages/desktop` | Electron 桌面端（主进程 + 渲染进程）        |
| `packages/muya`    | Muya 编辑器引擎（TypeScript，@muyajs/core） |
| `packages/muyajs`  | Muya 引擎构建输出                           |
| `packages/website` | 官网 / 文档站                               |
| `docs/`            | 架构、分支规范、路线图等文档                |

## 与上游 MarkText 的关系

本项目 fork 自 [marktext/marktext](https://github.com/marktext/marktext)。上游当前处于 0.20.0 开发期（新一代 TypeScript Muya 引擎），社区持续活跃。墨记保持 MIT 许可，并通过 `upstream` 远端定期同步上游提交。

## 分支与发布规范

- `main` 主干只进合并，不做直接提交
- 开发分支 `feat/<主题>`、`fix/<主题>`，验收通过后合入
- 验收版本打 tag `momark/<x.y.z>`

详见 [docs/BRANCHING.md](docs/BRANCHING.md)。

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [路线图](docs/ROADMAP.md)

## 致谢

感谢 [MarkText](https://github.com/marktext/marktext) 团队与社区——墨记站在一个出色的开源编辑器之上。

## License

[MIT](LICENSE)。上游 MarkText © 2017-present Luo Ran；墨记定制部分 © 2026 MoMark。
