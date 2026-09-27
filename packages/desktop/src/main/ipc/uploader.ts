import path from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import fs from 'fs-extra'
import { app, ipcMain } from 'electron'
import log from 'electron-log'
import commandExists from 'command-exists'
import { isImageFile } from 'common/filesystem/paths'

// Uploader settings are read from the main-process store, never from the IPC
// payload (see `readUploaderSettings`): the renderer could otherwise name an
// arbitrary program to run.
const DATA_CENTER_FILE = 'dataCenter.json'

// Cap how long a hung uploader can block the request (the child is killed).
const UPLOAD_TIMEOUT_MS = 120_000

const buildPreferredPathEnv = (): string => {
  const extras =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
      : process.platform === 'linux'
        ? ['/usr/local/bin', '/usr/bin', '/bin']
        : []
  const cur = (process.env.PATH || '').split(path.delimiter)
  const merged = [...cur]
  for (const p of extras) if (p && !merged.includes(p)) merged.push(p)
  return merged.filter(Boolean).join(path.delimiter)
}

const resolvePicgoBinary = (): string | null => {
  const candidates =
    process.platform === 'win32'
      ? ['picgo', 'picgo.exe']
      : [
          'picgo',
          '/opt/homebrew/bin/picgo',
          '/usr/local/bin/picgo',
          '/usr/bin/picgo',
          `${process.env.HOME}/.npm-global/bin/picgo`,
          `${process.env.HOME}/.npm/bin/picgo`,
          `${process.env.HOME}/.local/bin/picgo`,
          '/usr/local/lib/node_modules/.bin/picgo'
        ]
  for (const c of candidates) {
    try {
      if (commandExists.sync(c)) return c
      if (c.startsWith('/') && fs.pathExistsSync(c)) return c
    } catch {
      /* not found */
    }
  }
  return null
}

// Strip ANSI SGR color codes (CSI parameter ... 'm') from picgo output before
// trying to parse it. \x1b is the ESC byte.
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g // eslint-disable-line no-control-regex

const parsePicgoOutput = (text: unknown): string | null => {
  const raw = String(text || '')
  const cleaned = raw.replace(ANSI_SGR_RE, '')
  try {
    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    for (const line of lines) {
      if (
        (line.startsWith('{') && line.endsWith('}')) ||
        (line.startsWith('[') && line.endsWith(']'))
      ) {
        try {
          const obj = JSON.parse(line)
          if (obj) {
            if (obj.success === true && typeof obj.imgUrl === 'string') return obj.imgUrl
            if (obj.success === true && Array.isArray(obj.result) && obj.result.length > 0) {
              return String(obj.result[obj.result.length - 1])
            }
            if (obj.success === true && typeof obj.url === 'string') return obj.url
          }
        } catch {
          /* not JSON */
        }
      }
      const kv = line.match(/(?:success|succeeded|uploaded)\s*:?\s*(https?:\/\/\S+)/i)
      if (kv && kv[1]) return kv[1]
    }
  } catch {
    /* outer parse failed */
  }
  const marker = cleaned.split('[PicGo SUCCESS]:')
  if (marker.length >= 2) {
    const candidate = marker[marker.length - 1].trim()
    if (/^https?:\/\//i.test(candidate)) return candidate
  }
  return null
}

const uploadByPicgo = (localPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const cmd = resolvePicgoBinary()
    if (!cmd) return reject(new Error('PicGo command not found in PATH'))
    // execFile (argv array, no shell): the image path may contain quotes, `$()`
    // or backticks — as an argument of a shell command those would execute.
    execFile(
      cmd,
      ['u', localPath],
      { env: { ...process.env, PATH: buildPreferredPathEnv() }, timeout: UPLOAD_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) return reject(err)
        const text = String(stdout || '') + (stderr ? `\n${String(stderr)}` : '')
        const url = parsePicgoOutput(text)
        if (url) resolve(url)
        else reject(new Error(`PicGo upload error: cannot parse output\n${text.slice(0, 400)}`))
      }
    )
  })

const uploadByCli = (cliScript: string, localPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      cliScript,
      [localPath],
      { env: { ...process.env, PATH: buildPreferredPathEnv() }, timeout: UPLOAD_TIMEOUT_MS },
      (err, data) => {
        if (err) return reject(err)
        resolve(String(data || '').trim())
      }
    )
  })

