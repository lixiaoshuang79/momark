// 「活的」内嵌 HTML 块：标记 ↔ 沙箱 iframe 之间的纯字符串处理。
//
// 单独放一个叶子模块（零依赖）：导出用的两个 util 都要用它，单测也要能直接跑，
// 不该为了两个字符串函数把整个编辑引擎拖进来。
//
// 为什么是「标记 + 事后注入」而不是直接把 iframe 写进 markdown：`<iframe>` 不在导出
// 用的 DOMPurify 白名单里（`USE_PROFILES.html` 的默认名单没有它），写进 markdown 会被
// 整段删掉；先写一个标记 div、等引擎净化完再补上 iframe 就不受影响。

/**
 * 标记用的类名前缀。
 * 用 class 而不是 data-* 属性：导出配置是 `ALLOW_DATA_ATTR: false`，自定义 data 属性
 * 会被洗掉，class 会原样保留。
 */
export const LIVE_FRAME_CLASS_PREFIX = 'momark-export-frame-'

/**
 * 标记 div 的定位正则。属性顺序不保证（DOMPurify 会重新序列化），所以只在整段开标签里
 * 找 class；序号后面必须是非单词字符，免得误伤 `…-frame-0x` 这类相似类名。
 */
const LIVE_FRAME_REG = new RegExp(
  `<div\\b([^>]*\\bclass=["'][^"']*\\b${LIVE_FRAME_CLASS_PREFIX}(\\d+)\\b[^"']*["'][^>]*)>`,
  'g'
)

// srcdoc 是 HTML 属性：属性值会被 HTML 解码后再交给帧解析，所以这里可以把 `&`/`<`/`>`/`"`
// 全部转义成实体 —— 帧拿到的字节与原文一致，但**父文档的标记里不会再出现 `<script>` 这类
// 序列**。实测过不转义 `<` 的代价：payload 里的 `<script>` 会逃出属性、变成父文档的真标记，
// 未闭合的那个把后面的控件脚本整段吞掉（浏览器里 script 元素数变成 0，控件永远不出现）。
const escapeSrcdoc = (html: string): string =>
  html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 导出物里沙箱帧的权限。
 *
 * 为什么比编辑器里宽：编辑器那个帧是「不透明源 + 只允许脚本」，为的是挡住块里的脚本碰到
 * 应用本体（编辑窗口带 Node 与 preload）；代价是 localStorage / cookie / 表单提交 /
 * alert 全被禁，原型一碰这些 API 就抛 SecurityError，表现成「点了没反应」。
 * 导出的是一份**静态 HTML 文件**，宿主页面只是文档本身，同源也碰不到什么，所以按原型
 * 的需要放开：脚本 + 同源（存储）+ 表单 + 弹窗 + 模态框。顶楼导航仍然禁止。
 */
const LIVE_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'

/**
 * 把一个块的源码包成可分发的沙箱帧。
 * `srcdoc` 是 HTML 属性，转义只处理 `&` 与 `"`——`<`/`>` 是标记本身，不能转。
 */
export const buildLiveFrame = (html: string): string =>
  `<iframe sandbox="${LIVE_FRAME_SANDBOX}" title="内嵌 HTML" ` +
  'style="display:block;width:100%;height:100%;border:0" ' +
  `srcdoc="${escapeSrcdoc(html)}"></iframe>`

/**
 * 「跟随布局」的块在导出物里的额外类名：跳出正文栏、铺满页面可用宽度。
 *
 * 导出页的正文栏是 `max-width:980px` 居中（引擎的排版样式），照搬编辑器里的像素宽
 * 会把原型挤在中间一条、两侧大片空白，而且拖拽还被正文栏卡住（`max-width:100%`）。
 * 带这个类名的块改以页面为基准：默认宽度 = 页面可用宽度，拖拽上限同样是页面宽度。
 */
export const LIVE_FRAME_BLEED_CLASS = 'momark-export-frame-bleed'

