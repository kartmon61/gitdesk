// Backend operations behind the GitKraken-style UI controls (solo/hide, drag menus, multi-select).
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
  dir = await fs.mkdtemp(join(tmpdir(), 'gitdesk-ui-'))
  await Repository.init(dir)
  repo = new Repository(dir)
  await repo.git(['config', 'user.name', 'Tester'])
  await repo.git(['config', 'user.email', 't@example.com'])
  await repo.git(['config', 'core.autocrlf', 'false'])
  await repo.git(['checkout', '-q', '-b', 'main'])
  await commitFile('a.txt', '1\n', 'base')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('graph filtering (solo / hide)', () => {
  beforeEach(async () => {
    await repo.createBranch('feature', 'HEAD', true)
    await commitFile('f.txt', 'f\n', 'feature work')
    await repo.checkout('main')
    await commitFile('a.txt', '1\n2\n', 'main work')
  })

  it('hides a branch that is not checked out', async () => {
    const all = (await repo.log()).map((c) => c.subject)
    expect(all).toContain('feature work')
    const hidden = (await repo.log(100, 0, { exclude: ['refs/heads/feature'] })).map((c) => c.subject)
    expect(hidden).not.toContain('feature work')
    expect(hidden).toContain('main work')
  })

  it('solo shows only the chosen ref (plus HEAD)', async () => {
    await repo.checkout('feature')
    const solo = (await repo.log(100, 0, { include: ['refs/heads/feature'] })).map((c) => c.subject)
    expect(solo).toEqual(['feature work', 'base'])
  })
})

describe('drag & drop menu operations', () => {
  it('fast-forwards a branch that is not checked out', async () => {
    await repo.createBranch('old', 'HEAD')
    await commitFile('a.txt', '1\n2\n', 'ahead')
    await repo.fastForward('old', 'main')
    const branches = await repo.branches()
    expect(branches.find((b) => b.name === 'old')!.sha).toBe(branches.find((b) => b.name === 'main')!.sha)
    // Recorded for undo.
    expect(repo.undoLabel()).toBe('Fast-forward old')
  })

  it('refuses a fast-forward that would lose commits', async () => {
    await repo.createBranch('side', 'HEAD', true)
    await commitFile('s.txt', 's\n', 'side only')
    await repo.checkout('main')
    await expect(repo.fastForward('side', 'main')).rejects.toThrow('fast-forward')
  })

  it('reports ancestry', async () => {
    const base = (await repo.log())[0].sha
    await commitFile('a.txt', '1\n2\n', 'next')
    expect(await repo.isAncestor(base, 'main')).toBe(true)
    expect(await repo.isAncestor('main', base)).toBe(false)
  })
})

describe('multi-select commit operations', () => {
  it('squashes consecutive commits with a new message', async () => {
    await commitFile('a.txt', '1\n2\n', 'two')
    await commitFile('a.txt', '1\n2\n3\n', 'three')
    const [three, two, base] = await repo.log()
    const todo = await repo.rebaseTodo(base.sha)
    const items = todo.map((t) =>
      t.sha === two.sha ? { ...t, action: 'reword' as const, message: 'two and three' } : t.sha === three.sha ? { ...t, action: 'fixup' as const } : t
    )
    const r = await repo.interactiveRebase(base.sha, items)
    expect(r.code).toBe(0)
    const log = await repo.log()
    expect(log.map((c) => c.subject)).toEqual(['two and three', 'base'])
    expect(await read('a.txt')).toBe('1\n2\n3\n')
  })

  it('reverts several commits newest first', async () => {
    await commitFile('a.txt', '1\n2\n', 'two')
    await commitFile('a.txt', '1\n2\n3\n', 'three')
    const [three, two] = await repo.log()
    const r = await repo.revertMany([three.sha, two.sha])
    expect(r.code).toBe(0)
    expect(await read('a.txt')).toBe('1\n')
    expect((await repo.log()).slice(0, 2).every((c) => c.subject.startsWith('Revert'))).toBe(true)
  })

  it('compares a commit with the working directory', async () => {
    const base = (await repo.log())[0].sha
    await write('a.txt', '1\nwip\n')
    const files = await repo.compare(base, 'WORKDIR')
    expect(files.map((f) => f.path)).toEqual(['a.txt'])
    const d = await repo.rangeFileDiff(base, 'WORKDIR', 'a.txt')
    expect(d!.hunks[0].lines.some((l) => l.kind === 'add' && l.content === 'wip')).toBe(true)
  })

  it('shows a combined range diff with full context on request', async () => {
    await commitFile('a.txt', '1\n2\n', 'two')
    await commitFile('a.txt', '1\n2\n3\n', 'three')
    const [three, , base] = await repo.log()
    const d = await repo.rangeFileDiff(base.sha, three.sha, 'a.txt', undefined, false, 1_000_000)
    expect(d!.hunks[0].lines.filter((l) => l.kind === 'add').map((l) => l.content)).toEqual(['2', '3'])
  })
})

describe('file and commit panel operations', () => {
  it('restores a file from an older commit', async () => {
    const base = (await repo.log())[0].sha
    await commitFile('a.txt', 'changed\n', 'change')
    await repo.restoreFiles(base, ['a.txt'])
    expect(await read('a.txt')).toBe('1\n')
  })

  it('stashes only the selected paths', async () => {
    await commitFile('b.txt', 'b\n', 'b')
    await write('a.txt', 'a-wip\n')
    await write('b.txt', 'b-wip\n')
    await repo.stashSave('only a', { paths: ['a.txt'] })
    expect(await read('a.txt')).toBe('1\n')
    expect(await read('b.txt')).toBe('b-wip\n')
    expect((await repo.stashes())[0].message).toContain('only a')
  })

  it('creates a patch of working changes', async () => {
    await write('a.txt', '1\nnew\n')
    const patch = await repo.workingPatch(['a.txt'])
    expect(patch).toContain('+new')
  })

  it('amends only the message of HEAD', async () => {
    await write('a.txt', 'staged but not part of amend\n')
    await repo.stage(['a.txt'])
    await repo.amendMessage('better message\n\nbody')
    const [head] = await repo.log()
    expect(head.subject).toBe('better message')
    // The staged change stays staged, not folded into the commit.
    const s = await repo.state()
    expect(s.status.find((e) => e.path === 'a.txt')?.index).toBe('M')
  })

  it('creates a worktree on a new branch', async () => {
    const wt = join(dir, '..', `${dir.split(/[\\/]/).pop()}-wt`)
    try {
      await repo.addWorktreeFrom(wt, 'wt-branch', 'HEAD')
      const list = await repo.worktrees()
      expect(list.map((w) => w.branch)).toContain('wt-branch')
      await repo.lockWorktree(wt, true)
      expect((await repo.worktrees()).find((w) => w.branch === 'wt-branch')!.locked).toBe(true)
      await repo.lockWorktree(wt, false)
      await repo.removeWorktree(wt, true)
    } finally {
      await fs.rm(wt, { recursive: true, force: true })
    }
  })
})