// Only the extension is reused from the renderer's file name — anything else
// (path separators, quotes, a second "extension") is dropped.
const safeSuffix = (name: string): string => {
  const ext = path.extname(name || '')
  return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext : ''
}

const writeBinaryToTmp = async (
  data: Uint8Array | number[] | null | undefined,
  name: string = ''
): Promise<{ file: string; dir: string }> => {
  const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data || [])
  // mkdtemp: a private (0700) directory per upload, so two uploads can never
  // collide on a shared Date.now() name.
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'momark-upload-'))
  const file = path.join(dir, `image${safeSuffix(name)}`)
  await fs.writeFile(file, buf)
  return { file, dir }
}

interface UploaderSettings {
  currentUploader: string
  cliScript: string
}

/**
 * Uploader settings as stored by the main process (`dataCenter.json`: the
 * settings page persists `currentUploader`/`cliScript` through
 * `mt::set-user-data`). Returns null when the store cannot be read, in which
 * case the caller falls back to the renderer's selector but never to a
 * renderer-provided script path.
 */
const readUploaderSettings = (): UploaderSettings | null => {
  try {
    const file = path.join(app.getPath('userData'), DATA_CENTER_FILE)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      currentUploader:
        typeof parsed.currentUploader === 'string' ? parsed.currentUploader : 'picgo',
      cliScript: typeof parsed.cliScript === 'string' ? parsed.cliScript : ''
    }
  } catch (error) {
    log.warn('[uploader] cannot read uploader settings from the main store:', error)
    return null
  }
}

/**
 * The settings an upload runs with. The main-process store is authoritative:
 * a script path coming from the renderer would let any renderer code name an
 * executable for the main process to run.
 */
const resolveUploaderSettings = (fromRenderer: unknown): UploaderSettings => {
  const stored = readUploaderSettings()
  if (stored) return stored
  const selector = (fromRenderer as { currentUploader?: unknown } | null | undefined)
    ?.currentUploader
  return {
    currentUploader: typeof selector === 'string' ? selector : 'picgo',
    cliScript: ''
  }
}

const uploadFromPath = async (imagePath: string, options: UploaderSettings): Promise<string> => {
  const { currentUploader, cliScript } = options
  if (currentUploader === 'picgo') return uploadByPicgo(imagePath)
  if (currentUploader === 'cliScript') return uploadByCli(requireCliScript(cliScript), imagePath)
  throw new Error(`Unsupported uploader: ${currentUploader}`)
}

const requireCliScript = (cliScript: string): string => {
  if (!cliScript) {
    throw new Error(
      'CLI script uploader is not configured — set the script path in Preferences → Image → Uploader.'
    )
  }
  return cliScript
}

interface BufferImagePayload {
  data: Uint8Array | number[]
  name: string
}

const uploadFromBuffer = async (
  { data, name }: BufferImagePayload,
  options: UploaderSettings
): Promise<string> => {
  const { currentUploader, cliScript } = options
  const { file: localPath, dir: tmpDir } = await writeBinaryToTmp(data, name)
  const cleanup = () =>
    fs.remove(tmpDir).catch(() => {
      /* ignore */
    })
  try {
    if (currentUploader === 'picgo') return await uploadByPicgo(localPath)
    if (currentUploader === 'cliScript') {
      return await uploadByCli(requireCliScript(cliScript), localPath)
    }
    throw new Error(`Unsupported uploader: ${currentUploader}`)
  } finally {
    await cleanup()
  }
}

interface UploadRequest {
  pathname: string
  image: string | BufferImagePayload
  isPath: boolean
  // Kept for wire compatibility; only `currentUploader` is ever honoured, and
  // only when the main-process store is unreadable. `cliScript` is ignored.
  preferences?: { currentUploader?: string; cliScript?: string }
}

export const registerUploaderHandlers = (): void => {
  ipcMain.handle('mt::uploader::upload', async (_event, req: UploadRequest) => {
    const { pathname, image, isPath, preferences } = req
    const settings = resolveUploaderSettings(preferences)
    if (isPath) {
      const dir = path.dirname(pathname)
      const imagePath = path.resolve(dir, image as string)
      const isImg = isImageFile(imagePath)
      if (!isImg) return image
      return uploadFromPath(imagePath, settings)
    }
    return uploadFromBuffer(image as BufferImagePayload, settings)
  })
}
