interface LabelSource {
  id: string
  filename: string
  pathname: string
}

const splitDirs = (pathname: string): string[] => {
  const parts = pathname.split(/[\\/]+/).filter(Boolean)
  parts.pop()
  return parts
}

/**
 * 标签显示名：文件名不重复时就用文件名；重名时补上最短的、能把它们彼此区分开的
 * 上级目录（`index.html · proto-a`、`index.html · v2/proto`）。没有路径的标签
 * （未命名文档、内嵌块快照）重名时按出现顺序加序号。
 *
 * 返回 `id → 显示名`。只看同名的那一组，与其他标签无关。
 */
export const getTabLabels = (tabs: readonly LabelSource[]): Map<string, string> => {
  const labels = new Map<string, string>()
  const groups = new Map<string, LabelSource[]>()
  for (const tab of tabs) {
    const group = groups.get(tab.filename)
    if (group) group.push(tab)
    else groups.set(tab.filename, [tab])
  }

  for (const [filename, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0]!.id, filename)
      continue
    }

    const withPath = group.filter((tab) => tab.pathname)
    const dirsById = new Map(withPath.map((tab) => [tab.id, splitDirs(tab.pathname)]))
    const maxDepth = Math.max(0, ...[...dirsById.values()].map((dirs) => dirs.length))
    const suffixOf = (dirs: string[], depth: number): string =>
      dirs.slice(Math.max(0, dirs.length - depth)).join('/')

    for (const tab of withPath) {
      const dirs = dirsById.get(tab.id)!
      let depth = 1
      while (depth < maxDepth) {
        const suffix = suffixOf(dirs, depth)
        const clash = withPath.some(
          (other) => other.id !== tab.id && suffixOf(dirsById.get(other.id)!, depth) === suffix
        )
        if (!clash) break
        depth++
      }
      const suffix = suffixOf(dirs, depth)
      labels.set(tab.id, suffix ? `${filename} · ${suffix}` : filename)
    }

    let seq = 0
    for (const tab of group) {
      if (tab.pathname) continue
      seq++
      labels.set(tab.id, seq === 1 ? filename : `${filename} (${seq})`)
    }
  }
  return labels
}
