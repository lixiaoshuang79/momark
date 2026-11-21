// 文件夹抽屉的纯逻辑：列哪个目录、列哪些文件、怎么筛。

export interface FolderEntry {
  name: string
  pathname: string
}

/** 当前文档所在目录优先；未保存文档退回到打开的文件夹（项目根）。 */
export const resolveDrawerDir = (
  currentPathname: string | null | undefined,
  projectRoot: string | null | undefined,
  dirname: (p: string) => string
): string => {
  if (currentPathname) return dirname(currentPathname)
  return projectRoot ?? ''
}

/** Markdown 文件，按文件名自然排序（file2 在 file10 前）。 */
export const toFolderEntries = (
  names: readonly string[],
  dir: string,
  isMarkdown: (name: string) => boolean,
  join: (a: string, b: string) => string
): FolderEntry[] =>
  names
    .filter((name) => !name.startsWith('.') && isMarkdown(name))
    .map((name) => ({ name, pathname: join(dir, name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

/** 文件名筛选：忽略大小写；空格分隔的每个词都要出现。 */
export const filterFolderEntries = (
  entries: readonly FolderEntry[],
  query: string
): FolderEntry[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...entries]
  return entries.filter((entry) => {
    const name = entry.name.toLowerCase()
    return words.every((word) => name.includes(word))
  })
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
