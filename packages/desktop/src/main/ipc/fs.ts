import fs from 'fs-extra'
import { statSync, constants, type Stats } from 'fs'
import { isFile as commonIsFile, isDirectory as commonIsDirectory } from 'common/filesystem'
import log from 'electron-log'

import { checkWritePaths, trustedHandle } from './guard'

interface SerializedStat {
  size: number
  mtimeMs: number
  ctimeMs: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

const serializeStat = (stats: Stats): SerializedStat => ({
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
  isFile: stats.isFile(),
  isDirectory: stats.isDirectory(),
  isSymbolicLink: stats.isSymbolicLink()
})

const toBuffer = (data: unknown): unknown => {
  if (data == null) return data
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (typeof data === 'string') return data
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: string }).type === 'Buffer' &&
    Array.isArray((data as { data?: unknown }).data)
  ) {
    return Buffer.from((data as { data: number[] }).data)
  }
  return data
}

/**
 * A-12 ④：写类通道先过路径护栏（持久化目录 / 凭据目录 / 应用自身）。
 * 被拒时抛错——渲染层的调用方都是自家代码，正常路径不会命中这里。
 */
const refuseIfDenied = (channel: string, ...targets: unknown[]): void => {
  const denied = checkWritePaths(...targets)
  if (denied !== null) {
    log.warn(`[ipc] refused ${channel} on protected path:`, denied)
    throw new Error(`blocked: refusing to write to a protected path (${denied})`)
  }
}

// 全部通道都加来源校验（trustedHandle）；写类通道再加路径护栏。
export const registerFsHandlers = (): void => {
  trustedHandle('mt::fs::is-file', (_e, p: string) => commonIsFile(p))
  trustedHandle('mt::fs::is-directory', (_e, p: string) => commonIsDirectory(p))
  trustedHandle('mt::fs::empty-dir', (_e, p: string) => {
    refuseIfDenied('mt::fs::empty-dir', p)
    return fs.emptyDir(p)
  })
  trustedHandle('mt::fs::copy', (_e, src: string, dest: string) => {
    refuseIfDenied('mt::fs::copy', dest)
    return fs.copy(src, dest)
  })
  trustedHandle('mt::fs::ensure-dir', (_e, p: string) => {
    refuseIfDenied('mt::fs::ensure-dir', p)
    return fs.ensureDir(p)
  })

  trustedHandle('mt::fs::output-file', (_e, p: string, data: unknown) => {
    refuseIfDenied('mt::fs::output-file', p)
    return fs.outputFile(p, toBuffer(data) as string | NodeJS.ArrayBufferView)
  })
  trustedHandle('mt::fs::move', (_e, src: string, dest: string) => {
    // 移动既动源也动目标：两边都过护栏（把文件搬进 LaunchAgents 同样是持久化）。
    refuseIfDenied('mt::fs::move', src, dest)
    return fs.move(src, dest, { overwrite: false })
  })
  trustedHandle('mt::fs::stat', async (_e, p: string) => serializeStat(await fs.stat(p)))

  trustedHandle('mt::fs::write-file', (_e, p: string, data: unknown) => {
    refuseIfDenied('mt::fs::write-file', p)
    return fs.writeFile(p, toBuffer(data) as string | NodeJS.ArrayBufferView)
  })
  trustedHandle('mt::fs::read-file', async (_e, p: string, encoding?: BufferEncoding) => {
    const buf = await fs.readFile(p, encoding)
    return buf
  })
  trustedHandle('mt::fs::path-exists', (_e, p: string) => fs.pathExists(p))
  trustedHandle('mt::fs::unlink', (_e, p: string) => {
    refuseIfDenied('mt::fs::unlink', p)
    return fs.unlink(p)
  })
  trustedHandle('mt::fs::readdir', (_e, p: string) => fs.readdir(p))
  trustedHandle('mt::fs::is-executable', (_e, p: string) => {
    try {
      const stat = statSync(p)
      if (process.platform === 'win32') return stat.isFile()
      return (
        stat.isFile() &&
        (stat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) !== 0
      )
    } catch {
      return false
    }
  })
}
