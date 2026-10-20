import { spawn } from 'node:child_process'
import type { GitResult } from '@shared/types'

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult
  ) {
    super((result.stderr || result.stdout).trim() || `git ${args[0]} failed with code ${result.code}`)
    this.name = 'GitError'
  }
}

export interface RunOptions {
  cwd: string
  input?: string
  env?: Record<string, string>
  /** Resolve even on non-zero exit instead of throwing */
  allowFailure?: boolean
  signal?: AbortSignal
  /** Receives stderr chunks as they arrive (progress for fetch/push/clone) */
  onProgress?: (text: string) => void
}

let gitBinary = 'git'
let defaultEnv: Record<string, string> = {}
let defaultArgs: () => string[] = () => []

export function setGitBinary(path: string): void {
  gitBinary = path || 'git'
}

/** Environment and leading `-c` arguments applied to every git process (authentication). */
export function setGitDefaults(env: Record<string, string>, args: () => string[]): void {
  defaultEnv = env
  defaultArgs = args
}

/**
 * Runs git with an argv array. Never goes through a shell, so arguments need no quoting.
 * `-c core.quotepath=false` keeps non-ASCII paths readable in diff headers.
 */
export function runGit(args: string[], opts: RunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...defaultArgs(), ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // git must never wait on a terminal; questions go through GIT_ASKPASS instead.
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        ...defaultEnv,
        ...opts.env
      },
      windowsHide: true,
      signal: opts.signal
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => {
      err.push(d)
      opts.onProgress?.(d.toString('utf8'))
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const result: GitResult = {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? -1
      }
      if (result.code !== 0 && !opts.allowFailure) reject(new GitError(args, result))
      else resolve(result)
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}
