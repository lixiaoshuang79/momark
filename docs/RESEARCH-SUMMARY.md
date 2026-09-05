# 调研汇总与决策（2026-09-05，6 任务 shunt 并行完成）

> 原始报告：research/reports/1-6.md；结构化结果 research/results/1-6.json。本文是定案纪要。

## 七项决策（已写入 ARCHITECTURE.md 决策表）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 编辑器底座 | **fork marktext/marktext develop（0.20 重写线）**，非独立嵌入引擎 |
| D2 | fork 锚点 | develop tip `1d3025b2b6306613a6fa0f822ba9bcaf8890b094`（2026-09-04）；后续可跟进 rc.2 |
| D3 | 渲染层框架 | **Vue 3.5**（MarkText 0.20 原生技术栈，继承零成本） |
| D4 | 构建工具 | **electron-vite 5 + electron-builder 26 + pnpm workspace**（同上，继承） |
| D5 | 右栏浏览器 | **`<webview>` 主方案**（每页一实例 + persist partition + 悬浮 UI 可交互），封装 BrowserPane 抽象层备切换 |
| D6 | 默认字体 | 双轨：个人构建=原版 Anthropic woff2（gitignore 不入库）；开源分发=Geist(正文)+Newsreader(H1) OFL |
| D7 | 打包 | electron-builder 26.15.x；ad-hoc/不签（自用）+ 无 autoUpdater；开源走 GitHub Releases |

## 关键事实

### MarkText 0.20 develop（research/1、2、6）
- MIT、61k★、2026-09 每日 4-6 commits 活跃；pnpm monorepo：packages/desktop + packages/muya（=@muyajs/core 0.2.0）。
- **原生已有多标签页**（editorWithTabs/editor.vue + tabs.vue + Pinia store）——二期标签栏是「改造」而非「从零」。
- 栈：Vue 3.5 + TS + electron-vite 5 + Vite 7 + Element Plus + Pinia + vue-router 4 + vue-i18n 11 + Electron ~42。
- 一期 PRD 2.1-2.5 约九成直接复用：文件生命周期（mt:: 通道 + showUnsavedFilesMessage 三键确认）、自动保存（autoSaveTimers 5s，未命名静默跳过）、HTML/PDF 导出+打印（MarkdownToHtml + printToPDF）、查找替换（search/index.vue + muya/src/search）、系统拼写（Electron 内置，无 hunspell）、图片落盘 assets/（muya pasteImage + imagePathPicker）、主题（30+ theme css 变量体系）、TOC/文件树侧栏（toc.vue/tree.vue）、字数（muya wordCount）。
- 需自研：**docx 导出**（0.20 缺，复用 utils/pandoc.ts 加分支）、导出进度/取消、分屏、右栏面板、命令面板 5 分组改造、Element Plus chrome 全面替换为自研 Claude 风格组件。

### 引擎（research/2）
- @muyajs/core：new Muya(el,{markdown}) 独立嵌入可行、MIT、往返无损是设计目标、表格/公式/mermaid/脚注/front matter/emoji 原生齐、图片钩子专为 Electron 设计、CSS 变量覆盖即主题。
- 备选均不如：milkdown/tiptap 往返无损无保证；vditor 体验糙；bytemd/remirror/blocky 停更。

### 浏览器面板（research/3）
- Electron 44.2.0（Chromium 152 / Node 24）；webview 是唯一满足「悬浮 UI 浮在网页上可交互」的方案（WebContentsView 原生视图永远压住 DOM，issue #15899；混合方案受 click-through #49039 限制）。
- webview 要点：partition="persist:panel" 全面板共享登录态；navigationHistory API（≥32）做前进后退；did-fail-load 仅 isMainFrame 且忽略 -3；getWebContents 已移除用 getWebContentsId()；setWindowOpenHandler + will-attach-webview 强安全注入；官方不推荐属长期风险，用 BrowserPane 抽象层隔离。
- MD 预览：MarkdownToHtml → DOMPurify 3.4.14（FORBID_TAGS 全禁 iframe/object/embed/form）；本地图片走自建协议 handler 防越权。
- 参考实现：Min（WebContentsView 放弃悬浮 UI）、Wexond（浮层=独立 BrowserView，割裂）、electron-tabs（webview+DOM tab 先例，已停维护）。

### 字体（research/4）
- 实证（name 表）：两个 woff2 = **Anthropic Sans/Serif Variable**（© 2025-2026 Anthropic PBC，BSPK LLC/Chester Jenkins 定制，血统关联 Vercel Geist），**非** Styrene/Tiempos。
- **不可随开源分发**（无许可元数据；CDN 字体仅授权站内展示）。
- 替代：Geist（sans，OFL）+ Newsreader（serif，OFL）；中文配 PingFang SC / Songti SC。

### 工程（research/5）
- Electron 44 stable（2026-08-25），支持 44/43/42；macOS 27 Beta 无已知阻断。
- electron-vite 5（Vue3 模板真 HMR）；electron-builder 26.15.3；ad-hoc identity:"-" + hardenedRuntime:false；无付费开发者账号不走公证（非硬性）；electron-updater 未签名不可用 → 不上。
- 参考工程：Zettlr v4（Electron 43 + builder 26，mac 打包配置实录）；思源（扁平够用）；AFFiNE（复杂勿学）。

## 立即行动

1. M0：momark-app（fork）pnpm install + dev 跑通 → 本机验证基线。
2. 按 ROADMAP.md W1-W5 切 feature 分支，shunt 并行开发。
