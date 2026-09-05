# MoMark 架构文档（Electron 重构）

> 状态：初稿（决策表待 research/ 六份调研完成后回填）。
> 相关：`docs/PRD-MoMark-一期二期.md`（需求）、`docs/PHASE2-SPEC.md`（二期交互规格）、`design/tokens.css`（设计令牌唯一源）。

## 1. 技术决策总表

| # | 决策项 | 候选 | 结论 | 依据（调研文件） |
|---|---|---|---|---|
| D1 | 编辑器底座 | fork MarkText / 独立嵌入 @muyajs/core / milkdown / vditor | 待定 | research/reports/1.md、2.md |
| D2 | fork 锚点 | master / v0.20.0-rc.1 / 0.17.1 | 待定 | research/reports/1.md |
| D3 | 渲染层框架 | Vue 3 / React / 原生 TS | 待定 | research/reports/5.md |
| D4 | 构建工具 | electron-vite / forge / 手动 vite+electron-builder | 待定 | research/reports/5.md |
| D5 | 右栏浏览器方案 | `<webview>` / WebContentsView / BrowserView / 混合 | 待定 | research/reports/3.md |
| D6 | 默认字体 | 原版 Anthropic woff2 / OFL 替代 | 待定（双轨：私有走原版、开源走替代） | research/reports/4.md |
| D7 | 打包分发 | electron-builder dmg/zip、ad-hoc 签名 | 待定 | research/reports/5.md |

## 2. 目标形态

- 单仓库（pnpm workspace）：`src/main`（主进程）/ `src/preload` / `src/renderer`。
- macOS 优先（用户主力机 macOS 27 Beta），结构与功能不排除后续跨平台。
- 一期=MarkText 核心编辑能力（D1 底座自带），二期=原型 chrome（标签/分屏/左右侧栏/右栏面板/动效）。
- 品牌：MoMark + icon-1（冻结，md5 校验见 docs/LOGO-FREEZE 精神，本仓库 assets/icons 为复制件）。

## 3. 模块划分（拟）

```
src/main/            # 主进程（Electron main）
  index.ts           # app 生命周期、窗口创建
  windows/           # 主窗口 / 偏好设置 / 关于 / 欢迎 / 导出
  ipc/               # invoke/handle 通道注册（文件、导出、面板、系统）
  files/             # 打开/保存/另存为/文件夹扫描/自动保存（复用 D1 底座对应模块）
  export/            # HTML/PDF/docx（pandoc 桥）/打印
  panel/             # 右侧浏览器面板：WebContents 管理、会话 partition、导航历史
  menu.ts            # 系统菜单（新建/打开/导出/偏好…）
  theme.ts           # nativeTheme 跟随 + 窗口主题同步
src/preload/         # contextBridge 暴露的 MoMark API（类型共享 d.ts）
src/renderer/
  app/               # 状态机：五场景 single/multi/split-doc/split-url1/split-urlN
  components/
    titlebar/ tabbar/ crumb/ statusbar/ sidebar/ bpanel/ palette/ prefs/
  editor/            # D1 编辑器引擎挂载 + Claude 渲染主题（tokens.css 映射）
  theme/             # 主题变量切换（light/dark/auto）
  motion/            # 动效 token 与可中断动画原语（PHASE2-SPEC §2）
design/              # tokens.css、字体、原型参考
assets/              # fonts/ icons/
docs/                # 本文档、PRD、规格、验收清单
```

## 4. 关键工程原则

1. 不重复造轮子：编辑核心复用 D1 底座；MarkText 已有能力映射见 research/reports/6.md。
2. 状态机唯一：五场景互斥（PHASE2-SPEC §10），所有 UI 由状态机驱动，动画可中断。
3. pt = px × 0.75：原型尺寸进代码统一换算，禁止局部混用。
4. 设计令牌唯一源：`design/tokens.css`；组件禁止硬编码颜色/字号。
5. 安全默认：contextIsolation + sandbox；右侧网页面板严格权限默认拒绝；本地 MD 预览 DOMPurify 清洗。
6. 字体双轨（待 D6 定案）：assets/fonts/ 下原版 woff2 不进开源提交；OFL 替代作为默认 @font-face。
7. 品牌冻结：icon-1 与 AppIcon.icns 只复制不修改（md5 见 assets/icons 复制时校验记录）。

## 5. 验收口径

- 一期：`docs/FEATURE-PARITY-参考.md`（MarkText 行为对照）+ PRD §2。
- 二期：`docs/PHASE2-SPEC.md` 五场景 + 动效真实位移/生长/回弹/分层滑入（PRD §6 硬约束）。