/** 出血块两侧留的页面边距（px）。CSS 与控件脚本必须用同一个值。 */
export const LIVE_FRAME_BLEED_PAD = 24

/** live 形态在 markdown 里留下的占位（尺寸写在它身上，iframe 填满它）。 */
export const buildLivePlaceholder = (
  index: number,
  width: number,
  height: number,
  auto: boolean
): string =>
  `<div class="${LIVE_FRAME_CLASS_PREFIX}${index}${auto ? ` ${LIVE_FRAME_BLEED_CLASS}` : ''}" ` +
  `style="${auto ? '' : `width:${width}px;`}height:${height}px;overflow:hidden"></div>`

/**
 * 把标记 div 补上对应的沙箱 iframe（在引擎净化之后再调用）。
 * 片段缺失时保持原样：宁可那块留个空框，也不塞半截东西进导出物。
 */
export const injectLiveFrames = (article: string, frames: string[]): string => {
  if (!frames.length) return article

  let injected = 0
  const out = article.replace(LIVE_FRAME_REG, (match, _attrs: string, index: string) => {
    const frame = frames[Number(index)]
    if (!frame) return match
    injected += 1
    return match + frame
  })

  if (injected !== frames.length) {
    // 标记被洗掉时会少注入：留个线索，便于定位是哪种内容触发的。
    console.warn(`[export] live 内嵌块注入 ${injected}/${frames.length}`)
  }
  return out
}

// ── 导出物里的交互控件（悬停工具条 + 右下角拖拽手柄）────────────────────────
//
// 为什么要在导出页里再挂一套：编辑器里的缩放/拖拽是会话内的（只写内联 style，从不写回
// markdown），导出的 HTML 原本只有一个填满标记 div 的 iframe —— 打开后既不能缩放也不能
// 改大小。这里把同一套控件复刻到导出页，语义与编辑器逐条对齐（见 muya 的
// block/commonMark/html/htmlPreview.ts `createFrameShell`）。
//
// 控件 DOM（全部挂在标记 div 内部，因此标记 div 就是「外壳」）：
//   <div class="momark-export-frame-N">        ← 外壳：定位基准 + 裁剪 + 尺寸基线
//     <iframe …>                                ← 被缩放/被拖拽的对象
//     <div class="momark-export-frame-toolbar"> ← 悬停显示，绝对定位于外壳右下
//       <button class="momark-export-frame-btn">−</button>
//       <span class="momark-export-frame-zoom">100%</span>  ← 点击复位 100%
//       <button class="momark-export-frame-btn">+</button>
//     </div>
//     <div class="momark-export-frame-resizer"></div>       ← 右下角拖拽手柄
//   </div>

