// Pure parsers for git plumbing output. No I/O here so everything is unit-testable.
import type {
  BlameLine,
  Branch,
  ChangedFile,
  Commit,
  DiffHunk,
  DiffLine,
  FileChangeKind,
  FileDiff,
  ReflogEntry,
  Ref,
  Stash,
  StatusEntry,
  Submodule,
  Tag,
  Worktree
} from '@shared/types'

export const FS = '\x00'
export const RS = '\x1e'

/** `git log` format whose output parseLog understands. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%s'].join('%x00') + '%x1e'

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const raw of out.split(RS)) {
    const rec = raw.replace(/^\n/, '')
    if (!rec) continue
    const [sha, parents, author, authorEmail, at, committer, ct, subject] = rec.split(FS)
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      authorEmail,
      authorTime: Number(at),
      committer,
      committerTime: Number(ct),
      subject: subject ?? ''
    })
  }
  return commits
}

export const REF_FORMAT = '%(refname)%00%(objectname)%00%(*objectname)'

/** Parses for-each-ref with REF_FORMAT. Annotated tags resolve to the peeled commit. */
export function parseRefs(out: string): Ref[] {
  const refs: Ref[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [fullName, sha, peeled] = line.split(FS)
    let type: Ref['type']
    let name: string
    if (fullName.startsWith('refs/heads/')) {
      type = 'head'
      name = fullName.slice(11)
    } else if (fullName.startsWith('refs/remotes/')) {
      name = fullName.slice(13)
      if (name.endsWith('/HEAD')) continue
      type = 'remote'
    } else if (fullName.startsWith('refs/tags/')) {
      type = 'tag'
      name = fullName.slice(10)
    } else continue
    refs.push({ fullName, name, type, sha: peeled || sha })
  }
  return refs
}

export const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:unix)',
  '%(contents:subject)'
].join('%00')

export function parseBranches(out: string): Branch[] {
  const branches: Branch[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [fullName, sha, head, upstream, track, ct, subject] = line.split(FS)
    const remote = fullName.startsWith('refs/remotes/')
    const name = fullName.replace(/^refs\/(heads|remotes)\//, '')
    if (remote && name.endsWith('/HEAD')) continue
    const ahead = /ahead (\d+)/.exec(track)
    const behind = /behind (\d+)/.exec(track)
    branches.push({
      name,
      fullName,
      remote,
      sha,
      current: head === '*',
      upstream: upstream || undefined,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      gone: track === 'gone',
      subject,
      committerTime: Number(ct)
    })
  }
  return branches
}

export const TAG_FORMAT = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(objecttype)', '%(contents:subject)'].join('%00')

export function parseTags(out: string): Tag[] {
  const tags: Tag[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [name, sha, peeled, type, message] = line.split(FS)
    tags.push({ name, sha: peeled || sha, annotated: type === 'tag', message: message ?? '' })
  }
  return tags
}

export interface StatusBranchInfo {
  head?: string
  branch?: string
  upstream?: string
  ahead: number
  behind: number
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): { branch: StatusBranchInfo; entries: StatusEntry[] } {
  const branch: StatusBranchInfo = { ahead: 0, behind: 0 }
  const entries: StatusEntry[] = []
  const parts = out.split(FS)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# ')) {
      const [, key, ...rest] = p.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid' && value !== '(initial)') branch.head = value
      else if (key === 'branch.head' && value !== '(detached)') branch.branch = value
      else if (key === 'branch.upstream') branch.upstream = value
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value)
        if (m) {
          branch.ahead = Number(m[1])
          branch.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = p[0]
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = p.split(' ')
      entries.push(entry(f.slice(8).join(' '), f[1], false))
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = p.split(' ')
      const e = entry(f.slice(9).join(' '), f[1], false)
      e.oldPath = parts[++i]
      entries.push(e)
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = p.split(' ')
      entries.push(entry(f.slice(10).join(' '), f[1], true))
    } else if (kind === '?') {
      entries.push({ path: p.slice(2), index: '?', worktree: '?', conflicted: false, untracked: true })
    }
  }
  return { branch, entries }
}

