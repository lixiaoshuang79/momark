# MoMark 开发路线图（Electron 重构）

> 决策已定（见 docs/ARCHITECTURE.md D1-D7），本文是改造积压与任务拆分总表。
> 底座：fork marktext/marktext `develop` @ pinned commit（2026-09-04 1d3025b，见 momark-app/）。
> 技术栈（继承 MarkText 0.20）：pnpm monorepo + Vue 3.5 + TS + electron-vite 5 + Vite 7 + Pinia + vue-i18n + Electron 42/44 + @muyajs/core 0.2.0。

## 里程碑

### M0 基线可跑（当前）
- [ ] momark-app 克隆 + pnpm install + `pnpm dev` 启动成功（本机验证）
- [ ] git：保留 upstream remote；本仓 main = 干净 fork；改动全部走 feature 分支

### M1 品牌层（B1）
- [ ] electron-builder.yml：appId `com.momark.momark`（待用户定夺）/ productName `MoMark`
- [ ] 图标替换：assets/icons/AppIcon.icns（冻结资产）→ packages/desktop/build/icons/*
- [ ] 菜单文案（墨记/文件/编辑/视图/格式分组，对齐 PRD §5.1）、外链剥离（marktext.me 等）
- [ ] 关于窗口：icon-1 + 墨记 MoMark + MIT
- [ ] 欢迎页：首启空态（时钟插画 + 新建文档）、最近列表
- [ ] 剥离：electron-updater 更新检查、官网/CI、keytar（无 dataCenter 需求）

### M2 设计系统与编辑器渲染（B2）
- [ ] design/tokens.css → src/renderer/src/assets/styles/ 引入为唯一令牌源
- [ ] 新默认主题 claude-light/claude-dark（替换/并列 MarkText 内置主题，编辑器 CSS 变量映射）
- [ ] 编辑器排版对齐 PHASE2-SPEC §6：内容列 720px、正文 15px/1.58、H1 AnthropicSerif 30px/500、H2 17px/680、H3 16px/670、行内代码灰底、Claude 式表格（border-spacing 2px 灰格圆角）、引用竖线、墨蓝链接
- [ ] 字体双轨：assets/fonts/ 原版 woff2（.gitignore，个人构建注入）与 OFL 替代 Geist+Newsreader（开源默认），@font-face 栈切换开关
- [ ] 空文档「从这里开始写作…」提示

### M3 窗口 chrome（B3，基于 0.20 editorWithTabs 改造）
- [ ] 单文档态：物理移除标签栏行；标题区居中 7px 墨蓝状态点 + 完整路径
- [ ] 多文档标签栏：文件名自适应 max-420px 不截断、2px 墨蓝滑轨（.58s 回弹真实位移）、未保存 7px 状态点、hover X（剩 1 个不显示）、无 + 按钮、拖拽重排（半透明预览 + toast）
- [ ] 标签切换内容动效：逐行滑出/滑入（PHASE2-SPEC §2 数值）、可中断、reduced-motion 短路
- [ ] 面包屑行：单文档只显示文件名；多文档路径+文件名；分栏双面包屑左右对齐
- [ ] 状态栏：32px；左字数循环（千分位→段落→字符）；右 已保存/未保存的更改+墨蓝点；去掉行号/模式胶囊
- [ ] 编辑区焦点环（inset 1.5px 墨蓝）

### M4 内容侧栏与右栏面板（B4/B5/B6）
- [ ] 左栏双 tab（大纲/文件）：288px、中性胶囊选中态、大纲当前标题高亮不抢焦点、文件 tab 当前文件「当前」标记
- [ ] 右栏 browserPanel 自研：`<webview>` 每页实例 + 悬浮 URL dock/地址栏/胶囊 + 面板宽度动画（288↔240-60%）
- [ ] 网址模式：单页悬浮 + 生长地址栏、多页右缘 Dock、底部导航条、进度线/失败重试、外开默认浏览器
- [ ] persist partition + navigationHistory + permission/certificate 安全清单（research/reports/3.md）
- [ ] 文档模式：本地 MD 预览（MarkdownToHtml + DOMPurify 3.4.14，禁 iframe/object/embed/form）
- [ ] 拖拽分屏：投放区（38%/blocked 态）、分隔线（240px–60%、≥90% 自动关闭）、拖回标签栏

### M5 命令面板 / 偏好 / 导出 / 打印（B7/B8）
- [ ] 命令面板：5 分组（design/commands.json 27 条实时过滤、墨蓝加粗命中、↑↓/Enter、toast）
- [ ] 偏好六 tab：对齐 MarkText 偏好项 + 图片 tab（assets 目录/PicGo 预留）+ 主题三选 + 自动保存延迟 3/5/10s
- [ ] 导出：HTML/PDF 整体搬；docx 自研（pandoc 分支 + 缺 pandoc 指引）；进度/取消自研
- [ ] 打印：纸面恒白 + 页眉页脚三格实时预览

### M6 打包与验收
- [ ] electron-builder：dmg/zip、identity ad-hoc 路线、无 autoUpdater
- [ ] GUI 验收：docs/GUI-验收清单-参考.md + PHASE2-SPEC 五场景走查（浅色/深色）
- [ ] FEATURE-PARITY 一期清单逐项打勾

## 并行任务切分（dsh-task-shunt worker 积压）

| 批次 | 任务 | 依赖 | 冲突域 |
|---|---|---|---|
| W1 | B1 品牌层 | M0 | packages/desktop/{electron-builder.yml,package.json,build/icons,static,src/main/menu,src/renderer/src/components/about,pages/app.vue,i18n} |
| W2 | B2 设计系统 | M0 | src/renderer/src/assets/styles + themes + muya temaplate; 引擎 CSS 变量 |
| W3 | B3 chrome | M0（M3 独立成支） | components/editorWithTabs/*、titleBar、statusBar |
| W4 | B4+B5+B6 面板分屏 | M3 | 新目录 browserPanel/splitPane + editorWithTabs 接线 |
| W5 | B7+B8 面板类 | M1 | menu/commandPalette/prefComponents/export |

原则：每批一个 feature 分支，主会话合入；同文件冲突时后合并方 rebase。