/** 控件的 CSS：由 exportHtml 追加进导出页的 <style>。 */
export const buildFrameControlsStyle = (): string =>
  `
/* 导出物里「活的」内嵌 HTML 块的交互控件（与编辑器里的 .mu-html-frame-* 同一套语义）。
   类名统一带 momark-export-frame 前缀，避免与正文样式打架。
   外壳直接命中标记 div 自身（momark-export-frame-<序号>），不额外加类：
   标记 div 身上的尺寸样式由导出时写死，保持它是唯一的事实来源。 */
div[class^="momark-export-frame-"] {
  position: relative;
  display: block;
  margin: 0.5em 0;
  /* 帧默认透明：原型 body 没铺满时正文会从块下面透出来，给纸色兜底。 */
  background: var(--bgColor-default, #ffffff);
}
/* 「跟随布局」的块：正文栏（980px 居中）是给文字排版的，装原型太窄 —— 两侧一堆空白，
   拖拽也被卡住。这类块按**页面**铺满，只留 ${LIVE_FRAME_BLEED_PAD}px 边距。
   注意规则必须排在外壳规则之后（选择器特异性相同，靠顺序取胜）。 */
div.${LIVE_FRAME_BLEED_CLASS} {
  width: calc(100vw - ${LIVE_FRAME_BLEED_PAD * 2}px);
  max-width: calc(100vw - ${LIVE_FRAME_BLEED_PAD * 2}px);
  margin-left: calc(50% - 50vw + ${LIVE_FRAME_BLEED_PAD}px);
  margin-right: calc(50% - 50vw + ${LIVE_FRAME_BLEED_PAD}px);
}
/* 注意：外壳选择器 div[class^="momark-export-frame-"] 也会命中工具条与手柄（类名同前缀），
   所以控件规则必须用「外壳 > 控件」的后代作用域提高特异性，否则 position 会被外壳的
   relative 覆盖、控件被排到框外并被正文盖住 —— 实测点不到的根因。 */
div[class^="momark-export-frame-"] > .momark-export-frame-toolbar {
  position: absolute;
  z-index: 10;
  margin: 0;
  right: 6px;
  bottom: 6px;
  display: none;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
  user-select: none;
}
/* 悬停用同一个属性选择器：外壳身上只有带序号的标记类名，没有独立的「外壳类」。 */
div[class^="momark-export-frame-"]:hover > .momark-export-frame-toolbar {
  display: flex;
}
div[class^="momark-export-frame-"]:hover > .momark-export-frame-resizer {
  display: block;
}
.momark-export-frame-toolbar button {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #fff;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.momark-export-frame-toolbar button:hover {
  background: rgba(255, 255, 255, 0.22);
}
.momark-export-frame-zoom {
  min-width: 40px;
  text-align: center;
  cursor: pointer;
}
.momark-export-frame-zoom:hover {
  text-decoration: underline;
}
div[class^="momark-export-frame-"] > .momark-export-frame-resizer {
  position: absolute;
  z-index: 11;
  margin: 0;
  right: -3px;
  bottom: -3px;
  display: none;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  border-right: 3px solid rgba(128, 128, 128, 0.9);
  border-bottom: 3px solid rgba(128, 128, 128, 0.9);
  border-bottom-right-radius: 6px;
  touch-action: none;
}
`

/**
 * 控件脚本（不含 `<script>` 标签），由 exportHtml 在 `</body>` 前注入。
 *
 * 写成字符串而不是真实函数：这个模块是零依赖叶子模块（单测要能在没有 DOM、没有编辑器
 * 的环境里直接跑），导出页里跑的必须是自包含的 ES5 级原生 JS。
 *
 * 缩放语义 = 浏览器「页面缩放」，与编辑器逐字对齐：
 *   · iframe 拿 CSS `zoom`；
 *   · 布局尺寸补偿成 `宽 / zoom`、`高 / zoom`，视觉外框（外壳的宽高）保持不变；
 *   · 内层页面按更小的视口重排再放大渲染 —— 图表会按新视口重画，而不是被拉糊。
 * 拖拽则改的是真实视口尺寸（外壳与 iframe 一起变大变小）。
 */
