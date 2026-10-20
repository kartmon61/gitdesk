import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'

/** Common install locations for git, git-lfs, gpg and ssh helpers outside the system PATH. */
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']

/**
 * Apps started from Finder or a Linux desktop launcher inherit a minimal PATH
 * (/usr/bin:/bin:...), so Homebrew git, git-lfs and gpg are not found.
 * Read the PATH the user's login shell would set and merge it into process.env.
 */
export async function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const fromShell = await loginShellPath()
  const merged = [...new Set([...fromShell, ...current, ...FALLBACK_DIRS])]
  process.env.PATH = merged.join(delimiter)
}

function loginShellPath(): Promise<string[]> {
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__GITDESK_PATH__'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (err, stdout) => {
        // Profiles may print banners; only the text between the markers is the PATH.
        const m = !err && new RegExp(`${marker}(.*)${marker}`).exec(stdout)
        resolve(m ? m[1].split(delimiter).filter(Boolean) : [])
      }
    )
  })
}
