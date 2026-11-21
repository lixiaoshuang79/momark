import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import {
  DASH_PITCH_MAX,
  DASH_PITCH_MIN,
  clampLabelTop,
  dashWidth,
  followScrollTop,
  keepJumpHold,
  pinnedRailWidth,
  railPitch,
  readingProgress,
  resolveActiveHeading,
  rowAt,
  toRailItems
} from '@/components/headingRail/railModel'
import {
  activeHeadingSource,
  registerHeadingSource,
  type HeadingSource
} from '@/components/headingRail/headingSource'
import { findMarkdownHeadingLine, listMarkdownHeadings } from '@/util/sourceModeToc'
import {
  compactDirLabel,
  filterFolderEntries,
  resolveDrawerDir,
  toFolderEntries
} from '@/components/folderDrawer/folderModel'

describe('toRailItems', () => {
  it('normalises depth against the shallowest level in the document', () => {
    const items = toRailItems([
      { content: 'Intro', lvl: 2, slug: 'a' },
      { content: 'Detail', lvl: 3, slug: 'b' },
      { content: 'Deep', lvl: 6, slug: 'c' },
      { content: 'Next', lvl: 2, slug: 'd' }
    ])
    expect(items.map((i) => i.depth)).toEqual([0, 1, 4, 0])
    expect(items.map((i) => i.level)).toEqual([2, 3, 6, 2])
    expect(items[2]).toMatchObject({ index: 2, text: 'Deep', slug: 'c' })
  })

  it('collapses whitespace, tolerates junk levels and missing slugs', () => {
    const items = toRailItems([
      { content: '  a\n  long   title ', lvl: 1, slug: '' },
      { content: 42, lvl: 'x', slug: undefined },
      { content: undefined, lvl: 9, slug: 's' }
    ])
    expect(items[0]).toMatchObject({ text: 'a long title', slug: null, level: 1 })
    expect(items[1]).toMatchObject({ text: '42', level: 1 })
    expect(items[2]).toMatchObject({ text: '', level: 6, depth: 5 })
  })

  it('returns [] for an empty toc', () => {
    expect(toRailItems([])).toEqual([])
  })
})

describe('dashWidth', () => {
  it('shrinks with depth and clamps both ends', () => {
    const widths = [0, 1, 2, 3, 4, 5].map(dashWidth)
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThan(widths[i - 1]!)
    expect(dashWidth(-3)).toBe(widths[0])
    expect(dashWidth(40)).toBe(widths[5])
  })
})

describe('railPitch', () => {
  it('uses the roomy pitch when few headings', () => {
    expect(railPitch(5, 600)).toEqual({ pitch: DASH_PITCH_MAX, overflow: false })
  })
  it('compresses to fit, then overflows below the minimum', () => {
    const fit = railPitch(80, 600)
    expect(fit.overflow).toBe(false)
    expect(fit.pitch).toBeGreaterThanOrEqual(DASH_PITCH_MIN)
    expect(fit.pitch * 80).toBeLessThanOrEqual(600)
    expect(railPitch(300, 600)).toEqual({ pitch: DASH_PITCH_MIN, overflow: true })
  })
  it('is safe with no headings or no height yet', () => {
    expect(railPitch(0, 600).overflow).toBe(false)
    expect(railPitch(10, 0).overflow).toBe(false)
  })
})

describe('pinnedRailWidth', () => {
  it('follows 20% of the window within 188–248px', () => {
    expect(pinnedRailWidth(600)).toBe(188)
    expect(pinnedRailWidth(1100)).toBe(220)
    expect(pinnedRailWidth(3000)).toBe(248)
  })
})

