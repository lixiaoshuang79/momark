# MoMark 二期交互与动效工程规格

> 唯一权威源：`design/prototype-v0.14.html`（原型 v0.14）+ `docs/PRD-MoMark-一期二期.md` 第 3、6 节。
> 本文把原型交互提炼为实现规格。所有尺寸：pt = px × 0.75（macOS 界面），本文标注原型 px 值。
> 硬约束：单文档不出现标签栏；多文档不出现新建 +；路径与文件名不重复；右栏收起不占宽；相同文档不得同时出现在左右两侧；画布/侧栏/卡片/文字/墨蓝色不得用未定案的紫/陶土/羊皮纸/系统灰替代。

## 1. 窗口总结构（自上而下）

| 行 | 高度/宽度 | 说明 |
|---|---|---|
| 标题栏 | 40px | macOS 原生红绿灯（产品不画假灯）；单文档态标题区居中显示 7px 墨蓝状态点 + 完整路径 `~/Documents/momark › 产品需求文档.md`；多文档/分栏态不显示标题 |
| 标签栏 | 40px | 单文档态**物理移除整行**；含：左栏开关 ⌘\、标签 strip、右栏开关、右栏展开后的「网址/文档」选择器 |
| 面包屑行 | 28px | 多文档：仅路径+文件名（左侧）+右栏开关入口；单文档：只显示文件名（路径已在标题栏，不得重复）；分栏：左右两个面包屑（左侧左对齐、右侧右对齐 `bp-docname`，可拖回标签栏） |
| 主体三栏 | flex:1 | 左侧栏 / 编辑区 / 分隔线 / 右侧栏，见下 |
| 状态栏 | 32px | 上方发丝线；左=字数统计按钮（循环），右=保存状态 |

## 2. 标签栏

- 标签只显示文件名；宽度随内容自适应，`max-width: 420px`，**不得省略截断**；`flex: 0 0 auto`。
- 活动标签：深色文字 `--ink` + 底部独立滑轨；非活动：`--muted`。
- 滑轨（`.tab-indicator`）实现要点：
  - 独立 span 元素，不随标签重建；`width = max(18px, active.offsetWidth - 20px)`；`transform: translateX(active.offsetLeft + 10px)`。
  - 动画：transform `.58s cubic-bezier(.18,1.32,.36,1)`、width `.48s cubic-bezier(.22,1,.36,1)`、opacity `.16s`；切换无动画时先置 transition:none 再双 rAF 恢复（防止闪现）。
  - 活动标签自身带 `tabSpring`：`.52s cubic-bezier(.2,1.35,.35,1)`（translateY 2px→-1.5px→0 + scale .96→1.018→1）。
- 未保存圆点：7px 墨蓝，文件名之后；`.dirty` 时显示。
- 关闭按钮：18px，hover 标签才出现（opacity 0→1）；**仅剩一个标签时不渲染**。
- 无新建 `+` 按钮（新建/打开统一走系统菜单）。
- 拖拽重排：HTML5 drag & drop；`.tab.dragging { opacity: .45 }`；dragover 时按 `clientX < rect.left + width/2` 即时插入移动；drop 固化顺序并 toast「标签顺序已更新」。
- 标签切换内容动效（关键，必须真实位移+分层滑入，不得只做透明度闪烁）：
  - 旧内容逐行滑出：每行 `--line-out-x = -direction × (120 + min(150, len×1.35))px`、时长 `220 + min(120, len×1.3)ms`、延迟 `index×8 + (len%4)×5 ms`，末尾 `filter: blur(1.5px)`。
  - 新内容逐行滑入：`--line-x = direction × (120 + min(170, len×1.5))px`、时长 `560 + min(360, len×2.8)ms`、延迟 `index×22 + (len%6)×8 ms`，从 `blur(2px)` 到 0，72% 处过冲 `×-.025` 回弹。
  - 可中断：全局 motion token 递增，超时回调校验 token 不符即放弃；`prefers-reduced-motion` 时直接切换。

## 3. 拖拽分屏

