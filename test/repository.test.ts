import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Repository } from '../src/main/git/repository'

let dir: string
let repo: Repository

const write = (name: string, content: string) => fs.writeFile(join(dir, name), content)
const read = (name: string) => fs.readFile(join(dir, name), 'utf8')

async function commitFile(name: string, content: string, message: string): Promise<void> {
  await write(name, content)
  await repo.stage([name])
  await repo.commit(message)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'gitdesk-test-'))
  await Repository.init(dir)
  repo = new Repository(dir)
  await repo.git(['config', 'user.name', 'Tester'])
  await repo.git(['config', 'user.email', 't@example.com'])
  await repo.git(['config', 'core.autocrlf', 'false'])
  await repo.git(['checkout', '-q', '-b', 'main'])
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('Repository', () => {
  it('reports state of an empty repository', async () => {
    const s = await repo.state()
    expect(s.branch).toBe('main')
    expect(s.head).toBeUndefined()
    expect(await repo.log()).toEqual([])
  })

  it('commits and reads history, refs and detail', async () => {
    await commitFile('a.txt', 'one\n', 'first')
    await commitFile('a.txt', 'one\ntwo\n', 'second\n\nbody text')
    const log = await repo.log()
    expect(log.map((c) => c.subject)).toEqual(['second', 'first'])
    const detail = await repo.commitDetail(log[0].sha)
    expect(detail.body).toBe('body text')
    expect(detail.files).toEqual([{ path: 'a.txt', kind: 'modified', additions: 1, deletions: 0 }])
    const refs = await repo.refs()
    expect(refs).toContainEqual(expect.objectContaining({ name: 'main', type: 'head', sha: log[0].sha }))
  })

  it('stages and unstages individual lines', async () => {
    await commitFile('f.txt', 'a\nb\nc\nd\ne\n', 'base')
    await write('f.txt', 'a\nB\nc\nd\nE\n')
    const diff = (await repo.workingDiff('f.txt', false, false))!
    // Select only the first change (b -> B): lines 1 and 2 of hunk 0.
    const keys: string[] = []
    diff.hunks[0].lines.forEach((l, i) => {
      if ((l.kind === 'del' && l.content === 'b') || (l.kind === 'add' && l.content === 'B')) keys.push(`0:${i}`)
    })
    await repo.applyLines(diff, keys, 'stage')
    expect((await repo.git(['show', ':f.txt'])).stdout).toBe('a\nB\nc\nd\ne\n')

    const staged = (await repo.workingDiff('f.txt', true, false))!
    const addKey = staged.hunks[0].lines.findIndex((l) => l.kind === 'add')
    const delKey = staged.hunks[0].lines.findIndex((l) => l.kind === 'del')
    await repo.applyLines(staged, [`0:${addKey}`, `0:${delKey}`], 'unstage')
    expect((await repo.git(['show', ':f.txt'])).stdout).toBe('a\nb\nc\nd\ne\n')
    expect(await read('f.txt')).toBe('a\nB\nc\nd\nE\n')
  })

  it('stages a line from a second hunk', async () => {
    const base = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n'
    await commitFile('g.txt', base, 'base')
    await write('g.txt', base.replace('l1\n', 'l1\nX\n').replace('l18\n', 'l18\nY\n'))
    const diff = (await repo.workingDiff('g.txt', false, false))!
    expect(diff.hunks).toHaveLength(2)
    const i = diff.hunks[1].lines.findIndex((l) => l.kind === 'add')
    await repo.applyLines(diff, [`1:${i}`], 'stage')
    expect((await repo.git(['show', ':g.txt'])).stdout).toBe(base.replace('l18\n', 'l18\nY\n'))
  })

  it('discards selected lines from the worktree', async () => {
    await commitFile('f.txt', 'a\nb\n', 'base')
    await write('f.txt', 'a\nX\nb\nY\n')
    const diff = (await repo.workingDiff('f.txt', false, false))!
    const i = diff.hunks[0].lines.findIndex((l) => l.content === 'Y')
    await repo.applyLines(diff, [`0:${i}`], 'discard')
    expect(await read('f.txt')).toBe('a\nX\nb\n')
  })

  it('shows untracked file diffs', async () => {
    await commitFile('a.txt', 'a\n', 'base')
    await write('new.txt', 'hello\n')
    const diff = await repo.workingDiff('new.txt', false, true)
    expect(diff?.hunks[0].lines[0]).toMatchObject({ kind: 'add', content: 'hello' })
  })

  it('undoes and redoes a commit', async () => {
    await commitFile('a.txt', '1\n', 'first')
    await commitFile('a.txt', '2\n', 'second')
    expect(repo.undoLabel()).toBe('Commit')
    await repo.undo()
    expect((await repo.log()).map((c) => c.subject)).toEqual(['first'])
    // Undoing a commit keeps its changes staged.
    expect((await repo.state()).status[0]).toMatchObject({ path: 'a.txt', index: 'M' })
    await repo.redo()
    expect((await repo.log()).map((c) => c.subject)).toEqual(['second', 'first'])
  })

  it('undoes and redoes branch creation with checkout', async () => {
    await commitFile('a.txt', '1\n', 'first')
    await repo.createBranch('feature', 'HEAD', true)
    expect((await repo.state()).branch).toBe('feature')
    await repo.undo()
    expect((await repo.state()).branch).toBe('main')
    expect((await repo.branches()).map((b) => b.name)).toEqual(['main'])
    await repo.redo()
    expect((await repo.state()).branch).toBe('feature')
  })

  it('undoes branch deletion', async () => {
    await commitFile('a.txt', '1\n', 'first')
    await repo.createBranch('topic')
    await repo.deleteBranch('topic')
    await repo.undo()
    expect((await repo.branches()).map((b) => b.name).sort()).toEqual(['main', 'topic'])
  })

  it('reports and resolves merge conflicts', async () => {
    await commitFile('c.txt', 'base\n', 'base')
    await repo.createBranch('other', 'HEAD', true)
    await commitFile('c.txt', 'theirs\n', 'theirs')
    await repo.checkout('main')
    await commitFile('c.txt', 'ours\n', 'ours')
    const r = await repo.merge('other')
    expect(r.code).not.toBe(0)
    const s = await repo.state()
    expect(s.operation).toBe('merge')
    expect(s.status[0]).toMatchObject({ path: 'c.txt', conflicted: true })
    const v = await repo.conflictVersions('c.txt')
    expect(v).toMatchObject({ base: 'base\n', ours: 'ours\n', theirs: 'theirs\n' })
    await repo.resolveWithContent('c.txt', 'resolved\n')
    await repo.sequencer('merge', 'continue')
    const after = await repo.state()
    expect(after.operation).toBeUndefined()
    expect((await repo.log())[0].parents).toHaveLength(2)
  })

  it('runs an interactive rebase with reword, squash and drop', async () => {
    await commitFile('f.txt', '0\n', 'root')
    const base = (await repo.log())[0].sha
    await commitFile('f.txt', '1\n', 'one')
    await commitFile('f.txt', '2\n', 'two')
    await commitFile('g.txt', 'g\n', 'three')
    const todo = await repo.rebaseTodo(base)
    expect(todo.map((t) => t.subject)).toEqual(['one', 'two', 'three'])
    todo[0].action = 'reword'
    todo[0].message = 'ONE renamed'
    todo[1].action = 'fixup'
    todo[2].action = 'drop'
    const r = await repo.interactiveRebase(base, todo)
    expect(r.code).toBe(0)
    expect((await repo.log()).map((c) => c.subject)).toEqual(['ONE renamed', 'root'])
    expect(await read('f.txt')).toBe('2\n')
    await repo.undo()
    expect((await repo.log()).map((c) => c.subject)).toEqual(['three', 'two', 'one', 'root'])
  })

  it('stashes, lists and pops', async () => {
    await commitFile('a.txt', '1\n', 'first')
    await write('a.txt', '2\n')
    await write('u.txt', 'u\n')
    await repo.stashSave('wip', { includeUntracked: true })
    expect((await repo.state()).status).toEqual([])
    const stashes = await repo.stashes()
    expect(stashes[0]).toMatchObject({ index: 0 })
    expect(stashes[0].message).toContain('wip')
    expect((await repo.stashFiles(0)).map((f) => f.path)).toEqual(['a.txt'])
    await repo.stashApply(0, true)
    expect(await read('a.txt')).toBe('2\n')
    expect(await repo.stashes()).toEqual([])
  })

  it('runs console commands without a shell', async () => {
    await commitFile('a.txt', '1\n', 'first')
    const r = await repo.console('git log --format="%s|%an" -n 1')
    expect(r.stdout.trim()).toBe('first|Tester')
  })

  it('creates, lists and deletes tags', async () => {
    await commitFile('a.txt', '1\n', 'first')
    await repo.createTag('v1', 'HEAD', 'release one')
    await repo.createTag('light')
    const tags = await repo.tags()
    expect(tags.find((t) => t.name === 'v1')).toMatchObject({ annotated: true, message: 'release one' })
    expect(tags.find((t) => t.name === 'light')?.annotated).toBe(false)
    await repo.deleteTag('light')
    expect((await repo.tags()).map((t) => t.name)).toEqual(['v1'])
  })

  it('pushes to and pulls from a remote', async () => {
    const remoteDir = await fs.mkdtemp(join(tmpdir(), 'gitdesk-remote-'))
    try {
      await Repository.init(remoteDir, true)
      await new Repository(remoteDir).git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
      await commitFile('a.txt', '1\n', 'first')
      await repo.addRemote('origin', remoteDir)
      await repo.push({ remote: 'origin', branch: 'main', setUpstream: true })
      const s = await repo.state()
      expect(s.upstream).toBe('origin/main')

      const cloneDir = join(await fs.mkdtemp(join(tmpdir(), 'gitdesk-clone-')), 'c')
      await Repository.clone(remoteDir, cloneDir)
      const other = new Repository(cloneDir)
      await other.git(['config', 'user.name', 'Other'])
      await other.git(['config', 'user.email', 'o@example.com'])
      await fs.writeFile(join(cloneDir, 'b.txt'), 'b\n')
      await other.stage(['b.txt'])
      await other.commit('from clone')
      await other.push()

      await repo.fetch()
      expect((await repo.state()).behind).toBe(1)
      await repo.pull('ff-only')
      expect((await repo.log())[0].subject).toBe('from clone')
      await fs.rm(join(cloneDir, '..'), { recursive: true, force: true })
    } finally {
      await fs.rm(remoteDir, { recursive: true, force: true })
    }
  })
})
