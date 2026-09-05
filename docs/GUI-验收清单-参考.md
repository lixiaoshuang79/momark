# GUI 验收操作清单（主 agent 用）

> 每个里程碑分支合并后，按对应小节在真机 GUI 上操作验收。
> 截图证据存 /tmp/momark-accept-<milestone>-<序号>.png，视觉核验后归档到 docs/验收证据/。

## 通用准备

```bash
cd ~/deepseek/2026-09-03/momark-native
./build-app.sh debug
pkill -f 'MoMark.app/Contents'; sleep 1
./MoMark.app/Contents/MacOS/Momark "$PWD/Demo.md" &
sleep 3 && swift /tmp/momark-winlist.swift   # 确认窗口标题
```

## M2 所见即所得（7 项，docs/M2-BRIEF.md §4）

1. 标题 # ~ ######：字体 28→13 递减、加粗；语法字符不显示
2. 粗体/斜体：样式生效、`**` `*` 不显示；光标进入 token 时语法字符 reveal
3. 行内代码：红色 #EB5757 + 胶囊浅灰底；反引号隐藏
4. 链接：仅链接文本可见 + 下划线同正文色；`[](url)` 隐藏；光标进入 reveal
5. 代码块：整块浅灰底 + 等宽 13；首/末围栏行隐藏；光标落围栏行内 reveal
6. 引用块：左侧缩进 16 + secondaryLabel 色；`>` 隐藏
7. 列表：`-` 淡化 tertiaryLabel；表格 `|` 淡化；分隔线淡化
8. IME：中文输入法组字时无样式跳动/无变形（实测拼音+五笔一类）

## M3 图片粘贴 + 表格

1. 复制一张图片（截图/文件）→ Cmd+V 到编辑器中间
   - PicGo 运行中：出现「上传中…」占位 → 变成 `![image](https://md-…cos…/…)`
   - PicGo 未运行：占位回滚消失 + 底部中文提示
2. Demo.md 表格：光标在表格块 → 菜单「折叠表格」→ 渲染态网格（表头底色、对齐）
   - 渲染态单击 → 展开回源码，逐字符无损
   - 拖拽列分隔线（±4pt 命中，光标变 ←→）→ 相邻两列宽变化、总宽不变、最小 48pt

## M4 公式 / mermaid / iframe / 浏览器面板

1. `$E=mc^2$` 行内、`$$…$$` 块级 → 渲染出公式图
2. ```mermaid 代码块 → SVG 图表
3. iframe 标签 → 沙箱渲染（momark-web:// scheme 拦截生效）
4. 菜单/⌥⌘B → 右侧 420pt 浏览器面板开合；面板打开 Demo.md 所在目录 md 文件 → 并行浏览

## M5 图标 / 导出 / 字数

1. 菜单「MoMark → 偏好设置…」：4 内置图标缩略图 + 自定义图片；选中即 Dock 图标变化；重启保持
2. 菜单「显示 → 切换字数统计」：字→词→句→字符 四态轮换，标题栏相应变化
3. 导出 HTML/PDF 成功且内容完整；打印面板可出

## M6 品牌打包

1. Dock 图标：M 徽章、米色底、无框
2. 关于面板：墨记 MoMark + 版本 + 图标
3. 菜单全中文
4. `./build-app.sh release` + zip：解压双击可运行