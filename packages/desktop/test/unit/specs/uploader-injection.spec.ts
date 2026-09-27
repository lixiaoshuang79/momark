import { describe, expect, it, beforeEach, vi } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'

// A-10 (uploader command injection): the picgo call used `exec(`${cmd} u "${path}"`)`,
// so an image path containing a quote / `$( )` / backticks ran shell code, and
// `cliScript` — the program the main process executes — came from the renderer.
// These tests pin both: argv-style execFile, and settings read from the
// main-process store.
const state = vi.hoisted(() => ({
  dir: '',
  execFile: vi.fn(),
  ipcHandle: vi.fn()
}))

vi.mock('electron', async () => {
  const nodeOs = await import('os')
  const nodeFs = await import('fs')
  const nodePath = await import('path')
  state.dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'momark-uploader-test-'))
  nodeFs.writeFileSync(
    nodePath.join(state.dir, 'dataCenter.json'),
    JSON.stringify({ currentUploader: 'picgo', cliScript: '/usr/local/bin/upload.sh' })
  )
  return { app: { getPath: () => state.dir }, ipcMain: { handle: state.ipcHandle } }
})

vi.mock('child_process', () => {
  const mocked = { exec: vi.fn(), execFile: state.execFile }
  return { ...mocked, default: mocked }
})

vi.mock('command-exists', () => ({ default: { sync: () => true } }))

const { registerUploaderHandlers } = await import('main_renderer/ipc/uploader')

type Handler = (event: unknown, req: unknown) => Promise<unknown>

const handler = (): Handler => {
  registerUploaderHandlers()
  const call = state.ipcHandle.mock.calls.find(([channel]) => channel === 'mt::uploader::upload')
  expect(call).toBeTruthy()
  return call![1] as Handler
}

// `isImageFile` also stats the path, so the "image" must exist on disk.
let imageDir = ''
const makeImage = (name: string): string => {
  fs.writeFileSync(path.join(imageDir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return name
}

// Reports a successful upload like picgo would, so the callbacks fire.
const replyWithUrl = () =>
  state.execFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: unknown, out: string, err: string) => void
    ) => cb(null, JSON.stringify({ success: true, imgUrl: 'https://cdn.example/x.png' }), '')
  )

beforeEach(() => {
  state.execFile.mockReset()
  state.ipcHandle.mockReset()
  imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momark-uploader-img-'))
  replyWithUrl()
})

const writeDataCenter = (data: Record<string, unknown>) => {
  fs.writeFileSync(path.join(state.dir, 'dataCenter.json'), JSON.stringify(data))
}

describe('uploader IPC — no shell interpolation (A-10)', () => {
  it('passes a hostile image path as a single argv element', async () => {
    writeDataCenter({ currentUploader: 'picgo', cliScript: '' })
    const hostile = makeImage('shot"$(touch pwned)`id`.png')
    const upload = handler()

    await upload(null, {
      pathname: path.join(imageDir, 'doc.md'),
      image: hostile,
      isPath: true,
      preferences: { currentUploader: 'picgo', cliScript: '' }
    })

    expect(state.execFile).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = state.execFile.mock.calls[0]
    expect(cmd).toBe('picgo')
    expect(args).toEqual(['u', path.resolve(imageDir, hostile)])
    expect(opts.timeout).toBeGreaterThan(0)
    // Nothing may reach a shell: the image path is never concatenated into a
    // command string (the old code produced `picgo u "<path>"`).
    const serialized = JSON.stringify(state.execFile.mock.calls[0])
    expect(serialized).not.toContain('u \\"')
    expect(serialized).not.toContain('u "')
  })
})

describe('uploader IPC — settings come from the main store (A-10)', () => {
  it('ignores a renderer-supplied cliScript while the store selects picgo', async () => {
    writeDataCenter({ currentUploader: 'picgo', cliScript: '/usr/local/bin/upload.sh' })
    const image = makeImage('pic.png')
    const upload = handler()

    await upload(null, {
      pathname: path.join(imageDir, 'doc.md'),
      image,
      isPath: true,
      preferences: { currentUploader: 'cliScript', cliScript: '/tmp/evil.sh' }
    })

    expect(state.execFile).toHaveBeenCalledTimes(1)
    expect(state.execFile.mock.calls[0][0]).toBe('picgo')
    expect(JSON.stringify(state.execFile.mock.calls[0])).not.toContain('evil.sh')
  })

  it('runs the stored script path, not the renderer one', async () => {
    writeDataCenter({ currentUploader: 'cliScript', cliScript: '/usr/local/bin/upload.sh' })
    const image = makeImage('pic.png')
    const upload = handler()

    await upload(null, {
      pathname: path.join(imageDir, 'doc.md'),
      image,
      isPath: true,
      preferences: { currentUploader: 'cliScript', cliScript: '/tmp/evil.sh' }
    })

    expect(state.execFile.mock.calls[0][0]).toBe('/usr/local/bin/upload.sh')
  })

  it('refuses the CLI uploader when no script is configured', async () => {
    writeDataCenter({ currentUploader: 'cliScript' })
    const image = makeImage('pic.png')
    const upload = handler()

    await expect(
      upload(null, {
        pathname: path.join(imageDir, 'doc.md'),
        image,
        isPath: true,
        preferences: { currentUploader: 'cliScript', cliScript: '/tmp/evil.sh' }
      })
    ).rejects.toThrow(/not configured/)
  })
})

describe('uploader IPC — temp files (A-10)', () => {
  it('gives every buffered upload its own private directory', async () => {
    writeDataCenter({ currentUploader: 'picgo', cliScript: '' })
    const upload = handler()
    const payload = {
      pathname: path.join(imageDir, 'doc.md'),
      image: { data: [1, 2, 3], name: 'pasted.png' },
      isPath: false,
      preferences: { currentUploader: 'picgo', cliScript: '' }
    }

    await Promise.all([upload(null, payload), upload(null, payload)])

    const [first, second] = state.execFile.mock.calls.map((call) => (call[1] as string[])[1])
    expect(first).not.toBe(second)
    for (const file of [first, second]) {
      expect(file.endsWith('image.png')).toBe(true)
      // The directory is the mkdtemp one, removed again after the upload.
      expect(fs.existsSync(path.dirname(file))).toBe(false)
    }
  })
})
