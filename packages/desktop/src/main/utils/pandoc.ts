// Copy from https://github.com/utatti/simple-pandoc/blob/master/index.js
import { spawn } from 'child_process'
import type { Readable } from 'stream'
import commandExists from 'command-exists'
import { isFile2 } from 'common/filesystem'

const pandocCommand = 'pandoc'

const getCommand = (): string => {
  if (envPathExists()) {
    return process.env.MARKTEXT_PANDOC as string
  }
  return pandocCommand
}

interface PandocConverter {
  (): Promise<string>
  stream: (srcStream: NodeJS.ReadableStream) => Readable | null
}

interface PandocFileConversion {
  promise: Promise<void>
  /** Aborts the underlying pandoc process. */
  cancel: () => void
}

interface PandocFn {
  (from: string, to: string, ...args: string[]): PandocConverter
  exists: () => boolean
  toFile: (
    from: string,
    to: string,
    src: string,
    destPath: string,
    cwd: string,
    ...args: string[]
  ) => PandocFileConversion
}

const pandoc = ((from: string, to: string, ...args: string[]): PandocConverter => {
  const command = getCommand()
  const option = ['-s', from, '-t', to].concat(args)

  const converter = ((): Promise<string> =>
    new Promise((resolve, reject) => {
      const proc = spawn(command, option)
      proc.on('error', reject)
      let data = ''
      proc.stdout.on('data', (chunk: Buffer | string) => {
        data += chunk.toString()
      })
      proc.stdout.on('end', () => resolve(data))
      proc.stdout.on('error', reject)
      proc.stdin.end()
    })) as PandocConverter

  converter.stream = (srcStream: NodeJS.ReadableStream): Readable | null => {
    const proc = spawn(command, option)
    srcStream.pipe(proc.stdin)
    return proc.stdout
  }

  return converter
}) as PandocFn

pandoc.exists = (): boolean => {
  if (envPathExists()) {
    return true
  }
  return commandExists.sync(pandocCommand)
}

pandoc.toFile = (
  from: string,
  to: string,
  src: string,
  destPath: string,
  cwd: string,
  ...args: string[]
): PandocFileConversion => {
  // Markdown → 文件（docx 等二进制格式）。cwd 设为源文档目录，
  // 相对路径图片/资源即可解析；`-o` 直接流式落盘。
  const command = getCommand()
  const option = ['-f', from, '-t', to, '-o', destPath].concat(args)
  const proc = spawn(command, option, { cwd: cwd || process.cwd() })

  const promise = new Promise<void>((resolve, reject) => {
    let settled = false
    proc.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`pandoc exited with code ${String(code)}`))
      }
    })
  })

  proc.stdin.on('error', () => {
    // EPIPE when the process is killed — handled via the close event.
  })
  proc.stdin.end(src)

  return {
    promise,
    cancel: () => {
      if (!proc.killed) {
        proc.kill()
      }
    }
  }
}

const envPathExists = (): boolean => {
  return !!process.env.MARKTEXT_PANDOC && isFile2(process.env.MARKTEXT_PANDOC)
}

export default pandoc
