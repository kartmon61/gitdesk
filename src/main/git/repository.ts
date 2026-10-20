import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BlameLine,
  Branch,
  ChangedFile,
  Commit,
  CommitDetail,
  ConflictVersions,
  FileDiff,
  GitResult,
  HeadSnapshot,
  Operation,
  RebaseTodoItem,
  ReflogEntry,
  Ref,
  Remote,
  RepoState,
  Stash,
  Submodule,
  Tag,
  UndoEntry,
  Worktree
} from '@shared/types'
import type { MergeMode, PullMode, RepoApi, ResetMode } from '@shared/api'
import { runGit, type RunOptions } from './exec'
import {
  BRANCH_FORMAT,
  FS,
  LOG_FORMAT,
  REF_FORMAT,
  TAG_FORMAT,
  applyNumstat,
  buildPartialPatch,
  parseBlame,
  parseBranches,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseReflog,
  parseRefs,
  parseStashes,
  parseStatus,
  parseSubmodules,
  parseTags,
  parseWorktrees,
  splitArgs
} from './parse'

type Extra = Omit<RunOptions, 'cwd'>

/** Git editor that accepts the default message without opening anything. */
const NO_EDITOR = { GIT_EDITOR: ':' }

/** Converts a native path to the form git's sh understands on Windows. */
function shPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, `'\\''`)
}

/** Pseudo-revision meaning the working tree in compare/rangeFileDiff. */
const WORKDIR = 'WORKDIR'

export class Repository implements RepoApi {
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []

  constructor(readonly path: string) {}

  git(args: string[], extra: Extra = {}): Promise<GitResult> {
    return runGit(args, { cwd: this.path, ...extra })
  }

  private async out(args: string[], extra: Extra = {}): Promise<string> {
    return (await this.git(args, extra)).stdout
  }

  // ---------------------------------------------------------------- repository

  static async init(path: string, bare = false): Promise<void> {
    await fs.mkdir(path, { recursive: true })
    await runGit(['init', ...(bare ? ['--bare'] : [])], { cwd: path })
  }

  static async clone(url: string, dir: string, onProgress?: (t: string) => void, signal?: AbortSignal): Promise<void> {
    await runGit(['clone', '--progress', '--', url, dir], { cwd: tmpdir(), onProgress, signal })
  }