1. 任意标签 dragstart → 窗口右侧出现投放区 `.split-drop-zone`（右 38% 宽，左缘 accent 半透明竖线，`linear-gradient(90deg, rgba(61,90,128,.04), rgba(61,90,128,.16))` + `box-shadow: -26px 0 48px rgba(35,52,74,.14)`），文案「拖动到此，分屏展开」。无需预先打开右侧栏。
2. 若该文档已在右屏 → blocked 态（grayscale .35 + opacity .65 + 文案「该文件已在右侧分屏」，dropEffect none）。
3. drop → 该文档从左侧标签集合**移除**（若为活动标签，落到相邻标签），右侧面板展开为文档窗格：宽 `min(480px, 60%)`，`win-body` 挂 `.split` + `.panel-open`；面板进入文档模式；左栏 `.col` padding 改为 `48px 32px 100px`、max-width 放开——左右内容顶部对齐。
4. 分隔线 `.splitter`：8px 宽命中区、中间 1px `--line`（hover 变 accent）；pointer capture 拖动：右栏 `min 240px`、`max 60% 窗宽`、拖到 `≥90%` 窗宽自动关闭分屏；拖动结束 toast 报告宽度。
5. 分屏右侧文档标题（面包屑右侧 `bp-docname`，含状态点+路径）可拖回标签栏：dragstart 时 tabstrip 挂 `.return-target`（accentSoft 底 + `inset 0 0 0 1.5px accent` 环）；drop → 文档回到标签集合为活动标签、右栏收起、toast「已将『xx』拖回标签栏」。
6. 相同文档不得同时出现在左侧标签集合与右侧窗格（互斥由状态机保证）。

## 4. 左侧栏

- 宽 288px，底 `--sidebar`，右侧 `.5px` hairline；收起 = `width: 0`（无占位）。
- 顶部 大纲/文件 双 tab：中性胶囊（容器 `--hover` 圆角 8px，选中=卡片底 + hairline 描边 + 深色文字），**不用墨蓝填充**。
- 大纲 tab：H1-H6 标题树，缩进分级（lv2 `padding-left: 30px`），当前标题 `.sel`（`--selected` 底）；光标移动同步高亮，**不抢编辑区焦点**。
- 文件 tab：当前文档所在目录的 `.md` 文件列表（文件图标+文件名），当前文件行尾「当前」墨蓝标记；点击打开/切换标签。
- 左栏开关（标签栏最左 `⌘\`）：展开时 `.on`（accentSoft 底 + accent 图标）。

## 5. 右侧浏览器面板

- 默认收起（宽 0）；展开宽 288px（分屏文档态 `min(480px, 60%)`），左缘 `.5px` hairline；开合动画 `.42s cubic-bezier(.22,1,.36,1)`（实现：宽度 0→288 的显式动画）。
- 右栏开关：点击后面板展开 + 按钮自身「向左滚动」变圆形 X——`.rolled`：卡片底、accent 图标、`border-radius: 50%`、`transform: rotate(-180deg) translateX(3px)`、hairline 描边；再点收起恢复常态。单文档态此开关在面包屑行右侧（`crumb-pbtn`，仅单文档显示）。
- 「网址/文档」选择器（`.bp-modes`）紧跟开关之后，无独立头部行：容器 `width: 18px` + `scaleX(.18) scaleY(.82)`（transform-origin 左）→ 展开 `width: 154px` + scale(1)，`.5s cubic-bezier(.18,1.42,.36,1)`；两个 tab 按钮从右错峰滑入（opacity 0→1 + translateX(18px)→0，延迟 .08s / .14s）。选中=卡片底+描边+深色字。
- **网址模式**：
  - 单网页态：内容区右上角悬浮「+」胶囊（`.bp-addrwrap`，right:6px top:8px，34×34 圆角 9px，卡片底+描边）；点击后**横向生长**为网址栏 `width: min(320px, 100% - 12px)`（`.46s cubic-bezier(.18,1.28,.36,1)`），内含 Google 彩 G 图标 + 输入框 + 「前往」胶囊按钮；鼠标移出自动收起。输入判断：URL（含 `https?://` 或域名样式且无空格）→ 自动补 `https://` 打开；否则 Google 搜索。回车或「前往」触发，加载中顶部 2px 墨蓝进度线（滑动动画）。
  - 多网页态：右缘垂直 Dock（距右 8px，居中）；每项 34×34 圆角 9px 底色 `--ud-bg`；hover `translateX(-3px) scale(1.08)` + 左侧 HUD 气泡显示完整 URL；当前页 = 白底 + 1.5px 墨蓝边框；hover 时相邻项 `scale(.96)`（macOS dock 效应）；末尾虚线「+」新增网页（展开网址栏）。
  - 底部 40px 导航条：后退/前进/刷新 + 地址栏（不透明白底输入框，**不自动聚焦**）；鼠标移入地址栏时右侧滑出「在默认浏览器中打开」箭头（`shell.openExternal`）。
  - 加载失败：显示原因 + 重试按钮；网络加载中显示墨蓝进度线 + 加载状态。
  - **状态持续保留**：每个网页的登录态（persist partition）、滚动位置、前进后退历史。
- **文档模式**：底部只显示「打开文件…」入口（36px，顶部 hairline），无网址导航条；选择本地 Markdown 后右侧渲染预览——**必须清洗脚本、内联事件属性、不安全 iframe 来源**（DOMPurify）。
- 拖放目标：整个面板可接收标签 drop（`.drop-ok` = 2px dashed accent outline）。

