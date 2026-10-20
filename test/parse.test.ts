import { describe, expect, it } from 'vitest'
import { applyNumstat, parseBranches, parseDiff, parseLog, parseNameStatus, parseStatus, splitArgs } from '../src/main/git/parse'

const NUL = '\x00'

describe('parseLog', () => {
  it('parses NUL separated records with parents', () => {
    const rec = (f: string[]) => f.join(NUL) + '\x1e'
    const out = rec(['a1', 'b2 c3', 'Kim', 'k@x', '10', 'Kim', '11', 'merge: x']) + '\n' + rec(['b2', '', 'Lee', 'l@x', '5', 'Lee', '6', ''])
    const commits = parseLog(out)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({ sha: 'a1', parents: ['b2', 'c3'], author: 'Kim', authorTime: 10, subject: 'merge: x' })
    expect(commits[1].parents).toEqual([])
  })
})

describe('parseStatus', () => {
  it('handles branch headers, ordinary, renamed, unmerged and untracked entries', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 h1 h2 src/a b.ts',
      '2 R. N... 100644 100644 100644 h1 h2 R100 new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.ts',
      '? 새파일.txt',
      ''
    ].join(NUL)
    const { branch, entries } = parseStatus(out)
    expect(branch).toEqual({ head: 'abc', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(entries[0]).toMatchObject({ path: 'src/a b.ts', index: ' ', worktree: 'M' })
    expect(entries[1]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', index: 'R' })
    expect(entries[2]).toMatchObject({ path: 'conflict.ts', conflicted: true })
    expect(entries[3]).toMatchObject({ path: '새파일.txt', untracked: true })
  })

  it('treats detached and initial heads as absent', () => {
    const { branch } = parseStatus(['# branch.oid (initial)', '# branch.head (detached)', ''].join(NUL))
    expect(branch.head).toBeUndefined()
    expect(branch.branch).toBeUndefined()
  })
})

describe('parseBranches', () => {
  it('reads tracking info and skips remote HEAD', () => {
    const line = (f: string[]) => f.join(NUL)
    const out = [
      line(['refs/heads/main', 's1', '*', 'origin/main', 'ahead 3, behind 2', '100', 'subj']),
      line(['refs/heads/old', 's2', ' ', 'origin/old', 'gone', '90', 'x']),
      line(['refs/remotes/origin/HEAD', 's1', ' ', '', '', '100', 'subj']),
      line(['refs/remotes/origin/main', 's1', ' ', '', '', '100', 'subj'])
    ].join('\n')
    const b = parseBranches(out)
    expect(b).toHaveLength(3)
    expect(b[0]).toMatchObject({ name: 'main', current: true, ahead: 3, behind: 2 })
    expect(b[1].gone).toBe(true)
    expect(b[2]).toMatchObject({ name: 'origin/main', remote: true })
  })
})

describe('parseNameStatus + applyNumstat', () => {
  it('pairs renames and binary files', () => {
    const files = parseNameStatus(['M', 'a.ts', 'R090', 'old.ts', 'new.ts', 'A', 'img.png', ''].join(NUL))
    expect(files.map((f) => f.kind)).toEqual(['modified', 'renamed', 'added'])
    applyNumstat(files, ['3\t1\ta.ts', '2\t2\t', 'old.ts', 'new.ts', '-\t-\timg.png', ''].join(NUL))
    expect(files[0]).toMatchObject({ additions: 3, deletions: 1 })
    expect(files[1]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', additions: 2 })
    expect(files[2].binary).toBe(true)
  })
})

describe('parseDiff', () => {
  it('numbers lines and keeps header', () => {
    const out = [
      'diff --git a/f.txt b/f.txt',
      'index 1..2 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '\\ No newline at end of file'
    ].join('\n')
    const [d] = parseDiff(out)
    expect(d.path).toBe('f.txt')
    expect(d.header).toHaveLength(4)
    const lines = d.hunks[0].lines
    expect(lines[1]).toMatchObject({ kind: 'del', oldNo: 2 })
    expect(lines[2]).toMatchObject({ kind: 'add', newNo: 2 })
    expect(lines[4].kind).toBe('meta')
  })

  it('detects binary files', () => {
    const [d] = parseDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n')
    expect(d.binary).toBe(true)
  })
})

describe('splitArgs', () => {
  it('splits like a shell without expansion', () => {
    expect(splitArgs(`log --format="%h %s" -n 3 'a b' ""`)).toEqual(['log', '--format=%h %s', '-n', '3', 'a b', ''])
  })
  it('rejects unterminated quotes', () => {
    expect(() => splitArgs('commit -m "oops')).toThrow()
  })
})
