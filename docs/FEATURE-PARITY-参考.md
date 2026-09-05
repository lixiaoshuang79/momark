# 墨记 MoMark 功能全景与复刻清单（品控基准）

> 原则：P0 = MarkText 功能全量复刻，一条不落；P1 = 其他开源/闭源编辑器高价值功能参考复刻。
> 每个功能必须对照 MarkText 实际行为验收（fork 源码 + 本机 v0.20.0-rc.1 app 实测），不允许「差不多」。
> 许可证红线：MIT（MarkText/MarkEdit/Pine）可参考实现；GPL-3（Zettlr）只参考功能不抄代码；闭源（Typora/Obsidian）只做行为参考。

## 0. 参考仓库

| 项目 | 语言/栈 | 许可 | 用途 |
|---|---|---|---|
| marktext/marktext | TS/Electron（muya 引擎） | MIT | P0 行为基准，算法可参考（wordCount、表格序列化等） |
| MarkEdit-app/MarkEdit | Swift + CodeMirror 6 | MIT | 原生 UI 桥接/性能/扩展机制参考（首选代码借鉴对象） |
| lukakerr/Pine | Swift/AppKit | 见仓库 | 原生语法高亮、编辑器骨架参考 |
| Zettlr/Zettlr | JS/Electron | GPL-3 | 仅功能清单参考（引用管理、写作目标等），禁抄代码 |
| Typora | 闭源 | - | 仅行为参考（表格可视化、大纲定位等） |
| Obsidian | 闭源 | - | 仅行为参考（双链等，列为 P2） |

---

## 1. P0：MarkText 全量功能复刻清单

### 1.1 核心编辑体验
- [ ] 单窗所见即所得：输入 `#` 空格后标题行即时渲染（`#` 符号隐藏或淡化）
- [ ] 实时渲染：所有语法输入即渲染，无需切换预览
- [ ] 行内编辑无缝：光标在渲染结果与源码之间精确映射

### 1.2 语法支持（与 MarkText README/官方文档一致）
- [ ] 标题 H1-H6（# 语法）
- [ ] 段落与软/硬换行
- [ ] 有序/无序列表（含嵌套缩进）
- [ ] 任务列表 `- [ ]`（点击勾选框切换状态）
- [ ] 引用块（嵌套引用）
- [ ] 行内代码 + 围栏代码块（语法高亮，主题配色）
- [ ] 链接、自动链接（http/https/邮箱）、命名锚点
- [ ] 图片（粘贴/拖入，见 1.6）
- [ ] 删除线、粗体、斜体、粗斜体
- [ ] 分隔线
- [ ] 脚注（Pandoc 语法，`[^1]`）
- [ ] YAML front matter（`---` 块，渲染区展示）
- [ ] 数学公式：行内 `$...$` + 块级 `$$...$$`（KaTeX）
- [ ] 图表：mermaid（flowchart/sequence/class 等）+ 旧 flowchart/sequence 语法
- [ ] emoji：`:smile:` 快捷输入
- [ ] 原始 HTML 块渲染（与 MarkText 一致：DOMPurify 清洗，禁 iframe/script——⚠️ MoMark 增强版将开放 iframe 沙箱嵌入，见 P1）
- [ ] `<kbd>` 键盘键样式
- [ ] 表格（GFM：表头、对齐、行列增删——见 1.7）
- [ ] 段落快捷菜单：`@` 浮层唤出元素插入（标题/表格/公式/图表等）
- [ ] 样式快捷键（Ctrl+B/I 等，与 MarkText KEYBINDINGS 一致）

### 1.3 编辑模式
- [ ] 源码模式（Source Code Mode）：显示纯源码，与所见即所得实时同步切换
- [ ] 打字机模式（Typewriter Mode）：光标行固定在视口中部
- [ ] 专注模式（Focus Mode）：仅高亮当前段落，其余淡化