## 6. 编辑区视觉

- 内容列宽 720px 居中；正文画布 `--c-bg`（近白暖灰）；列 padding `44px 32px 140px`。
- 正文：Anthropic 字体 15px / 1.58；H1 = AnthropicSerif 30px 500 字重、letter-spacing -.01em、上下 20px；H2 = sans 17px 680；H3 = sans 16px 670。
- 行内代码：mono 13px、底 `#f0efec`、圆角 4px、padding 2px 4px。
- 链接：墨蓝 + 下划线（underline-color rgba(61,90,128,.40)、thickness 1px、offset 10%）。
- 引用：左 3px `#c9c7c0` 竖线、次级文字。
- 代码块：mono 13.6px/20.4px、底 `#f9f9f7`、`.5px` 描边、圆角 10px、右上角 hover 出现语言标签（自动识别/Swift/JavaScript/Python/Markdown/CSS 下拉，菜单 fixed 定位防带滚编辑器，wheel 不冒泡）。
- 表格（Claude 式）：`border-collapse: separate; border-spacing: 2px`，每格灰底 `#efefed` 圆角 4px，首行表头 650 字重，四角外角 7px；无外框无竖线；支持折叠（折叠后显示「表格 · N 行 × M 列 · 点击展开」摘要条）。
- 任务列表：16px 方框，勾选=墨蓝底白勾。
- 空文档：无卡片无插画，仅第一行墨蓝闪烁光标 + 「从这里开始写作…」提示。
- 编辑区聚焦：inset 1.5px 墨蓝焦点环；失焦移除。专注模式：非当前块 opacity .3。

## 7. 状态栏

- 高 32px、顶部 hairline；左=字数按钮（点击循环：字数（千分位，如 1,245）→ 段落 → 字符；hover 底）；右=「已保存」/「未保存的更改」（未保存同时显示 7px 墨蓝点）。
- 不得显示光标行列、模式胶囊、重复路径。

## 8. 命令面板（⌘⇧P）

- 居中浮层 560×max486px（=540×480pt）；卡片底+12px 圆角+弹层投影；顶部输入行 + 分组列表（墨记/文件/编辑/视图/格式）。
- 实时过滤；命中词墨蓝加粗高亮；↑↓ 移动、Enter 执行；执行后关闭并 toast；无结果显示原因+提示。
- 命令清单=实际开发功能（见原型 COMMANDS 数组，27 条）。

## 9. 偏好设置 / 导出 / 打印 / 关于 / 欢迎

- 偏好设置：700×540pt 窗口；通用/编辑器/Markdown/主题/拼写/图片 6 tab（底部 2px 墨蓝下划线选中态）；修改即时生效无保存按钮；主题三选（跟随系统/浅色/深色）。
- 导出对话框：PDF/HTML/docx 三卡片选择 + 各选项区；PDF 页边距(默认25.4mm)/方向/页眉页脚三格/字体行高/自动编号标题/front matter/跟随主题；HTML 主题+内联图片 base64；docx 依赖 pandoc（缺省显示 inline 警告）。进度态（百分比+取消）→ 成功（完成/在 Finder 中显示）→ 失败（缺 pandoc 时给 `brew install pandoc` 指引）。
- 打印：对话框 + 页眉页脚三格实时预览（**预览纸面固定纯白**，深浅主题一致）。
- 关于：冻结 icon-1（92px 圆角 21px）+「墨记 MoMark」+ 版本 + 链接 + MIT 许可。
- 欢迎：660×440pt；左=新建文档/打开文件夹/打开文件三按钮（44px 高、图标+文字单行、无快捷键提示）；右=最近打开列表；首次启动=空态（时钟插画+文案+新建文档按钮）。

## 10. 状态机总表（五场景验收）

| 场景 | 标签栏 | 标题区 | 面包屑 | 右栏 |
|---|---|---|---|---|
| single 单文档 | 不渲染整行 | 状态点+完整路径居中 | 仅文件名 + 右栏开关按钮 | 可开（网址/文档） |
| multi 多文档 | 渲染 | 空 | 路径+文件名 + 开关 | 可开 |
| split-doc 文档对文档 | 渲染（右屏文档已移出） | 空 | 左路径 + 右文档名（可拖回） | 文档窗格 + 分隔线 |
| split-url1 文档对网址 | 渲染 | 空 | 仅左 | 网址窗格（单网页+悬浮+） |
| split-urlN 文档对多网址 | 渲染 | 空 | 仅左 | 网址窗格（右缘 Dock） |

关闭分屏路径：拖右文档名回标签栏 / 分隔线拖到 ≥90% / 拖别的标签替换 / 右栏开关收起。
