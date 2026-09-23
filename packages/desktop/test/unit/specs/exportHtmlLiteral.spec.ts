import { describe, expect, it, vi } from 'vitest'

// `@/util/pdf`（被 `exportHtml` 间接引入）要经 preload 桥拿 `window.path` /
// `window.DIRNAME`，在 hoisted import 之前先补上。
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: { path?: { sep: string; join?: (...p: string[]) => string }; DIRNAME?: string }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', join: (...parts: string[]) => parts.join('/') }
  w.window.DIRNAME = '/docs'
})

import { buildLiveFrame, LIVE_FRAME_CLASS_PREFIX } from '@/util/exportLiveFrame'
import { exportStyledHTML } from '@/util/exportHtml'

// 导出**不得改写正文里的 `$` 序列**。
//
// `String.prototype.replace` 对「替换串是字符串」的情况有一套自己的语法：`$$` 折成一个
// 字面 `$`、`$&` 折成整个匹配。导出链路里 `bodyHtml`（正文原文，含内嵌块源码）、TOC
// 都是从文档来的，一旦按字符串替换，文档内容就会被静默改写。
//
// 实测的病灶：用户原型里 `var $$ = function(s,r){ return …querySelectorAll… };`（数组版
// 选择器）被折成 `var $ = …`，于是 `$` 变成了返回数组的函数 —— 帧内脚本在
// `$(...).addEventListener` 上抛 TypeError、整段中断，表格一行都渲染不出来；编辑器里
// 一切正常（编辑器不走字符串替换），只有导出物是坏的。

const NO_MUYA = null as unknown as Parameters<typeof exportStyledHTML>[0]
const placeholder =
  `<div class="${LIVE_FRAME_CLASS_PREFIX}0" ` +
  'style="width:800px;max-width:100%;height:400px;overflow:hidden"></div>'

/** 取出 srcdoc 属性的原始文本（导出物里被实体转义过）。 */
const srcdocOf = (html: string): string =>
  (/srcdoc="([^"]*)"/.exec(html)?.[1] ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

describe('exportStyledHTML — 正文里的 $ 序列', () => {
  it('内嵌块源码里的 $$ 原样进 srcdoc（不得折成 $）', async () => {
    const source =
      '<script>var $$ = function(s,r){ return Array.prototype.slice.call(' +
      '(r||document).querySelectorAll(s)); };</script>'
    const out = await exportStyledHTML(NO_MUYA, `${placeholder}\n`, {
      frames: [buildLiveFrame(source)]
    })

    expect(srcdocOf(out)).toBe(source)
    expect(srcdocOf(out)).toContain('var $$ = function')
    // `$&` 同样不能折成「整个匹配」
    expect(srcdocOf(out)).not.toContain('var $ = function')
  })

  it('正文文本里的 $$ 原样保留', async () => {
    const out = await exportStyledHTML(NO_MUYA, '价格是 $$ 与 $& 两种写法\n', {})

    expect(out).toContain('$$')
    expect(out).toContain('$&amp;')
  })

  it('TOC 里的 $$ 原样保留', async () => {
    const toc = '<ul class="toc"><li>$$ 标题</li></ul>'
    const out = await exportStyledHTML(NO_MUYA, '[TOC]\n\n# 正文\n', { toc })

    expect(out).toContain('$$ 标题')
    expect(out).toContain('class="toc"')
  })
})
