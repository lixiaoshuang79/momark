// 文件夹抽屉的纯逻辑：列哪个目录、列哪些文件、怎么筛、怎么排。
//
// feat/right-panel-redesign（DESIGN-NOTES §2）：同时列 Markdown 与 HTML，一个
// 列表不分组（同目录的「报告.md / 报告.html」常是一对），顶部类型 chip 筛选；
// 默认按名称自然排序，可切到按修改时间。`.txt` 等其他文本类型不列。

export type FolderEntryKind = 'md' | 'html'

export interface FolderEntry {
  name: string
  pathname: string
  kind: FolderEntryKind
  /** 修改时间（ms）；读不到时为 0，排序时沉到最后 */
  mtime: number
}

export type FolderSort = 'name' | 'mtime'
export type FolderTypeFilter = 'all' | FolderEntryKind

/** 当前文档所在目录优先；未保存文档退回到打开的文件夹（项目根）。 */
export const resolveDrawerDir = (
  currentPathname: string | null | undefined,
  projectRoot: string | null | undefined,
  dirname: (p: string) => string
): string => {
  if (currentPathname) return dirname(currentPathname)
  return projectRoot ?? ''
}

const HTML_RE = /\.html?$/i
// hasMarkdownExtension 也认 .txt / .text：抽屉只放 Markdown，这两个排除（§4 #7）。
const PLAIN_TEXT_RE = /\.(txt|text)$/i

/** 抽屉里能列的类型；不是 md / html 返回 null。 */
export const folderEntryKind = (
  name: string,
  isMarkdown: (name: string) => boolean
): FolderEntryKind | null => {
  if (!name || name.startsWith('.')) return null
  if (HTML_RE.test(name)) return 'html'
  if (PLAIN_TEXT_RE.test(name)) return null
  return isMarkdown(name) ? 'md' : null
}

const byName = (a: FolderEntry, b: FolderEntry): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

/** Markdown + HTML 文件，按文件名自然排序（file2 在 file10 前）。 */
export const toFolderEntries = (
  names: readonly string[],
  dir: string,
  isMarkdown: (name: string) => boolean,
  join: (a: string, b: string) => string,
  mtimes?: ReadonlyMap<string, number>
): FolderEntry[] => {
  const entries: FolderEntry[] = []
  for (const name of names) {
    const kind = folderEntryKind(name, isMarkdown)
    if (!kind) continue
    entries.push({ name, pathname: join(dir, name), kind, mtime: mtimes?.get(name) ?? 0 })
  }
  return entries.sort(byName)
}

export const sortFolderEntries = (
  entries: readonly FolderEntry[],
  sort: FolderSort
): FolderEntry[] => {
  const list = [...entries]
  if (sort === 'mtime') return list.sort((a, b) => b.mtime - a.mtime || byName(a, b))
  return list.sort(byName)
}

export const countByKind = (
  entries: readonly FolderEntry[]
): { all: number; md: number; html: number } => {
  let md = 0
  let html = 0
  for (const entry of entries) {
    if (entry.kind === 'html') html += 1
    else md += 1
  }
  return { all: entries.length, md, html }
}

export const filterByKind = (
  entries: readonly FolderEntry[],
  type: FolderTypeFilter
): FolderEntry[] => (type === 'all' ? [...entries] : entries.filter((e) => e.kind === type))

const queryWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

/** 文件名筛选：忽略大小写；空格分隔的每个词都要出现。 */
export const filterFolderEntries = (
  entries: readonly FolderEntry[],
  query: string
): FolderEntry[] => {
  const words = queryWords(query)
  if (!words.length) return [...entries]
  return entries.filter((entry) => {
    const name = entry.name.toLowerCase()
    return words.every((word) => name.includes(word))
  })
}

export interface NamePart {
  text: string
  hit: boolean
}

/**
 * 文件名拆成「主干 + 扩展名」并标出筛选命中的字符（高亮用）。
 * 扩展名单独返回（界面里用弱化色）。
 */
export const splitName = (name: string, query: string): { stem: NamePart[]; ext: NamePart[] } => {
  const dot = name.lastIndexOf('.')
  const cut = dot > 0 ? dot : name.length
  const hits = new Array<boolean>(name.length).fill(false)
  const lower = name.toLowerCase()
  for (const word of queryWords(query)) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(word, from)
      if (at === -1) break
      for (let i = at; i < at + word.length; i += 1) hits[i] = true
      from = at + 1
    }
  }
  const parts = (start: number, end: number): NamePart[] => {
    const out: NamePart[] = []
    for (let i = start; i < end; i += 1) {
      const last = out[out.length - 1]
      if (last && last.hit === hits[i]) last.text += name[i]
      else out.push({ text: name[i]!, hit: hits[i]! })
    }
    return out
  }
  return { stem: parts(0, cut), ext: parts(cut, name.length) }
}

/** 「~/a/b/c」式的目录标签，最多保留末尾 3 级。 */
export const compactDirLabel = (dir: string, home: string | undefined, sep = '/'): string => {
  if (!dir) return ''
  let rel = dir
  if (home && (dir === home || dir.startsWith(home + sep))) rel = '~' + dir.slice(home.length)
  const segs = rel.split(sep).filter(Boolean)
  if (segs.length <= 3) return rel.startsWith(sep) ? sep + segs.join(sep) : segs.join(sep)
  return '…' + sep + segs.slice(-3).join(sep)
}

/** 修改时间的短标签：今天 → HH:mm，今年 → M-D，更早 → YYYY-M-D。 */
export const formatMtime = (mtime: number, now: number = Date.now()): string => {
  if (!mtime) return ''
  const d = new Date(mtime)
  const n = new Date(now)
  const pad = (v: number): string => String(v).padStart(2, '0')
  if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}-${d.getDate()}`
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