describe('resolveActiveHeading', () => {
  // 标题在内容里的绝对位置；topOf 换算成相对可视区顶边。
  const headings = [0, 400, 900, 1500, 2600, 2900]
  const at = (scrollTop: number, extra: Partial<Parameters<typeof resolveActiveHeading>[0]> = {}) =>
    resolveActiveHeading({
      count: headings.length,
      topOf: (i) => headings[i]! - scrollTop,
      scrollTop,
      viewportHeight: 600,
      scrollHeight: 3200,
      probeOffset: 200,
      ...extra
    })

  it('picks the last heading above the reading line', () => {
    expect(at(0)).toBe(0)
    expect(at(250)).toBe(1)
    expect(at(1000)).toBe(2)
    expect(at(1400)).toBe(3)
  })

  it('is -1 before the first heading is reached', () => {
    expect(
      resolveActiveHeading({
        count: 2,
        topOf: (i) => [500, 900][i]! - 0,
        scrollTop: 0,
        viewportHeight: 600,
        scrollHeight: 3000,
        probeOffset: 200
      })
    ).toBe(-1)
  })

  it('slides the reading line down near the end so short final sections become current', () => {
    // 到底：maxScroll = 2600，最后一个标题在 2900，阅读线固定 200 的话只能到 2800。
    expect(at(2600)).toBe(5)
    // 离底还剩超过半屏：阅读线还在原位。
    expect(at(2200)).toBe(3)
  })

  it('moves monotonically while scrolling (no flicker back)', () => {
    let last = -1
    for (let top = 0; top <= 2600; top += 25) {
      const next = at(top)
      expect(next).toBeGreaterThanOrEqual(last)
      last = next
    }
    expect(last).toBe(5)
  })

  it('handles unscrollable documents and empty input', () => {
    expect(at(0, { scrollHeight: 500 })).toBe(0)
    expect(at(0, { count: 0 })).toBe(-1)
    expect(at(0, { viewportHeight: 0 })).toBe(-1)
  })

  it('reads only O(log n) headings', () => {
    let reads = 0
    const n = 4096
    resolveActiveHeading({
      count: n,
      topOf: (i) => {
        reads++
        return i * 50 - 100000
      },
      scrollTop: 100000,
      viewportHeight: 800,
      scrollHeight: n * 50 + 800,
      probeOffset: 200
    })
    expect(reads).toBeLessThanOrEqual(14)
  })
})