function entry(path: string, xy: string, conflicted: boolean): StatusEntry {
  const norm = (c: string): string => (c === '.' ? ' ' : c)
  return { path, index: norm(xy[0]), worktree: norm(xy[1]), conflicted, untracked: false }
}

const KIND: Record<string, FileChangeKind> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'unmerged'
}

/** Parses `--name-status -z` output (as produced by diff-tree / diff). */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split(FS).filter((p) => p !== '')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    const code = status[0]
    if (!/^[AMDRCTUX]/.test(code)) continue
    if (code === 'R' || code === 'C') {
      files.push({ kind: KIND[code], oldPath: parts[i + 1], path: parts[i + 2] })
      i += 2
    } else {
      files.push({ kind: KIND[code] ?? 'modified', path: parts[i + 1] })
      i += 1
    }
  }
  return files
}

/** Merges `--numstat -z` counts into files from parseNameStatus. */
export function applyNumstat(files: ChangedFile[], out: string): ChangedFile[] {
  const parts = out.split(FS)
  const byPath = new Map(files.map((f) => [f.path, f]))
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    const [add, del, path] = p.split('\t')
    let target = path
    if (path === '') {
      // rename: "add\tdel\t" \0 old \0 new
      target = parts[i + 2]
      i += 2
    }
    const f = byPath.get(target)
    if (!f) continue
    if (add === '-') f.binary = true
    else {
      f.additions = Number(add)
      f.deletions = Number(del)
    }
  }
  return files
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parses unified diff output for one or more files. */
export function parseDiff(out: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  const lines = out.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      file = { path: '', header: [line], binary: false, hunks: [] }
      hunk = null
      files.push(file)
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line)
      if (m) {
        file.path = m[2]
        if (m[1] !== m[2]) file.oldPath = m[1]
      }
      continue
    }
    if (!file) continue
    const h = HUNK_RE.exec(line)
    if (h) {
      hunk = {
        header: line,
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: []
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      file.header.push(line)
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = unquote(line.slice(4)).replace(/^b\//, '')
      else if (line.startsWith('--- ') && line !== '--- /dev/null' && !file.path) file.path = unquote(line.slice(4)).replace(/^a\//, '')
      else if (line.startsWith('rename from ')) file.oldPath = line.slice(12)
      else if (line.startsWith('rename to ')) file.path = line.slice(10)
      continue
    }
    let dl: DiffLine
    const c = line[0]
    if (c === '+') dl = { kind: 'add', content: line.slice(1), newNo: newNo++ }
    else if (c === '-') dl = { kind: 'del', content: line.slice(1), oldNo: oldNo++ }
    else if (c === '\\') dl = { kind: 'meta', content: line }
    else dl = { kind: 'context', content: line.slice(1), oldNo: oldNo++, newNo: newNo++ }
    hunk.lines.push(dl)
  }
  return files
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

/**
 * Builds a patch containing only the selected lines of one file diff, for `git apply`.
 *
 * `selected` holds `${hunkIndex}:${lineIndex}` keys. With `reverse` false the patch is
 * applied forward (staging unstaged lines); with `reverse` true it is applied with
 * `--reverse` (unstaging staged lines or discarding worktree lines). Unselected changes
 * are neutralised so the patch still matches the side git checks against.
 */
export function buildPartialPatch(diff: FileDiff, selected: Set<string>, reverse: boolean): string | null {
  const out: string[] = []
  for (const h of diff.header) {
    if (h.startsWith('diff ') || h.startsWith('index ') || h.startsWith('--- ') || h.startsWith('+++ ') || /^(old|new) mode /.test(h)) out.push(h)
  }
  if (!out.some((h) => h.startsWith('--- '))) {
    out.push(`--- a/${diff.oldPath ?? diff.path}`, `+++ b/${diff.path}`)
  }
  let any = false
  // Net line delta of the hunks emitted so far; skipped hunks change nothing.
  let delta = 0
  diff.hunks.forEach((hunk, hi) => {
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let changed = false
    let lastKept = true
    hunk.lines.forEach((l, li) => {
      const isSel = selected.has(`${hi}:${li}`)
      if (l.kind === 'meta') {
        if (lastKept) body.push(l.content)
        return
      }
      lastKept = true
      if (l.kind === 'context') {
        body.push(' ' + l.content)
        oldCount++
        newCount++
      } else if (isSel) {
        body.push((l.kind === 'add' ? '+' : '-') + l.content)
        if (l.kind === 'add') newCount++
        else oldCount++
        changed = true
      } else {
        // Unselected change: keep it as context on the side git verifies, drop it on the other.
        const keepAsContext = reverse ? l.kind === 'add' : l.kind === 'del'
        if (keepAsContext) {
          body.push(' ' + l.content)
          oldCount++
          newCount++
        } else lastKept = false
      }
    })
    if (!changed) return
    any = true
    // Forward patches are checked against the old side, reverse ones against the new side.
    const oldStart = reverse ? hunk.newStart - delta : hunk.oldStart
    const newStart = reverse ? hunk.newStart : hunk.oldStart + delta
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    out.push(...body)
    delta += newCount - oldCount
  })
  return any ? out.join('\n') + '\n' : null
}

export function parseStashes(out: string): Stash[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, message] = line.split(FS)
      const m = /\{(\d+)\}/.exec(ref)
      return { ref, sha, message, index: m ? Number(m[1]) : 0 }
    })
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = []
  let cur: Worktree | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), sha: '', bare: false, detached: false, locked: false, prunable: false }
      list.push(cur)
    } else if (!cur) continue
    else if (line.startsWith('HEAD ')) cur.sha = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'bare') cur.bare = true
    else if (line === 'detached') cur.detached = true
    else if (line.startsWith('locked')) cur.locked = true
    else if (line.startsWith('prunable')) cur.prunable = true
  }
  return list
}