  static async isRepository(path: string): Promise<boolean> {
    if (!existsSync(path)) return false
    const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: path, allowFailure: true })
    return r.code === 0 && r.stdout.trim() === 'true'
  }

  /** Returns the top-level directory containing `path`. */
  static async topLevel(path: string): Promise<string> {
    return (await runGit(['rev-parse', '--show-toplevel'], { cwd: path })).stdout.trim()
  }

  async gitDir(): Promise<string> {
    return (await this.out(['rev-parse', '--absolute-git-dir'])).trim()
  }

  async state(): Promise<RepoState> {
    const [statusOut, gitDir] = await Promise.all([
      this.out(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.gitDir()
    ])
    const { branch, entries } = parseStatus(statusOut)
    const state: RepoState = {
      path: this.path,
      gitDir,
      head: branch.head,
      branch: branch.branch,
      detached: !branch.branch,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      status: entries
    }
    const op = this.detectOperation(gitDir)
    if (op) state.operation = op
    if (op === 'rebase') state.rebaseStep = await this.rebaseStep(gitDir)
    return state
  }

  private detectOperation(gitDir: string): Operation | undefined {
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase'
    if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
    if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert'
    if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect'
    return undefined
  }

  private async rebaseStep(gitDir: string): Promise<{ current: number; total: number } | undefined> {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const read = async (a: string, b: string): Promise<number | undefined> => {
        for (const name of [a, b]) {
          try {
            return Number((await fs.readFile(join(gitDir, dir, name), 'utf8')).trim())
          } catch {
            /* try next */
          }
        }
        return undefined
      }
      const current = await read('msgnum', 'next')
      const total = await read('end', 'last')
      if (current !== undefined && total !== undefined) return { current, total }
    }
    return undefined
  }

  async getConfig(key: string): Promise<string> {
    return (await this.git(['config', '--get', key], { allowFailure: true })).stdout.trim()
  }

  async setConfig(key: string, value: string, scope: 'local' | 'global' = 'local'): Promise<void> {
    if (value) await this.git(['config', `--${scope}`, key, value])
    else await this.git(['config', `--${scope}`, '--unset', key], { allowFailure: true })
  }

  // ------------------------------------------------------------------- history

  /**
   * Commits reachable from all refs. `filter.include` (soloed refs) limits the graph to those refs;
   * `filter.exclude` (hidden refs) leaves them out, like GitKraken's solo/hide.
   */
  async log(limit = 5000, skip = 0, filter: { include?: string[]; exclude?: string[] } = {}): Promise<Commit[]> {
    const args = ['log', '--date-order', `--format=${LOG_FORMAT}`, `--max-count=${limit}`, `--skip=${skip}`]
    if (filter.include?.length) {
      args.push(...filter.include, 'HEAD')
    } else {
      // --exclude applies only to the next --branches/--remotes/--tags, with patterns relative to
      // that namespace (no refs/heads/ prefix), so emit the matching excludes before each option.
      for (const [opt, prefix] of [['--branches', 'refs/heads/'], ['--remotes', 'refs/remotes/'], ['--tags', 'refs/tags/']]) {
        for (const ref of filter.exclude ?? []) if (ref.startsWith(prefix)) args.push(`--exclude=${ref.slice(prefix.length)}`)
        args.push(opt)
      }
    }
    // HEAD may be detached or unborn; include it only when it resolves.
    const head = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })
    if (head.code === 0) {
      if (!filter.include?.length) args.push('HEAD')
    } else {
      if ((await this.refs()).length === 0) return []
      if (filter.include?.length) args.pop()
    }
    return parseLog(await this.out(args))
  }

  /** Diff of one file between two revisions (used for multi-commit selections). */
  async rangeFileDiff(from: string, to: string, path: string, oldPath?: string, ignoreWhitespace = false, context?: number): Promise<FileDiff | null> {
    const paths = oldPath && oldPath !== path ? [oldPath, path] : [path]
    const range = to === WORKDIR ? [from] : [from, to]
    const ctx = context !== undefined ? [`-U${context}`] : []
    return parseDiff(await this.out(['diff', '-M', ...ctx, ...(ignoreWhitespace ? ['-w'] : []), ...range, '--', ...paths]))[0] ?? null
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true })).code === 0
  }

  /** Restores files to their content in `rev` (working tree and index). */
  async restoreFiles(rev: string, paths: string[]): Promise<void> {
    await this.git(['checkout', rev, '--', ...paths])
  }

  /** Unified patch text of working changes (staged and unstaged against HEAD) for the given paths. */
  async workingPatch(paths: string[] = []): Promise<string> {
    const head = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })
    return this.out(['diff', '--binary', ...(head.code === 0 ? ['HEAD'] : ['--cached']), '--', ...paths])
  }

  async deleteFiles(paths: string[]): Promise<void> {
    for (const p of paths) await fs.rm(join(this.path, p), { recursive: true, force: true })
  }

  /** Moves `branch` forward to `target` without checking it out; fails unless it is a fast-forward. */
  async fastForward(branch: string, target: string): Promise<void> {
    if (!(await this.isAncestor(branch, target))) throw new Error(`${branch} 를 ${target} 로 fast-forward 할 수 없습니다.`)
    const cur = (await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true })).stdout.trim()
    if (cur === branch) await this.recorded(`Fast-forward ${branch}`, 'move-head', 'keep', () => this.git(['merge', '--ff-only', target]))
    else await this.recorded(`Fast-forward ${branch}`, 'refs', undefined, () => this.git(['branch', '-f', branch, target]), [`refs/heads/${branch}`])
  }

  async lockWorktree(path: string, lock: boolean): Promise<void> {
    await this.git(['worktree', lock ? 'lock' : 'unlock', path])
  }

  async refs(): Promise<Ref[]> {
    return parseRefs(await this.out(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']))
  }

  async commitDetail(sha: string): Promise<CommitDetail> {
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%s', '%b'].join('%x00')
    const raw = await this.out(['show', '-s', `--format=${fmt}`, sha])
    const [h, p, an, ae, at, cn, ct, s, ...b] = raw.split(FS)
    const parents = p ? p.split(' ') : []
    return {
      sha: h,
      parents,
      author: an,
      authorEmail: ae,
      authorTime: Number(at),
      committer: cn,
      committerTime: Number(ct),
      subject: s,
      body: b.join(FS).trim(),
      files: await this.commitFiles(sha, parents)
    }
  }

  private async commitFiles(sha: string, parents: string[]): Promise<ChangedFile[]> {
    // Merge commits are shown against their first parent, like GitKraken does.
    const range = parents.length > 1 ? [parents[0], sha] : ['--root', sha]
    const base = ['diff-tree', '-r', '-z', '-M', '--no-commit-id']
    const [names, nums] = await Promise.all([
      this.out([...base, '--name-status', ...range]),
      this.out([...base, '--numstat', ...range])
    ])
    return applyNumstat(parseNameStatus(names), nums)
  }

  async commitFileDiff(sha: string, path: string, oldPath?: string, ignoreWhitespace = false, context?: number): Promise<FileDiff | null> {
    const detail = await this.out(['rev-list', '--parents', '-n', '1', sha])
    const parents = detail.trim().split(' ').slice(1)
    const ws = [...(ignoreWhitespace ? ['-w'] : []), ...(context !== undefined ? [`-U${context}`] : [])]
    const paths = oldPath && oldPath !== path ? [oldPath, path] : [path]
    const args =
      parents.length === 0
        ? ['show', '--format=', '-M', ...ws, sha, '--', ...paths]
        : ['diff', '-M', ...ws, parents[0], sha, '--', ...paths]
    return parseDiff(await this.out(args))[0] ?? null
  }

  /** Files changed between two revisions; `to` may be WORKDIR for the working tree. */
  async compare(from: string, to: string): Promise<ChangedFile[]> {
    const range = to === WORKDIR ? [from] : [from, to]
    const [names, nums] = await Promise.all([
      this.out(['diff', '-z', '-M', '--name-status', ...range]),
      this.out(['diff', '-z', '-M', '--numstat', ...range])
    ])
    return applyNumstat(parseNameStatus(names), nums)
  }

  async fileHistory(path: string, limit = 500): Promise<Commit[]> {
    return parseLog(await this.out(['log', '--follow', `--format=${LOG_FORMAT}`, `--max-count=${limit}`, '--', path]))
  }

  async blame(path: string, rev?: string): Promise<BlameLine[]> {
    return parseBlame(await this.out(['blame', '--porcelain', ...(rev ? [rev] : []), '--', path]))
  }

  async reflog(ref = 'HEAD', limit = 500): Promise<ReflogEntry[]> {
    return parseReflog(await this.out(['reflog', 'show', `--format=%H%x00%gd%x00%ct%x00%gs`, `-n${limit}`, ref], { allowFailure: true }))
  }

  async fileAt(rev: string, path: string): Promise<string | null> {
    const r = await this.git(['show', `${rev}:${path}`], { allowFailure: true })
    return r.code === 0 ? r.stdout : null
  }

  // ------------------------------------------------------------- working tree

  async workingDiff(path: string, staged: boolean, untracked: boolean, ignoreWhitespace = false, context?: number): Promise<FileDiff | null> {
    const ws = [...(ignoreWhitespace ? ['-w'] : []), ...(context !== undefined ? [`-U${context}`] : [])]
    if (untracked) {
      const r = await this.git(['diff', '--no-index', ...ws, '--', '/dev/null', path], { allowFailure: true })
      const d = parseDiff(r.stdout)[0]
      if (d) d.path = path
      return d ?? null
    }
    return parseDiff(await this.out(['diff', ...(staged ? ['--cached'] : []), '-M', ...ws, '--', path]))[0] ?? null
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length) await this.git(['add', '-A', '--', ...paths])
  }

  async stageAll(): Promise<void> {
    await this.git(['add', '-A'])
  }

  async unstage(paths: string[]): Promise<void> {
    if (!paths.length) return
    const hasHead = (await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })).code === 0
    if (hasHead) await this.git(['reset', '-q', 'HEAD', '--', ...paths])
    else await this.git(['rm', '--cached', '-r', '-q', '--', ...paths])
  }

  async unstageAll(): Promise<void> {
    const hasHead = (await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })).code === 0
    if (hasHead) await this.git(['reset', '-q'])
    else await this.git(['rm', '--cached', '-r', '-q', '.'], { allowFailure: true })
  }

  /** Discards worktree changes; untracked files are deleted. */
  async discard(paths: string[], untracked: string[] = []): Promise<void> {
    if (paths.length) await this.git(['checkout', '--', ...paths])
    if (untracked.length) await this.git(['clean', '-f', '-d', '--', ...untracked])
  }

  async discardAll(): Promise<void> {
    await this.git(['reset', '--hard', '-q'])
    await this.git(['clean', '-f', '-d'])
  }

  /** Stages, unstages or discards selected diff lines (keys `${hunk}:${line}`). */
  async applyLines(diff: FileDiff, selected: string[], action: 'stage' | 'unstage' | 'discard'): Promise<void> {
    const patch = buildPartialPatch(diff, new Set(selected), action !== 'stage')
    if (!patch) return
    const args = ['apply', '--unidiff-zero', '--whitespace=nowarn']
    if (action !== 'discard') args.push('--cached')
    if (action !== 'stage') args.push('--reverse')
    await this.git([...args, '-'], { input: patch })
  }

  async commit(message: string, opts: { amend?: boolean; noVerify?: boolean; signoff?: boolean; allowEmpty?: boolean } = {}): Promise<void> {
    const args = ['commit', '-F', '-']
    if (opts.amend) args.push('--amend')
    if (opts.noVerify) args.push('--no-verify')
    if (opts.signoff) args.push('--signoff')
    if (opts.allowEmpty) args.push('--allow-empty')
    await this.recorded(opts.amend ? 'Amend commit' : 'Commit', 'move-head', 'soft', () => this.git(args, { input: message }))
  }

  /** Message git prepared for an in-progress merge, revert or cherry-pick (comments removed). */
  async preparedMessage(): Promise<string> {
    try {
      const raw = await fs.readFile(join(await this.gitDir(), 'MERGE_MSG'), 'utf8')
      return raw
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n')
        .trim()
    } catch {
      return ''
    }
  }

  async lastCommitMessage(): Promise<string> {
    return (await this.git(['log', '-1', '--format=%B'], { allowFailure: true })).stdout.trim()
  }

  async addToGitignore(pattern: string): Promise<void> {
    const file = join(this.path, '.gitignore')
    let content = ''
    try {
      content = await fs.readFile(file, 'utf8')
    } catch {
      /* new file */
    }
    if (content && !content.endsWith('\n')) content += '\n'
    await fs.writeFile(file, content + pattern + '\n')
  }

  // ------------------------------------------------------------------ branches

  async branches(): Promise<Branch[]> {
    return parseBranches(await this.out(['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes']))
  }

  async checkout(target: string, opts: { detach?: boolean; force?: boolean } = {}): Promise<void> {
    const args = ['checkout']
    if (opts.detach) args.push('--detach')
    if (opts.force) args.push('--force')
    await this.recorded(`Checkout ${target}`, 'checkout', undefined, () => this.git([...args, target, '--']))
  }

  /** Checks out a remote branch, creating (or fast-forward reusing) a local tracking branch. */
  async checkoutRemote(remoteBranch: string, localName?: string): Promise<void> {
    const name = localName ?? remoteBranch.slice(remoteBranch.indexOf('/') + 1)
    const exists = (await this.git(['rev-parse', '--verify', '-q', `refs/heads/${name}`], { allowFailure: true })).code === 0
    if (exists) return this.checkout(name)
    await this.recorded(`Checkout ${remoteBranch}`, 'checkout', undefined, () =>
      this.git(['checkout', '-b', name, '--track', remoteBranch])
    )
  }

  async createBranch(name: string, startPoint = 'HEAD', checkout = false): Promise<void> {
    if (checkout) {
      await this.recorded(`Create branch ${name}`, 'checkout', undefined, () => this.git(['checkout', '-b', name, startPoint]), [`refs/heads/${name}`])
    } else {
      await this.recorded(`Create branch ${name}`, 'refs', undefined, () => this.git(['branch', name, startPoint]), [`refs/heads/${name}`])
    }
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git(['branch', '-m', oldName, newName])
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.recorded(`Delete branch ${name}`, 'refs', undefined, () => this.git(['branch', force ? '-D' : '-d', name]), [`refs/heads/${name}`])
  }

  async deleteRemoteBranch(remote: string, name: string): Promise<void> {
    await this.git(['push', remote, '--delete', name])
  }

  async setUpstream(branch: string, upstream: string | null): Promise<void> {
    if (upstream) await this.git(['branch', `--set-upstream-to=${upstream}`, branch])
    else await this.git(['branch', '--unset-upstream', branch])
  }

  // ---------------------------------------------------------------------- tags

  async tags(): Promise<Tag[]> {
    return parseTags(await this.out(['for-each-ref', `--format=${TAG_FORMAT}`, '--sort=-creatordate', 'refs/tags']))
  }

  async createTag(name: string, target = 'HEAD', message?: string): Promise<void> {
    const args = message ? ['tag', '-a', name, '-F', '-', target] : ['tag', name, target]
    await this.recorded(`Create tag ${name}`, 'refs', undefined, () => this.git(args, { input: message }), [`refs/tags/${name}`])
  }

  async deleteTag(name: string): Promise<void> {
    await this.recorded(`Delete tag ${name}`, 'refs', undefined, () => this.git(['tag', '-d', name]), [`refs/tags/${name}`])
  }

  async pushTag(remote: string, name: string): Promise<void> {
    await this.git(['push', remote, `refs/tags/${name}`])
  }

  async deleteRemoteTag(remote: string, name: string): Promise<void> {
    await this.git(['push', remote, '--delete', `refs/tags/${name}`])
  }

  // ------------------------------------------------------------------- remotes

  async remotes(): Promise<Remote[]> {
    const out = await this.out(['remote', '-v'])
    const map = new Map<string, Remote>()
    for (const line of out.split('\n')) {
      const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line)
      if (!m) continue
      const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' }
      if (m[3] === 'fetch') r.fetchUrl = m[2]
      else r.pushUrl = m[2]
      map.set(m[1], r)
    }
    return [...map.values()]
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.git(['remote', 'add', name, url])
  }

  async removeRemote(name: string): Promise<void> {
    await this.git(['remote', 'remove', name])
  }

  async renameRemote(oldName: string, newName: string): Promise<void> {
    await this.git(['remote', 'rename', oldName, newName])
  }

  async setRemoteUrl(name: string, url: string, push = false): Promise<void> {
    await this.git(['remote', 'set-url', ...(push ? ['--push'] : []), name, url])
  }

  async fetch(opts: { remote?: string; prune?: boolean; tags?: boolean } = {}, onProgress?: (t: string) => void): Promise<void> {
    const args = ['fetch', '--progress']
    if (opts.prune) args.push('--prune')
    if (opts.tags) args.push('--tags')
    args.push(opts.remote ?? '--all')
    await this.git(args, { onProgress })
  }

  async pull(mode: PullMode = 'merge', onProgress?: (t: string) => void): Promise<void> {
    const flag = mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--no-rebase'
    await this.recorded('Pull', 'move-head', 'keep', () => this.git(['pull', '--progress', flag], { onProgress, env: NO_EDITOR }))
  }

  async push(
    opts: { remote?: string; branch?: string; setUpstream?: boolean; force?: 'lease' | 'force'; tags?: boolean } = {},
    onProgress?: (t: string) => void
  ): Promise<void> {
    const args = ['push', '--progress']
    if (opts.setUpstream) args.push('--set-upstream')
    if (opts.force === 'lease') args.push('--force-with-lease')
    if (opts.force === 'force') args.push('--force')
    if (opts.tags) args.push('--tags')
    if (opts.remote) args.push(opts.remote)
    if (opts.branch) args.push(opts.branch)
    await this.git(args, { onProgress })
  }

  // ----------------------------------------------------------- history editing

  async merge(target: string, mode: MergeMode = 'default'): Promise<GitResult> {
    const flags: Record<MergeMode, string[]> = { default: [], 'no-ff': ['--no-ff'], 'ff-only': ['--ff-only'], squash: ['--squash'] }
    return this.recorded(`Merge ${target}`, 'move-head', 'keep', () =>
      this.git(['merge', ...flags[mode], '--no-edit', target], { env: NO_EDITOR, allowFailure: true })
    )
  }

  async rebase(onto: string): Promise<GitResult> {
    return this.recorded(`Rebase onto ${onto}`, 'move-head', 'keep', () => this.git(['rebase', onto], { env: NO_EDITOR, allowFailure: true }))
  }

  /** Commits between `base` (exclusive) and HEAD, oldest first, as an editable todo list. */
  async rebaseTodo(base: string): Promise<RebaseTodoItem[]> {
    const commits = parseLog(await this.out(['log', '--reverse', '--topo-order', '--no-merges', `--format=${LOG_FORMAT}`, `${base}..HEAD`]))
    return commits.map((c) => ({ action: 'pick', sha: c.sha, subject: c.subject }))
  }

  /**
   * Runs `rebase -i` non-interactively: the todo list is written to a file that the
   * sequence editor copies over git's own. Rewords become pick + amend with a message file.
   */
  async interactiveRebase(base: string, items: RebaseTodoItem[]): Promise<GitResult> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'gitdesk-rebase-'))
    try {
      const lines: string[] = []
      for (const [i, item] of items.entries()) {
        if (item.action === 'reword') {
          lines.push(`pick ${item.sha} ${item.subject}`)
          const msgFile = join(dir, `msg-${i}.txt`)
          await fs.writeFile(msgFile, item.message ?? item.subject)
          lines.push(`exec git commit --amend --no-verify -F '${shPath(msgFile)}'`)
        } else lines.push(`${item.action} ${item.sha} ${item.subject}`)
      }
      const todo = join(dir, 'todo')
      await fs.writeFile(todo, lines.join('\n') + '\n')
      const onto = (await this.git(['rev-parse', '--verify', '-q', `${base}^{commit}`], { allowFailure: true })).code === 0 ? [base] : ['--root']
      return await this.recorded('Interactive rebase', 'move-head', 'keep', () =>
        this.git(['rebase', '-i', '--autostash', ...onto], {
          env: { ...NO_EDITOR, GIT_SEQUENCE_EDITOR: `cp '${shPath(todo)}'` },
          allowFailure: true
        })
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  async cherryPick(shas: string[], noCommit = false): Promise<GitResult> {
    return this.recorded('Cherry-pick', 'move-head', 'keep', () =>
      this.git(['cherry-pick', ...(noCommit ? ['--no-commit'] : []), ...shas], { env: NO_EDITOR, allowFailure: true })
    )
  }

  async revert(sha: string, mainline?: number): Promise<GitResult> {
    const args = ['revert', '--no-edit', ...(mainline ? ['-m', String(mainline)] : []), sha]
    return this.recorded(`Revert ${sha.slice(0, 7)}`, 'move-head', 'keep', () => this.git(args, { env: NO_EDITOR, allowFailure: true }))
  }

/** Reverts several commits, newest first, as separate revert commits. */
  async revertMany(shas: string[]): Promise<GitResult> {
    return this.recorded(`Revert ${shas.length} commits`, 'move-head', 'keep', () =>
      this.git(['revert', '--no-edit', ...shas], { env: NO_EDITOR, allowFailure: true })
    )
  }

  /** Rewrites only the message of the HEAD commit, keeping its tree. */
  async amendMessage(message: string): Promise<void> {
    await this.recorded('Amend message', 'move-head', 'soft', () => this.git(['commit', '--amend', '--only', '--no-verify', '-F', '-'], { input: message }))
  }

  async reset(target: string, mode: ResetMode): Promise<void> {
    await this.recorded(`Reset (${mode}) to ${target.slice(0, 7)}`, 'move-head', 'keep', () => this.git(['reset', `--${mode}`, target]))
  }

  /** continue / skip / abort for the in-progress operation. */
  async sequencer(op: Exclude<Operation, 'bisect'>, action: 'continue' | 'skip' | 'abort'): Promise<GitResult> {
    if (op === 'merge' && action === 'skip') throw new Error('merge cannot be skipped')
    return this.git([op, `--${action}`], { env: NO_EDITOR, allowFailure: action !== 'abort' })
  }

  // ----------------------------------------------------------------- conflicts

  async conflictVersions(path: string): Promise<ConflictVersions> {
    const stage = async (n: number): Promise<string | null> => {
      const r = await this.git(['show', `:${n}:${path}`], { allowFailure: true })
      return r.code === 0 ? r.stdout : null
    }
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)])
    let merged = ''
    try {
      merged = await fs.readFile(join(this.path, path), 'utf8')
    } catch {
      /* deleted on one side */
    }
    return { path, base, ours, theirs, merged }
  }

  async resolveWithContent(path: string, content: string): Promise<void> {
    await fs.writeFile(join(this.path, path), content)
    await this.git(['add', '--', path])
  }

  async resolveWithSide(path: string, side: 'ours' | 'theirs'): Promise<void> {
    const r = await this.git(['checkout', `--${side}`, '--', path], { allowFailure: true })
    // The chosen side deleted the file.
    if (r.code !== 0) await this.git(['rm', '-q', '--', path])
    else await this.git(['add', '--', path])
  }

  /** Re-creates conflict markers for a file that was resolved but not committed. */
  async markConflicted(path: string): Promise<void> {
    await this.git(['checkout', '-m', '--', path])
  }

  /** Launches the user's configured `git mergetool`. */
  async mergetool(path: string): Promise<GitResult> {
    return this.git(['mergetool', '--no-prompt', '--', path], { allowFailure: true })
  }

  // -------------------------------------------------------------------- stash

  async stashes(): Promise<Stash[]> {
    return parseStashes(await this.out(['stash', 'list', '--format=%gd%x00%H%x00%gs']))
  }

  async stashSave(message?: string, opts: { includeUntracked?: boolean; keepIndex?: boolean; staged?: boolean; paths?: string[] } = {}): Promise<void> {
    const args = ['stash', 'push']
    if (opts.includeUntracked) args.push('--include-untracked')
    if (opts.keepIndex) args.push('--keep-index')
    if (opts.staged) args.push('--staged')
    if (message) args.push('-m', message)
    if (opts.paths?.length) args.push('--', ...opts.paths)
    await this.git(args)
  }

  async stashApply(index: number, pop = false): Promise<GitResult> {
    return this.git(['stash', pop ? 'pop' : 'apply', '--index', `stash@{${index}}`], { allowFailure: true })
  }

  async stashDrop(index: number): Promise<void> {
    await this.git(['stash', 'drop', `stash@{${index}}`])
  }

  async stashBranch(index: number, branch: string): Promise<void> {
    await this.git(['stash', 'branch', branch, `stash@{${index}}`])
  }

  async stashFiles(index: number): Promise<ChangedFile[]> {
    const ref = `stash@{${index}}`
    return this.compare(`${ref}^1`, ref)
  }

  // ------------------------------------------------- submodules / worktrees / lfs

  async submodules(): Promise<Submodule[]> {
    return parseSubmodules((await this.git(['submodule', 'status'], { allowFailure: true })).stdout)
  }

  async submoduleUpdate(path?: string, init = true): Promise<void> {
    await this.git(['submodule', 'update', ...(init ? ['--init'] : []), '--recursive', ...(path ? ['--', path] : [])])
  }

  async addSubmodule(url: string, path: string): Promise<void> {
    await this.git(['submodule', 'add', '--', url, path])
  }

  async worktrees(): Promise<Worktree[]> {
    return parseWorktrees(await this.out(['worktree', 'list', '--porcelain']))
  }

  async addWorktree(path: string, branch: string, createBranch = false): Promise<void> {
    await this.git(['worktree', 'add', ...(createBranch ? ['-b', branch, path] : [path, branch])])
  }

  async addWorktreeFrom(path: string, newBranch: string, startPoint: string): Promise<void> {
    await this.git(['worktree', 'add', '-b', newBranch, path, startPoint])
  }

  async removeWorktree(path: string, force = false): Promise<void> {
    await this.git(['worktree', 'remove', ...(force ? ['--force'] : []), path])
  }

  async lfsDetected(): Promise<boolean> {
    try {
      const attrs = await fs.readFile(join(this.path, '.gitattributes'), 'utf8')
      return /filter=lfs/.test(attrs)
    } catch {
      return false
    }
  }

  async lfs(args: string[]): Promise<GitResult> {
    return this.git(['lfs', ...args], { allowFailure: true })
  }

  // -------------------------------------------------------------------- bisect

  async bisect(action: 'start' | 'good' | 'bad' | 'skip' | 'reset', rev?: string): Promise<GitResult> {
    return this.git(['bisect', action, ...(rev ? [rev] : [])], { allowFailure: true })
  }

  // ------------------------------------------------------------------- patches

  async formatPatch(range: string, outDir: string): Promise<string[]> {
    return (await this.out(['format-patch', '-o', outDir, range])).split('\n').filter(Boolean)
  }

  async applyPatch(file: string, asCommits: boolean): Promise<GitResult> {
    return this.git(asCommits ? ['am', '--3way', file] : ['apply', '--3way', file], { allowFailure: true })
  }

  // ------------------------------------------------------------------- console

  /** Runs an arbitrary git command line typed by the user (without the leading `git`). */
  async console(commandLine: string): Promise<GitResult> {
    const args = splitArgs(commandLine.trim().replace(/^git\s+/, ''))
    if (!args.length) throw new Error('Empty command')
    return this.git(args, { allowFailure: true, env: NO_EDITOR })
  }

  // ---------------------------------------------------------------- undo/redo

  private async snapshot(): Promise<HeadSnapshot> {
    const sha = (await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })).stdout.trim()
    const branch = (await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true })).stdout.trim()
    return { sha, branch: branch || undefined }
  }

  private async refShas(refs: string[]): Promise<Record<string, string | null>> {
    const res: Record<string, string | null> = {}
    for (const r of refs) {
      const v = await this.git(['rev-parse', '--verify', '-q', r], { allowFailure: true })
      res[r] = v.code === 0 ? v.stdout.trim() : null
    }
    return res
  }

  /** Runs an action and records it for undo when HEAD or the given refs changed. */
  private async recorded<T>(
    label: string,
    kind: UndoEntry['kind'],
    resetMode: UndoEntry['resetMode'],
    action: () => Promise<T>,
    refs: string[] = []
  ): Promise<T> {
    const before = await this.snapshot()
    const branchRef = before.branch ? [`refs/heads/${before.branch}`] : []
    const tracked = [...new Set([...refs, ...(kind === 'move-head' ? branchRef : [])])]
    const refsBefore = await this.refShas(tracked)
    const result = await action()
    const after = await this.snapshot()
    const refsAfter = await this.refShas(tracked)
    const moved = before.sha !== after.sha || before.branch !== after.branch
    const refsChanged = tracked.some((r) => refsBefore[r] !== refsAfter[r])
    // Operations stopped by conflicts are finished or aborted by the user; don't record them.
    const op = this.detectOperation(await this.gitDir())
    if ((moved || refsChanged) && !op) {
      this.undoStack.push({ label, kind, resetMode, before, after, refsBefore, refsAfter })
      if (this.undoStack.length > 100) this.undoStack.shift()
      this.redoStack = []
    }
    return result
  }

  undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label
  }

  redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label
  }

  async undo(): Promise<string | undefined> {
    const e = this.undoStack.pop()
    if (!e) return undefined
    try {
      await this.restore(e, 'before')
    } catch (err) {
      this.undoStack.push(e)
      throw err
    }
    this.redoStack.push(e)
    return e.label
  }

  async redo(): Promise<string | undefined> {
    const e = this.redoStack.pop()
    if (!e) return undefined
    try {
      await this.restore(e, 'after')
    } catch (err) {
      this.redoStack.push(e)
      throw err
    }
    this.undoStack.push(e)
    return e.label
  }

  private async restore(e: UndoEntry, side: 'before' | 'after'): Promise<void> {
    const head = e[side]
    const refs = Object.entries(side === 'before' ? e.refsBefore : e.refsAfter)
    // reset moves the current branch itself; leave that ref to it.
    const own = e.kind === 'move-head' && head.branch ? `refs/heads/${head.branch}` : undefined
    // Create/move refs first so a checkout target exists, delete refs last so the
    // branch being left is no longer checked out.
    for (const [ref, sha] of refs) if (sha && ref !== own) await this.git(['update-ref', ref, sha])
    if (e.kind === 'move-head') {
      if (!head.sha) throw new Error('Cannot undo the first commit')
      await this.git(['reset', `--${e.resetMode ?? 'keep'}`, head.sha])
    } else if (e.kind === 'checkout') {
      await this.git(['checkout', head.branch ?? head.sha, '--'])
    }
    for (const [ref, sha] of refs) if (!sha && ref !== own) await this.git(['update-ref', '-d', ref])
  }
}