describe('resolveActiveHeading at the top of the document', () => {
  // 真实情形：一级标题 + 紧跟的二级、三级标题都挤在第一屏上半，第一个标题顶边也 > 0；
  // 阅读线 290（= 344 − 滚动容器顶 54），可视区 900。
  const headings = [48, 120, 215, 450, 720, 1100, 1500, 1900, 2400, 3000]
  const input = (
    scrollTop: number,
    extra: Partial<Parameters<typeof resolveActiveHeading>[0]> = {}
  ) => ({
    count: headings.length,
    topOf: (i: number) => headings[i]! - scrollTop,
    scrollTop,
    viewportHeight: 900,
    scrollHeight: 3600,
    probeOffset: 290,
    ...extra
  })
  const at = (scrollTop: number, extra: Partial<Parameters<typeof resolveActiveHeading>[0]> = {}) =>
    resolveActiveHeading(input(scrollTop, extra))

  it('is the first heading at scrollTop 0 even though the reading line passes three headings', () => {
    expect(headings.filter((h) => h <= 290)).toHaveLength(3)
    expect(at(0)).toBe(0)
  })

  it('advances one heading at a time from the top, never jumping ahead then back', () => {
    const seen: number[] = []
    let last = -1
    for (let top = 0; top <= 2700; top += 1) {
      const next = at(top)
      expect(next).toBeGreaterThanOrEqual(last)
      if (next !== last) seen.push(next)
      last = next
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('is back to the normal reading line once scrolled past the ramp', () => {
    // scrollTop ≥ 阅读线：与没有开头修正时一致。
    for (const top of [290, 400, 800, 1300]) {
      const plain = headings.filter((h) => h - top <= 290).length - 1
      expect(at(top)).toBe(plain)
    }
  })

  it('works with the source-mode reading line too', () => {
    // 源码模式：阅读线 88，行高 ~22，开头连续几行都是标题。
    const lines = [50, 72, 94, 160, 400]
    const r = (scrollTop: number) =>
      resolveActiveHeading({
        count: lines.length,
        topOf: (i) => lines[i]! - scrollTop,
        scrollTop,
        viewportHeight: 700,
        scrollHeight: 2000,
        probeOffset: 88
      })
    expect(r(0)).toBe(0)
    expect(r(20)).toBe(1)
    expect(r(88)).toBe(3)
  })

  it('keeps -1 when the document opens with text before the first heading', () => {
    // 第一个标题在阅读线之下：阅读线不会被拉下去迁就它。
    expect(at(0, { topOf: (i) => [400, 900][i]!, count: 2 })).toBe(-1)
  })

  it('is the first heading in a short, unscrollable document', () => {
    expect(at(0, { scrollHeight: 900 })).toBe(0)
    expect(at(0, { scrollHeight: 600 })).toBe(0)
  })

  it('still ends on the last heading in a document shorter than the ramp', () => {
    // maxScroll = 200 < 阅读线：开头与文末两段插值同时生效，仍单调并能到最后一个。
    const short = [48, 120, 215, 700, 1000]
    let last = -1
    for (let top = 0; top <= 200; top += 1) {
      const next = resolveActiveHeading({
        count: short.length,
        topOf: (i) => short[i]! - top,
        scrollTop: top,
        viewportHeight: 900,
        scrollHeight: 1100,
        probeOffset: 290
      })
      expect(next).toBeGreaterThanOrEqual(last)
      last = next
    }
    expect(last).toBe(4)
  })

  it('does not read the first heading when far from the top', () => {
    const reads: number[] = []
    resolveActiveHeading(
      input(1300, {
        topOf: (i) => {
          reads.push(i)
          return headings[i]! - 1300
        }
      })
    )
    expect(reads.filter((i) => i === 0)).toHaveLength(0)
  })
})

describe('keepJumpHold', () => {
  it('holds a clicked heading the editor cannot scroll to the reading line', () => {
    // 开头点第二个标题：正文滚不动，算出来仍是第一个。
    expect(keepJumpHold({ index: 1, scrollTop: 0 }, 0, 0)).toBe(true)
    // 只是重排（亚像素）：仍保持。
    expect(keepJumpHold({ index: 1, scrollTop: 0 }, 0, 0.5)).toBe(true)
  })

  it('keeps holding while scrolling toward it, releases once the computed one catches up', () => {
    expect(keepJumpHold({ index: 3, scrollTop: 100 }, 2, 140)).toBe(true)
    expect(keepJumpHold({ index: 3, scrollTop: 100 }, 3, 180)).toBe(false)
    // 文末：点了倒数第三个，算出来是最后一个；往上滚直到退回它。
    expect(keepJumpHold({ index: 7, scrollTop: 2600 }, 9, 2550)).toBe(true)
    expect(keepJumpHold({ index: 7, scrollTop: 2600 }, 7, 2400)).toBe(false)
  })

  it('releases when scrolling the other way', () => {
    expect(keepJumpHold({ index: 3, scrollTop: 100 }, 2, 60)).toBe(false)
    expect(keepJumpHold({ index: 7, scrollTop: 2600 }, 9, 2650)).toBe(false)
  })
})

describe('readingProgress', () => {
  it('reports 0–100 and treats short docs as fully read', () => {
    expect(readingProgress(0, 2000, 500)).toBe(0)
    expect(readingProgress(750, 2000, 500)).toBe(50)
    expect(readingProgress(1500, 2000, 500)).toBe(100)
    expect(readingProgress(0, 400, 500)).toBe(100)
  })
})

describe('rowAt / clampLabelTop / followScrollTop', () => {
  it('maps a pointer y to the nearest row, clamped', () => {
    expect(rowAt(-10, 10, 5)).toBe(0)
    expect(rowAt(25, 10, 5)).toBe(2)
    expect(rowAt(999, 10, 5)).toBe(4)
    expect(rowAt(5, 10, 0)).toBe(-1)
  })

  it('keeps the hover label inside the rail', () => {
    expect(clampLabelTop(100, 40, 600)).toBe(80)
    expect(clampLabelTop(5, 40, 600)).toBe(8)
    expect(clampLabelTop(598, 40, 600)).toBe(552)
    expect(clampLabelTop(50, 200, 100)).toBe(8)
  })

  it('only scrolls the rail when the active row leaves the safe band', () => {
    // 行高 5，可视 300，内容 1500。
    expect(followScrollTop(30, 5, 0, 300, 1500)).toBeNull()
    const target = followScrollTop(200, 5, 0, 300, 1500)
    expect(target).toBe(853)
    expect(followScrollTop(299, 5, 0, 300, 1500)).toBe(1200)
    expect(followScrollTop(-1, 5, 0, 300, 1500)).toBeNull()
  })
})

describe('heading source registry', () => {
  const make = (): HeadingSource => ({
    scroller: document.createElement('div'),
    probeOffset: () => 0,
    count: () => 0,
    topOf: () => 0
  })

  it('prefers the most recently registered source and falls back on unregister', () => {
    expect(activeHeadingSource.value).toBeNull()
    const muya = make()
    const source = make()
    const offMuya = registerHeadingSource(muya)
    expect(activeHeadingSource.value).toBe(muya)
    const offSource = registerHeadingSource(source)
    expect(activeHeadingSource.value).toBe(source)
    offSource()
    expect(activeHeadingSource.value).toBe(muya)
    offMuya()
    expect(activeHeadingSource.value).toBeNull()
  })

  it('carries source-provided items', () => {
    const items = ref(toRailItems([{ content: 'A', lvl: 1 }]))
    const off = registerHeadingSource({ ...make(), items })
    expect(activeHeadingSource.value?.items?.value[0]?.text).toBe('A')
    off()
  })
})

describe('listMarkdownHeadings (source mode)', () => {
  const md = [
    '---',
    'title: x',
    '---',
    '# Title',
    '',
    'Setext H1',
    '=========',
    '',
    '```md',
    '# not a heading',
    '```',
    '## Second **bold** [link](http://a) ##',
    'Setext H2',
    '---',
    '    # four-space indent is code, not a heading',
    '###',
    '####### seven is not a heading'
  ].join('\n')

  it('extracts level, plain text and line, skipping front matter and fences', () => {
    expect(listMarkdownHeadings(md)).toEqual([
      { line: 3, level: 1, text: 'Title' },
      { line: 5, level: 1, text: 'Setext H1' },
      { line: 11, level: 2, text: 'Second bold link' },
      { line: 12, level: 2, text: 'Setext H2' },
      { line: 15, level: 3, text: '' }
    ])
  })

  it('agrees with findMarkdownHeadingLine on documents without front matter', () => {
    const body = md.split('\n').slice(3).join('\n')
    const list = listMarkdownHeadings(body)
    list.forEach((heading, i) => {
      expect(findMarkdownHeadingLine(body, i)).toBe(heading.line)
    })
  })
})

describe('folder drawer model', () => {
  const dirname = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const join = (a: string, b: string) => `${a}/${b}`
  const isMd = (n: string) => /\.(md|markdown)$/i.test(n)

  it('uses the current file folder, falling back to the opened folder', () => {
    expect(resolveDrawerDir('/a/b/c.md', '/p', dirname)).toBe('/a/b')
    expect(resolveDrawerDir('', '/p', dirname)).toBe('/p')
    expect(resolveDrawerDir(undefined, null, dirname)).toBe('')
  })

  it('lists markdown files with natural order, hiding dotfiles', () => {
    const entries = toFolderEntries(
      ['file10.md', 'b.txt', '.hidden.md', 'File2.md', 'a.MARKDOWN'],
      '/d',
      isMd,
      join
    )
    expect(entries.map((e) => e.name)).toEqual(['a.MARKDOWN', 'File2.md', 'file10.md'])
    expect(entries[0]!.pathname).toBe('/d/a.MARKDOWN')
  })

  it('filters by every word, case-insensitively', () => {
    const entries = toFolderEntries(
      ['需求 v2.md', 'notes.md', 'Release Notes.md'],
      '/d',
      isMd,
      join
    )
    expect(filterFolderEntries(entries, 'NOTES').map((e) => e.name)).toEqual([
      'notes.md',
      'Release Notes.md'
    ])
    expect(filterFolderEntries(entries, 'rel notes').map((e) => e.name)).toEqual([
      'Release Notes.md'
    ])
    expect(filterFolderEntries(entries, '  ')).toHaveLength(3)
  })

  it('compacts the folder label', () => {
    expect(compactDirLabel('/Users/me/docs', '/Users/me')).toBe('~/docs')
    expect(compactDirLabel('/Users/me/a/b/c/d', '/Users/me')).toBe('…/b/c/d')
    expect(compactDirLabel('/srv/x', undefined)).toBe('/srv/x')
    expect(compactDirLabel('', '/Users/me')).toBe('')
  })
})