### 1.4 侧栏与界面
- [ ] 侧栏三面板：①文件系统树（打开文件夹，显示/隐藏已打开文件小节）②文件内查找（大小写/全词匹配）③当前文档大纲 TOC（点击跳转、折叠）
- [ ] 多标签页：每文件一个 tab，拖拽重排，Ctrl+Tab 循环，可隐藏 tab 用侧栏切换
- [ ] 命令面板：Cmd/Ctrl+Shift+P
- [ ] 查找与替换（编辑器内）
- [ ] 标题栏：文件名 + 未保存修改圆点
- [ ] 窗口缩放（50%-200%）

### 1.5 文本工具
- [ ] 字数统计：word（中文按字计）/paragraph/character 三档，点击循环切换，tooltip 明细
- [ ] 拼写检查：系统词典 + Hunspell，160+ 语言自动检测，右键纠错/加入词典/忽略
- [ ] 自动保存（可配置开关与延迟）

### 1.6 图片工作流（用户核心场景）
- [ ] 剪贴板粘贴图片自动落盘
- [ ] 拖入图片文件
- [ ] 图片落盘位置三选项：相对目录（assets/`${filename}` 变量支持）/指定目录/保持原位置
- [ ] PicGo 内置上传器：上传后自动替换为图床 URL（腾讯云 COS 用户工作流）
- [ ] 图片缩放查看（0.1×–10× 查看器）
- [ ] 图片拖拽调整显示尺寸（MarkText 有 imageResizeBar）

### 1.7 表格
- [ ] 插入表格对话框（行列数）
- [ ] 列对齐（左/中/右）
- [ ] 增删行列（工具栏 + 行列菜单）
- [ ] 单元格内编辑（方向键/退格/回车行为与 MarkText 一致）
- [ ] ⭐ 列宽拖拽调整（P0 增强项——MarkText 上游没有，MoMark 原创）
- [ ] 行高调整（视图态）

### 1.8 导出与打印
- [ ] 导出 HTML
- [ ] 导出 PDF（页边距/纸张方向/页眉页脚（单行三格）/字体行高/自动编号标题/是否含 front matter/导出主题可选）
- [ ] 打印
- [ ] 导出主题机制（EXPORT_THEMES）

### 1.9 主题与外观
- [ ] 内置主题：Cadmium Light、Material Dark、Graphite Light、Ulysses Light、One Dark、Dark
- [ ] 自定义 CSS 导入（编辑器与导出分别生效）
- [ ] 深浅色跟随系统

### 1.10 偏好设置（对齐 MarkText Preferences 面板全部条目）
- [ ] General：自动保存/延迟、打开文件夹行为、启动动作、语言（中文 UI！）、缩放、隐藏滚动条
- [ ] Editor：字体族/字号、行距、tab 宽度、代码块字号等
- [ ] Markdown：偏好语序设置（列表/引用连续性等）
- [ ] Theme：主题选择 + CSS 导入
- [ ] Spelling：开关/词典管理/自动语言检测
- [ ] Image：插入动作/落盘位置/上传器配置

### 1.11 其他
- [ ] 中文本地化完整（zh-CN locale 全部文案）
- [ ] 键盘快捷键体系（对齐 KEYBINDINGS_OSX.md）
- [ ] 文件关联 .md、命令行 `momark <file>` 打开

---

## 2. P1：参考复刻的候选功能（按价值排序）