/** Parses `git submodule status`. */
export function parseSubmodules(out: string): Submodule[] {
  const list: Submodule[] = []
  for (const line of out.split('\n')) {
    const m = /^([ +\-U])([0-9a-f]+) (\S+)(?: \((.*)\))?$/.exec(line)
    if (m) list.push({ state: m[1], sha: m[2], path: m[3], describe: m[4] ?? '' })
  }
  return list
}

export function parseReflog(out: string): ReflogEntry[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, selector, time, message] = line.split(FS)
      return { sha, selector, time: Number(time), message }
    })
}

/** Parses `git blame --porcelain`. */
export function parseBlame(out: string): BlameLine[] {
  const lines: BlameLine[] = []
  const meta = new Map<string, { author: string; time: number }>()
  let cur: { sha: string; lineNo: number } | null = null
  for (const line of out.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
    if (head) {
      cur = { sha: head[1], lineNo: Number(head[2]) }
      if (!meta.has(cur.sha)) meta.set(cur.sha, { author: '', time: 0 })
      continue
    }
    if (!cur) continue
    const m = meta.get(cur.sha)!
    if (line.startsWith('author ')) m.author = line.slice(7)
    else if (line.startsWith('author-time ')) m.time = Number(line.slice(12))
    else if (line.startsWith('\t')) {
      lines.push({ sha: cur.sha, lineNo: cur.lineNo, content: line.slice(1), author: '', time: 0 })
      cur = null
    }
  }
  for (const l of lines) Object.assign(l, meta.get(l.sha))
  return lines
}

/**
 * Splits a console command line into argv without a shell. Supports single and double
 * quotes and backslash escapes inside double quotes.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) cur += input[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) args.push(cur)
      cur = ''
      has = false
    } else cur += c
  }
  if (quote) throw new Error('Unterminated quote')
  if (has || cur) args.push(cur)
  return args
}