export const buildFrameControlsScript = (): string =>
  [
    '(function () {',
    "  var PREFIX = 'momark-export-frame-';",
    '  var ZOOM_MIN = 0.5;',
    '  var ZOOM_MAX = 2;',
    '  var ZOOM_STEP = 0.1;',
    '  var MIN_WIDTH = 240;',
    '  var MIN_HEIGHT = 160;',
    '  // 两侧留的页面边距，与 CSS 里的出血规则同值。',
    '  var BLEED_PAD = ' + String(LIVE_FRAME_BLEED_PAD) + ';',
    '',
    '  function clampZoom(value) {',
    '    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));',
    '  }',
    '',
    '  // 宽度上限是**页面**可用宽度，不是正文栏：正文栏是给文字排版的（980px 居中），',
    '  // 拿它当上限会把原型永远卡在窄窄一条里。',
    '  function pageMaxWidth() {',
    '    var viewport = document.documentElement.clientWidth || 0;',
    '    return viewport > 0 ? Math.max(MIN_WIDTH, viewport - BLEED_PAD * 2) : Infinity;',
    '  }',
    '',
    '  function parseSize(value) {',
    '    var size = parseFloat(value);',
    '    return isFinite(size) ? size : 0;',
    '  }',
    '',
    '  // 初始视口 = 导出时写死在标记 div 上的显示尺寸（编辑器里的显示大小）。',
    '  function measure(shell, frame) {',
    '    var rect = shell.getBoundingClientRect();',
    '    var width = rect.width || shell.offsetWidth || parseSize(shell.style.width);',
    '    var height = rect.height || shell.offsetHeight || parseSize(shell.style.height);',
    '    if (!width) width = frame.offsetWidth || parseSize(frame.style.width);',
    '    if (!height) height = frame.offsetHeight || parseSize(frame.style.height);',
    '    return { width: width, height: height };',
    '  }',
    '',
    '  function decorate(shell, frame) {',
    "    var toolbar = document.createElement('div');",
    "    toolbar.className = PREFIX + 'toolbar';",
    "    var out = document.createElement('button');",
    "    out.type = 'button';",
    "    out.className = PREFIX + 'btn';",
    "    out.textContent = '\\u2212';",
    "    out.title = '缩小';",
    "    var pct = document.createElement('span');",
    "    pct.className = PREFIX + 'zoom';",
    "    pct.textContent = '100%';",
    "    pct.title = '点击复位到 100%';",
    "    var zin = document.createElement('button');",
    "    zin.type = 'button';",
    "    zin.className = PREFIX + 'btn';",
    "    zin.textContent = '+';",
    "    zin.title = '放大';",
    '    toolbar.appendChild(out);',
    '    toolbar.appendChild(pct);',
    '    toolbar.appendChild(zin);',
    '',
    "    var resizer = document.createElement('div');",
    "    resizer.className = PREFIX + 'resizer';",
    "    resizer.title = '拖拽调整大小';",
    '',
    '    shell.appendChild(toolbar);',
    '    shell.appendChild(resizer);',
    '',
    '    var base = measure(shell, frame);',
    '    var curW = base.width;',
    '    var curH = base.height;',
    '    var zoom = 1;',
    '',
    '    // 交互开始时重新量一次：页面可能被缩放/改过窗口大小，基线要跟着走。',
    '    function refresh() {',
    '      var size = measure(shell, frame);',
    '      if (size.width) curW = size.width;',
    '      if (size.height) curH = size.height;',
    '    }',
    '',
    '    function apply() {',
    '      if (!curW || !curH) return;',
    "      shell.style.width = curW + 'px';",
    "      shell.style.height = curH + 'px';",
    "      shell.style.overflow = 'hidden';",
    '      // 比正文栏宽就自己居中：不然只往右下溢出，看着像排版坏了。',
    '      // 正文栏本身居中，所以「按正文栏中线居中」= 按页面中线居中。',
    '      var column = shell.parentElement ? shell.parentElement.clientWidth : 0;',
    '      if (column > 0 && curW > column + 1) {',
    "        var offset = 'calc(50% - ' + curW / 2 + 'px)';",
    '        shell.style.marginLeft = offset;',
    '        shell.style.marginRight = offset;',
    '      } else {',
    "        shell.style.marginLeft = '';",
    "        shell.style.marginRight = '';",
    '      }',
    '      // 页面缩放：视觉外框尺寸不变，内层视口按 宽/zoom、高/zoom 重排后放大渲染。',
    '      frame.style.zoom = String(zoom);',
    "      frame.style.width = curW / zoom + 'px';",
    "      frame.style.height = curH / zoom + 'px';",
    "      pct.textContent = Math.round(zoom * 100) + '%';",
    '    }',
    '',
    '    function zoomTo(next) {',
    '      refresh();',
    '      zoom = clampZoom(next);',
    '      apply();',
    '    }',
    '',
    '    function resizeTo(width, height) {',
    '      curW = Math.min(pageMaxWidth(), Math.max(MIN_WIDTH, width));',
    '      curH = Math.max(MIN_HEIGHT, height);',
    '      apply();',
    '    }',
    '',
    "    out.addEventListener('click', function (event) {",
    '      event.preventDefault();',
    '      zoomTo(zoom / (1 + ZOOM_STEP));',
    '    });',
    "    zin.addEventListener('click', function (event) {",
    '      event.preventDefault();',
    '      zoomTo(zoom * (1 + ZOOM_STEP));',
    '    });',
    "    pct.addEventListener('click', function (event) {",
    '      event.preventDefault();',
    '      zoomTo(1);',
    '    });',
    '',
    '    var dragX = 0;',
    '    var dragY = 0;',
    '    var dragW = 0;',
    '    var dragH = 0;',
    '    var dragging = false;',
    "    resizer.addEventListener('pointerdown', function (event) {",
    '      event.preventDefault();',
    '      refresh();',
    '      dragX = event.clientX;',
    '      dragY = event.clientY;',
    '      dragW = curW;',
    '      dragH = curH;',
    '      dragging = true;',
    '      if (resizer.setPointerCapture) resizer.setPointerCapture(event.pointerId);',
    '    });',
    "    resizer.addEventListener('pointermove', function (event) {",
    '      if (!dragging) return;',
    '      resizeTo(dragW + (event.clientX - dragX), dragH + (event.clientY - dragY));',
    '    });',
    '    function stopDrag() {',
    '      dragging = false;',
    '      dragW = 0;',
    '      dragH = 0;',
    '    }',
    "    resizer.addEventListener('pointerup', stopDrag);",
    "    resizer.addEventListener('pointercancel', stopDrag);",
    '',
    '    apply();',
    '  }',
    '',
    '  function init() {',
    "    var shells = document.querySelectorAll('div[class*=\"' + PREFIX + '\"]');",
    '    for (var i = 0; i < shells.length; i++) {',
    '      var shell = shells[i];',
    '      // 只认标记 div：类名形如 momark-export-frame-<序号>，控件自身的类名后面不是数字。',
    "      if (!new RegExp('\\\\b' + PREFIX + '\\\\d+\\\\b').test(shell.className)) continue;",
    "      var frame = shell.querySelector('iframe');",
    '      if (!frame) continue;',
    "      if (shell.getAttribute('data-momark-frame-controls')) continue;",
    "      shell.setAttribute('data-momark-frame-controls', '1');",
    '      decorate(shell, frame);',
    '    }',
    '  }',
    '',
    '  function boot() {',
    '    // 双 rAF：等首帧布局落定再量基线，否则可能读到未定型的宽度。',
    '    if (window.requestAnimationFrame) {',
    '      window.requestAnimationFrame(function () {',
    '        window.requestAnimationFrame(init);',
    '      });',
    '    } else {',
    '      window.setTimeout(init, 0);',
    '    }',
    '  }',
    '',
    "  if (document.readyState === 'loading') {",
    "    document.addEventListener('DOMContentLoaded', boot);",
    '  } else {',
    '    boot();',
    '  }',
    '  // 保险：实测在真实导出文档里 DOMContentLoaded + 双 rAF 这条路可能没落地，控件整块',
    '  // 不出现。init 幂等（靠 data-momark-frame-controls 去重），所以 load 后再跑一次、',
    '  // 外加定时轮询兜底，直到挂上或超时。',
    "  window.addEventListener('load', boot);",
    '  var guard = 0;',
    '  var timer = window.setInterval(function () {',
    '    init();',
    '    guard += 1;',
    "    if (guard > 40 || document.querySelector('[data-momark-frame-controls]'))",
    '      window.clearInterval(timer);',
    '  }, 250);',
    '})();'
  ].join('\n')
