import { describe, expect, it } from 'vitest'
import {
  countByKind,
  filterByKind,
  filterFolderEntries,
  folderEntryKind,
  formatMtime,
  sortFolderEntries,
  splitName,
  toFolderEntries
} from '@/components/folderDrawer/folderModel'

// 与 preload 的 hasMarkdownExtension 同口径：它也认 .txt / .text
const isMd = (n: string) => /\.(md|markdown|mdown|txt|text)$/i.test(n)
const join = (a: string, b: string) => `${a}/${b}`

describe('同目录抽屉：md + html', () => {
  it('列 Markdown 与 HTML，不列 txt / 图片 / 点文件', () => {
    const names = ['报告.md', '报告.html', 'a.HTM', 'notes.txt', 'b.text', 'img.png', '.x.md']
    const entries = toFolderEntries(names, '/d', isMd, join)
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['a.HTM', 'html'],
      ['报告.html', 'html'],
      ['报告.md', 'md']
    ])
    expect(folderEntryKind('x.markdown', isMd)).toBe('md')
    expect(folderEntryKind('notes.txt', isMd)).toBeNull()
  })

  it('一个列表不分组：同名 md / html 挨在一起；类型 chip 计数与筛选', () => {
    const entries = toFolderEntries(['访谈10.md', '访谈2.html', '访谈2.md'], '/d', isMd, join)
    expect(entries.map((e) => e.name)).toEqual(['访谈2.html', '访谈2.md', '访谈10.md'])
    expect(countByKind(entries)).toEqual({ all: 3, md: 2, html: 1 })
    expect(filterByKind(entries, 'html').map((e) => e.name)).toEqual(['访谈2.html'])
    expect(filterByKind(entries, 'all')).toHaveLength(3)
  })

  it('按修改时间排序：新的在前，读不到时间的沉底', () => {
    const mtimes = new Map([
      ['old.md', 1000],
      ['new.html', 3000]
    ])
    const entries = toFolderEntries(['old.md', 'new.html', 'none.md'], '/d', isMd, join, mtimes)
    expect(sortFolderEntries(entries, 'mtime').map((e) => e.name)).toEqual([
      'new.html',
      'old.md',
      'none.md'
    ])
    expect(sortFolderEntries(entries, 'name').map((e) => e.name)).toEqual([
      'new.html',
      'none.md',
      'old.md'
    ])
  })

  it('筛选高亮：主干与扩展名分开，每个词都标出', () => {
    const { stem, ext } = splitName('Release Notes.md', 'rel no')
    expect(stem).toEqual([
      { text: 'Rel', hit: true },
      { text: 'ease ', hit: false },
      { text: 'No', hit: true },
      { text: 'tes', hit: false }
    ])
    expect(ext).toEqual([{ text: '.md', hit: false }])
    expect(splitName('a.html', 'htm').ext).toEqual([
      { text: '.', hit: false },
      { text: 'htm', hit: true },
      { text: 'l', hit: false }
    ])
  })

  it('筛选与类型可以叠加', () => {
    const entries = toFolderEntries(['报告.md', '报告.html', '周报.md'], '/d', isMd, join)
    expect(filterFolderEntries(filterByKind(entries, 'md'), '报告').map((e) => e.name)).toEqual([
      '报告.md'
    ])
  })

  it('修改时间短标签', () => {
    const now = new Date(2026, 10, 21, 18, 0).getTime()
    expect(formatMtime(new Date(2026, 10, 21, 9, 5).getTime(), now)).toBe('09:05')
    expect(formatMtime(new Date(2026, 2, 3).getTime(), now)).toBe('3-3')
    expect(formatMtime(new Date(2024, 0, 9).getTime(), now)).toBe('2024-1-9')
    expect(formatMtime(0, now)).toBe('')
  })
})