| # | 功能 | 来源 | 参考方式 | 优先级 |
|---|---|---|---|---|
| 1 | iframe/HTML 沙箱嵌入渲染（文档内做交互演示） | MarkText issue #925 拒绝项，MoMark 原创 | 自研：DOMPurify 放行 + 强制 sandbox 属性 | ★★★ 用户点名 |
| 2 | 中文字符统计（纯中文字数维度+选中统计） | 用户需求 | 自研（muya wordCount 算法参考） | ★★★ 用户点名 |
| 3 | 换应用图标功能（内置多套图标+自定义） | 用户需求 | 自研（NSApplication.applicationIconImage） | ★★★ 用户点名 |
| 4 | 表格可视化编辑增强：拖列宽（P0 已含）、对齐按钮、表头菜单 | Typora | 行为参考 | ★★★ |
| 5 | 大纲侧栏实时定位（滚动时高亮当前标题） | Typora | 行为参考 | ★★☆ |
| 6 | 图片拖拽调整尺寸（P0 已含） | Typora | 行为参考 | ★★☆ |
| 7 | docx/EPUB/LaTeX 导出（Pandoc 集成） | Typora/Zettlr | 功能参考 | ★★☆ |
| 8 | 预览栏分屏（源码+预览双栏） | MarkEdit-preview/Notable | 源码参考（MarkEdit） | ★★☆ |
| 9 | YAML frontmatter 属性面板（GUI 编辑字段） | Zettlr | 功能参考 | ★★☆ |
| 10 | 写作目标（字数目标进度条） | Zettlr | 功能参考 | ★☆☆ |
| 11 | 全局搜索（跨文件夹全文检索） | Zettlr/Obsidian | 功能参考 | ★☆☆ |
| 12 | wiki 链接 `[[...]]` 与反向链接 | Obsidian | 行为参考 | ★☆☆ |
| 13 | 关系图谱 | Obsidian | 行为参考 | ★☆☆ |
| 14 | Shortcuts/AppleScript 集成 | MarkEdit | 源码参考（MarkEdit） | ★☆☆ |
| 15 | Writing Tools / 内联预测（macOS 26+） | MarkEdit | 源码参考（MarkEdit） | ★☆☆ |
| 16 | 大文件性能（10MB 流畅目标） | MarkEdit | 源码参考（MarkEdit/TextKit 2） | 贯穿全程 |
| 17 | 扩展机制（CSS/JS/CodeMirror 扩展） | MarkEdit | 源码参考 | ★☆☆ 远期 |
| 18 | **侧边栏嵌入式浏览器面板**：开文件（双文件对照）/开网址（对照 Figma 讲文档） | 用户原创需求 | 第一阶段 WKWebView（文件/网址双模式、左右对照），预留 CEF 升级接口；调研文档 docs/BROWSER-PANEL-RESEARCH.md | ★★★ 用户点名 |
| 19 | 侧边栏浏览器面板引擎选择（WKWebView vs CEF/Chromium、登录态共享方案） | 用户需求派生 | 侦查调研 docs/BROWSER-PANEL-RESEARCH.md；决策锚点=Figma 手感与登录态 | ★★★ |

---

## 3. 里程碑与清单挂钩

- **M1** ✅ 骨架：1.1 部分 + 1.2 基础语法 + 1.4 标签/标题栏 → 可打开保存编辑
- **M2** ✅ 所见即所得（核内核 + M8 装饰：任务列表复选框/脚注/kbd/emoji 短码/front matter；M9 三模式控制器 + 菜单/⌘⇧P 命令面板已接线）：1.1 全量 + 1.2 语法隐藏渲染 + 1.3 三模式 + 1.9 主题
- **M3** ✅ 块级：1.6 图片全工作流 + 1.7 表格（含列宽拖拽）+ 1.2 公式/图表
- **M4** ✅ P1（2026-09-03 合并）：P1-1 iframe 沙箱嵌入 + P1-8 预览栏 + P1-18 侧栏浏览器面板（WKWebView 先行）
- **M5** ✅ P1（换图标 P1-3 已按用户要求取消）：1.5 文本工具（中文字数 P1-2）+ 1.8 导出打印 + P1-7 docx 导出
- **M6** ⏳ 1.10/1.11 偏好与中文本地化收尾 + 品牌打包（图标/名字/安装包）+ P1 余项排期

> 渲染样式：Notion 2025 亮色设计实测值已复刻（docs/NOTION-STYLE-SPEC.md，2026-09-03 用户 Notion「测试」页实测），
> NotionTheme（StylingPipeline.swift）为唯一权威样式源。
