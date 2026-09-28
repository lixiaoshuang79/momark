/**
 * 本地图片自定义协议（A-12：恢复 `webSecurity` + 取消 `file://` 直载）。
 *
 * 背景（实测矩阵见 `2026-09-28/momark-annotation-impl/p4-websecurity-probe/`）：
 * 关掉 `webSecurity` 关的是同源策略。一旦打开，渲染层就不能再直接引用 `file://`
 * 本地图片：
 *   - dev 形态（应用页 `http://localhost:5173`）→ 一律「Not allowed to load local
 *     resource」；
 *   - 打包形态（应用页 `file://…/out/renderer/index.html`）→ 主文档里的 file://
 *     图片仍能显示，但**沙箱帧**（`sandbox="allow-scripts"` → 不透明源）里的
 *     file:// 图片全部被拒。
 * 改用一个 standard + secure 的自定义协议承载本地图片后，上述三种上下文（含
 * http 页、含不透明源帧）都能加载；同时协议把可读范围钉死在图片扩展名上，
 * 不给「任意文件读取」开口子。
 *
 * URL 形状：`momark-file://local/<绝对路径>`。host 固定为 `local`，真实路径整体
 * 放在 pathname 里；`?`/`#` 之后的部分按原样透传（语义与 `file://` 一致——只影响
 * URL 身份，不影响读到的文件，例如 `img.png?mucache=3`）。
 */

/** 协议名。渲染层以 `momark-file://local/<绝对路径>` 引用本地图片。 */
export const MOMARK_FILE_SCHEME = 'momark-file'

/** URL 里的固定 host：真实路径整体放在 pathname，避免 host 解析歧义。 */
export const MOMARK_FILE_HOST = 'local'

/**
 * 允许经协议读取的扩展名白名单——与 `common/filesystem/paths.ts` 的
 * `IMAGE_EXTENSIONS`、引擎 `utils/image.ts` 的图片扩展名保持一致：协议只服务
 * 图片，不是「任意本地文件读取」通道（否则等于把 `file://` 原样还给渲染层）。
 */
export const MOMARK_FILE_ALLOWED_EXTENSIONS: readonly string[] = Object.freeze([
  'jpeg',
  'jpg',
  'png',
  'gif',
  'svg',
  'webp'
])

/** 扩展名是否在白名单内（不区分大小写；不看文件是否存在）。 */
export const isAllowedMomarkFileExtension = (filePath: string): boolean => {
  if (typeof filePath !== 'string' || !filePath) return false
  // 只看最后一段（basename）：`/a/b.png` 的扩展名是 png，`/a/b.png.js` 是 js。
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // 点号必须在 basename 中间（`a.png` ✔ / 整名就是扩展名的 `.png` ✘ / 无扩展名 ✘）。
  if (dot <= 0 || dot === base.length - 1) return false
  // query/fragment 正常已被 URL 语义切掉，这里再防御性裁一次。
  const ext = base
    .slice(dot + 1)
    .toLowerCase()
    .split(/[?#]/)[0]
  return MOMARK_FILE_ALLOWED_EXTENSIONS.includes(ext)
}

/**
 * 绝对路径 → 协议 URL。与引擎侧 `muya/src/utils/image.ts#localPathToMomarkUrl`
 * 是同一格式的两个实现（互相不能 import：引擎包不依赖桌面侧的 shared），
 * 两侧各有一组单测钉住格式，改一边就会有两边红。
 */
export const pathToMomarkFileUrl = (filePath: string): string => {
  const normalized = String(filePath ?? '').replace(/\\/g, '/')
  // `?`/`#` 之后按原样透传（与 file:// 的 query/fragment 语义一致）。
  const cut = normalized.search(/[?#]/)
  const pathPart = cut === -1 ? normalized : normalized.slice(0, cut)
  const tail = cut === -1 ? '' : normalized.slice(cut)
  const encoded = pathPart
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  // 盘符路径（`C:/…`）编码后不以 `/` 开头，要自己补一个，否则会和 host 粘在一起。
  const pathname = encoded.startsWith('/') ? encoded : `/${encoded}`
  return `${MOMARK_FILE_SCHEME}://${MOMARK_FILE_HOST}${pathname}${tail}`
}

/**
 * 协议 URL → 绝对路径。只认固定 host，解不出来就返回 null（调用方一律拒绝）。
 * 返回的路径可能仍是不存在的文件——存在性由调用方（协议处理器）去读。
 */
export const momarkFileUrlToPath = (url: string): string | null => {
  if (typeof url !== 'string' || !url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MOMARK_FILE_SCHEME}:`) return null
  if (parsed.hostname !== MOMARK_FILE_HOST) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  // Windows 盘符路径在 URL 里是 `/C:/…`，解析回来时要摘掉那个为语法补的前导斜杠。
  if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) decoded = decoded.slice(1)
  if (decoded.includes('\0')) return null
  if (!decoded) return null
  return decoded
}
