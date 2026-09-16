/**
 * 把「粘贴进来的 html 文件」内联成可整体写进 .md 的一段 HTML。
 *
 * 目标：转换后 .md 是**单文件可带走**的 —— 别人只拿到这个 .md、断网打开也能看到
 * 完整效果。所以同目录的 CSS / JS / 图片都要读进正文里：样式塞进 `<style>`、脚本
 * 塞进 `<script>`、图片转 base64 data URI。远程 http(s) 资源、data: 资源、锚点保持
 * 原样（它们不依赖本地文件）。
 *
 * 返回结构里同时给出 `inlined` / `missed`，让调用方可以如实告知用户「哪些资源没内联
 * 上」（读不到的文件不静默吞掉）。
 */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

const extname = (p: string): string => {
  const base = p.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot).toLowerCase()
}

/** 目录部分（保留原分隔符风格，Windows 路径也能拼回去）。 */
const dirname = (p: string): string => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? '' : p.slice(0, i)
}

const joinPath = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel)

/** 绝对路径（/x、C:\x）或带协议的 URL 都直接使用，其余按相对路径拼到 html 所在目录。 */
const toLocalPath = (dir: string, src: string): string =>
  /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|[a-zA-Z]:[/\\])/i.test(src) ? src : joinPath(dir, src)

/** 去掉 query / hash 并按 URL 规则解码，得到真实文件系统路径。 */
const toFilePath = (src: string): string => {
  const clean = src.split('#')[0].split('?')[0]
  try {
    return decodeURIComponent(clean)
  } catch {
    return clean
  }
}

const isExternal = (src: string): boolean => !src || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)

const readText = async (p: string): Promise<string> =>
  String(await window.fileUtils.readFile(p, 'utf8'))

const readDataUrl = async (p: string): Promise<string> => {
  const mime = MIME_BY_EXT[extname(p)] ?? 'application/octet-stream'
  const base64 = String(await window.fileUtils.readFile(p, 'base64'))
  return `data:${mime};base64,${base64}`
}

export interface IInlineHtmlResult {
  /** 内联后的完整 HTML 文档（末尾已去掉空行，写进 .md 后重新解析不会断开块）。 */
  html: string
  /** 成功内联的资源（文件名），用于如实回报。 */
  inlined: string[]
  /** 没内联上的资源（本地但读不到，或结构太复杂无法安全处理的）。 */
  missed: string[]
}

/**
 * 内联一个本地 html 文件里的资源。
 *
 * @param raw  html 文件原文
 * @param filePath 该 html 文件在磁盘上的绝对路径（用来解析相对资源）
 */
export async function inlineHtmlDocument(
  raw: string,
  filePath: string
): Promise<IInlineHtmlResult> {
  const dir = dirname(filePath)
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  const inlined: string[] = []
  const missed: string[] = []

  const resolve = async (
    src: string
  ): Promise<{ path: string; dataUrl?: string; text?: string } | null> => {
    const path = toLocalPath(dir, toFilePath(src))
    try {
      const exists = await window.fileUtils.pathExists(path)
      if (!exists) {
        missed.push(path)
        return null
      }
      return { path }
    } catch {
      missed.push(path)
      return null
    }
  }

  // <link rel="stylesheet" href="本地.css"> -> <style>…</style>
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = link.getAttribute('href') ?? ''
    if (isExternal(href)) continue

    const target = await resolve(href)
    if (!target) continue

    try {
      const css = await readText(target.path)
      const style = doc.createElement('style')
      style.textContent = css
      link.replaceWith(style)
      inlined.push(target.path)

      // 内联后的样式表里若还有 url(...) 引用本地图片，一并换成 data URI。
      const urls = Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g))
      for (const match of urls) {
        const ref = match[2]
        if (!ref || isExternal(ref) || ref.startsWith('data:')) continue

        const asset = await resolve(toLocalPath(dirname(target.path), toFilePath(ref)))
        if (!asset) continue

        try {
          const dataUrl = await readDataUrl(asset.path)
          style.textContent = (style.textContent ?? '').replace(match[0], `url("${dataUrl}")`)
          inlined.push(asset.path)
        } catch {
          missed.push(asset.path)
        }
      }
    } catch {
      missed.push(target.path)
    }
  }

  // <script src="本地.js"> -> <script>…</script>（保留 type，模块脚本语义不变）
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const src = script.getAttribute('src') ?? ''
    if (isExternal(src)) continue

    const target = await resolve(src)
    if (!target) continue

    try {
      script.removeAttribute('src')
      script.textContent = await readText(target.path)
      inlined.push(target.path)
    } catch {
      missed.push(target.path)
    }
  }

  // <img src="本地图片"> -> data URI
  for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? ''
    if (isExternal(src)) continue

    const target = await resolve(src)
    if (!target) continue

    try {
      img.setAttribute('src', await readDataUrl(target.path))
      inlined.push(target.path)
    } catch {
      missed.push(target.path)
    }
  }

  return {
    // 两处刻意的规范化：
    // ① 去掉 `<!DOCTYPE …>`：CommonMark 的声明型 html 块在第一个 `>` 处就结束，带 doctype
    //    的整篇文档写回 .md 后会被拆成两个块，重开时脚本块只剩半页。渲染时沙箱帧（引导页
    //    自带 doctype）和静态 div 都不依赖它，所以去掉了没有任何损失（单测
    //    `insertHtmlBlock.spec.ts` 里钉住了这条拆分行为）。
    // ② 压掉块内空行：空行会终止 html 块，同样会把一个块切成两个（HTML 语义不受影响）。
    html: doc.documentElement.outerHTML.replace(/\n\s*\n/g, '\n').trim(),
    inlined: Array.from(new Set(inlined)),
    missed: Array.from(new Set(missed))
  }
}
