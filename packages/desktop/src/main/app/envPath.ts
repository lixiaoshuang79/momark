import os from 'os'
import path from 'path'

// GUI-launched apps on macOS/Linux don't inherit the user's login-shell PATH,
// so Homebrew (/opt/homebrew/bin, /usr/local/bin) and standard bin dirs are
// absent and CLI tools like pandoc can't be found (#2751). These mirror the
// picgo uploader's PATH handling (ipc/uploader.ts).
//
// `~/.local/bin` / `~/bin` are in the list because CLI uploaders and other
// helpers are routinely installed there per-user (pip/pipx, npm prefix,
// single-binary downloads) — picgo on this machine lives at
// `~/.local/bin/picgo`, and without the entry the uploader cannot find it,
// silently falls back to the local path and the document never gets an
// uploaded URL.
const home = os.homedir()
const USER_BIN_DIRS = [path.join(home, '.local', 'bin'), path.join(home, 'bin')]

const EXTRA_PATH_DIRS: Record<string, string[]> = {
  darwin: [
    ...USER_BIN_DIRS,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/Library/TeX/texbin'
  ],
  linux: [...USER_BIN_DIRS, '/usr/local/bin', '/usr/bin', '/bin']
}

export const patchEnvPath = (): void => {
  const extras = EXTRA_PATH_DIRS[process.platform]
  if (!extras) return

  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of extras) {
    if (!current.includes(dir)) current.push(dir)
  }
  process.env.PATH = current.join(path.delimiter)
}
