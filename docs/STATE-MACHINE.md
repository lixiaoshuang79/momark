# MoMark 渲染层状态机规格

> 唯一权威源：`docs/PHASE2-SPEC.md` §10。本文件给出类型级定义，供任意渲染框架（D3 决策后）实现。
> 原则：**所有 chrome UI 由单一 workspace 状态驱动**，五场景互斥；动画可中断（motion token）；保存状态只由文档模型产生。

## 1. 核心类型

```ts
// 文档标签模型（左侧标签集合）
interface DocTab {
  id: string;              // uuid，文件生命周期内稳定
  name: string;            // 文件名（标签只显示它，不截断）
  path: string | null;     // null = 未命名新文档
  dirty: boolean;          // 未保存（7px 墨蓝点）
  doc: DocModel;           // 编辑器文档模型（与引擎绑定）
}

// 右栏网页实例（网址模式）
interface WebPage {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;        // 墨蓝进度线
  error: string | null;    // 失败原因 + 重试
}

// 右栏状态（网址与文档二选一）
type BpMode = 'url' | 'doc';
interface BpState {
  open: boolean;                    // 面板开合（默认 false，宽 0）
  mode: BpMode;
  urlPages: WebPage[];              // 0/1 = 单网页态（悬浮+），≥2 = 右缘 Dock
  activePageId: string | null;
  docPath: string | null;           // 文档模式预览文件
  dockAddrOpen: boolean;            // 地址栏展开态（悬浮胶囊生长/收起）
  dragState: 'none' | 'over' | 'blocked';   // 标签拖入面板的投放态
}

interface SplitState {
  active: boolean;
  kind: 'doc' | 'url';              // split-doc / split-url(1|N)
  tabId: string | null;             // kind=doc 时：被拖出标签集合的文档
  width: number;                    // 右栏宽（240 ~ 60% 窗宽）
}

interface WorkspaceState {
  scene: 'single' | 'multi' | 'split-doc' | 'split-url1' | 'split-urlN';
  tabs: DocTab[];
  activeTabId: string | null;
  sidebar: { open: boolean; tab: 'outline' | 'files' };
  bpanel: BpState;
  split: SplitState;
  dirty: boolean;                   // 任一标签 dirty（标题栏状态点）
  zoom: number;                     // 50%~200%
}
```

`scene` 是派生量，由 `tabs.length / split.active / bpanel.urlPages.length` 计算，禁止手工设置：
- tabs.length ≤ 1 且 !split.active → `single`（标签栏整行不渲染）
- tabs.length ≥ 2 且 !split.active → `multi`
- split.active && kind=doc → `split-doc`
- split.active && kind=url && urlPages.length===1 → `split-url1`
- split.active && kind=url && urlPages.length>=2 → `split-urlN`

## 2. 动作（reducer 级，全部可撤销性不要求）

| 动作 | 前置/后置不变量 |
|---|---|
| newDoc() | 空文档入 tabs 并激活；不弹保存框（PRD 2.4） |
| openFiles(paths[]) | 逐个建立或复用标签（按 path 去重复用）；同名不同路径并存 |
| openFolder(path) | 递归扫描 .md 批量 openFiles |
| activateTab(id) | 内容切换动效（PHASE2-SPEC §2 逐行滑入/出，可中断） |
| closeTab(id) | dirty 时先弹 取消/不保存/保存；关闭后活动标签落到相邻；tabs 空 → 空文档态 |
| saveTab(id) / saveAs(id, path) / saveAll() | 保存成功清 dirty；另存为更新 name/path/面包屑 |
| markDirty(id) | tab dirty 点 + 标题栏点 + 状态栏「未保存的更改」；5s 自动保存计时器 |
| reorderTabs(from,to) | 拖拽即时预览 + 释放 toast「标签顺序已更新」 |
| dragToSplit(id) | 该文档从 tabs 移除→split.tabId；右栏开为文档窗格 min(480,60%)；同文档互斥（已在右屏则 blocked） |
| returnSplitToTabs() | split.tabId 回到 tabs 为活动标签；右栏收起 |
| setSplitWidth(w) | 240~60%；≥90% 窗宽 → 自动 closeSplit |
| toggleBp() / setBpMode('url'\|'doc') | 面板开关滚动变圆形 X；选择器生长回弹 + tab 错峰滑入 |
| addWebPage(url) / activatePage(id) / closePage(id) | 1 页=悬浮+态；≥2 页=右缘 Dock；每页独立 login/滚动/历史 |
| pickDocPreview(path) | 文档模式预览（DOMPurify 清洗） |
| toggleSidebar() / setSidebarTab() | 左栏 288px ↔ 0 |

## 3. 保存状态（自动保存）

- 已有 path：编辑后 5s（可配 3/5/10s）自动 saveTab；未命名：不弹框，仅标 dirty。
- 退出/关窗：任一 dirty → 阻止退出，逐个走 取消/不保存/保存。
- 状态栏右：`已保存` / `未保存的更改`(+墨蓝点)；左：字数→段落→字符循环（千分位）。

## 4. 动效原则

- 全部动画参数来自 `design/tokens.css`（缓动/时长），组件不硬编码。
- 内容切换逐行动画：行粒度由渲染引擎能力决定（DOM 块级节点=行）；可中断：每次切换递增 `motionToken`，异步回调携带 token 校验。
- `prefers-reduced-motion` 全局短路（tokens.css 已含）。
- 面板开合/滑轨/选择器生长/胶囊生长/分隔线拖动：数值见 PHASE2-SPEC 对应节。

## 5. 状态持久化（会话恢复，二期可选）

- 打开面板/左栏开合/缩放/主题 → electron-store 类键值持久化。
- 网页登录态由 session partition 持久；滚动/历史随网页实例保留（进程存活期），不做磁盘恢复。
- 未命名文档内容不落盘；已有路径文档以自动保存为准（首启不做上次会话文档恢复——PRD 未要求）。
