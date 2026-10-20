// Git actions with their confirmations, shared by context menus, toolbar and sidebar.
import type { Branch, Commit, Ref, Stash, Tag } from '@shared/types'
import { bridge, copy, loadRepo, repoApi, run, shortSha } from './actions'
import { confirm, contextMenu, form, prompt, type MenuItem } from './dialogs'
import { activeRepo, getState, toast } from './store'
import { setUi, toggleRepoList, useUi } from './ui'
import { openInteractiveRebase } from './components/InteractiveRebase'
import { openCreatePullRequest } from './components/PullRequests'

const current = (): Branch | undefined => activeRepo()?.branches.find((b) => b.current)
const currentName = (): string => activeRepo()?.state?.branch ?? 'HEAD'

// ------------------------------------------------------------------ branches

export async function createBranch(startPoint = 'HEAD'): Promise<void> {
  const r = await form('브랜치 만들기', [
    { name: 'name', label: '브랜치 이름', required: true },
    { name: 'checkout', label: '만든 뒤 체크아웃', type: 'checkbox', value: true }
  ])
  if (!r) return
  await run('브랜치 생성', () => repoApi().createBranch(String(r.name).trim(), startPoint, !!r.checkout))
}

export async function checkoutBranch(b: Branch): Promise<void> {
  if (b.current) return
  if (b.remote) await run(`${b.name} 체크아웃`, () => repoApi().checkoutRemote(b.name))
  else await run(`${b.name} 체크아웃`, () => repoApi().checkout(b.name))
}

export async function mergeInto(target: string): Promise<void> {
  const r = await form(`${target} → ${currentName()} 병합`, [
    {
      name: 'mode',
      label: '방식',
      type: 'select',
      value: 'default',
      options: [
        { value: 'default', label: '기본 (가능하면 fast-forward)' },
        { value: 'no-ff', label: '항상 머지 커밋 (--no-ff)' },
        { value: 'ff-only', label: 'fast-forward 만 (--ff-only)' },
        { value: 'squash', label: 'squash (스테이징만, 커밋은 직접)' }
      ]
    }
  ], { okLabel: '병합' })
  if (!r) return
  await run('병합', () => repoApi().merge(target, r.mode as 'default'))
}

export async function rebaseOnto(target: string): Promise<void> {
  if (await confirm('리베이스', `${currentName()} 를 ${target} 위로 리베이스합니다.`, '리베이스')) {
    await run('리베이스', () => repoApi().rebase(target))
  }
}

export async function renameBranch(b: Branch): Promise<void> {
  const name = await prompt('브랜치 이름 변경', '새 이름', b.name)
  if (name && name !== b.name) await run('이름 변경', () => repoApi().renameBranch(b.name, name.trim()))
}

export async function deleteBranch(b: Branch): Promise<void> {
  if (b.remote) {
    const slash = b.name.indexOf('/')
    const remote = b.name.slice(0, slash)
    const name = b.name.slice(slash + 1)
    if (await confirm('원격 브랜치 삭제', `${remote} 에서 ${name} 브랜치를 삭제합니다. 되돌릴 수 없습니다.`, '삭제', true)) {
      await run('원격 브랜치 삭제', () => repoApi().deleteRemoteBranch(remote, name))
    }
    return
  }
  const r = await form('브랜치 삭제', [{ name: 'force', label: '병합되지 않았어도 강제 삭제 (-D)', type: 'checkbox' }], {
    message: `${b.name} 브랜치를 삭제합니다.`,
    okLabel: '삭제',
    danger: true
  })
  if (r) await run('브랜치 삭제', () => repoApi().deleteBranch(b.name, !!r.force))
}

export async function setUpstream(b: Branch): Promise<void> {
  const remotes = activeRepo()?.branches.filter((x) => x.remote) ?? []
  const r = await form(`${b.name} upstream 설정`, [
    {
      name: 'up',
      label: '추적할 원격 브랜치',
      type: 'select',
      value: b.upstream ?? '',
      options: [{ value: '', label: '(없음)' }, ...remotes.map((x) => ({ value: x.name, label: x.name }))]
    }
  ])
  if (r) await run('upstream 설정', () => repoApi().setUpstream(b.name, String(r.up) || null))
}

/** Runs a push; when the remote rejects it as non-fast-forward, offers Pull or Force Push like GitKraken. */
async function pushWithRecovery(opts: Parameters<ReturnType<typeof repoApi>['push']>[0], target: string): Promise<void> {
  const outcome = await run('Push', async () => {
    try {
      await repoApi().push(opts)
      return 'ok'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/rejected|non-fast-forward|fetch first|stale info/i.test(msg)) return 'rejected'
      throw e
    }
  })
  if (outcome === 'ok') toast(`${target} 로 push 했습니다`, 'success')
  if (outcome !== 'rejected') return
  const r = await form(
    'Push 거부됨',
    [
      {
        name: 'action',
        label: '어떻게 할까요?',
        type: 'select',
        value: 'pull',
        options: [
          { value: 'pull', label: 'Pull (가능하면 fast-forward) 후 다시 push' },
          { value: 'lease', label: 'Force Push (with lease) — 원격의 새 커밋을 덮어씀' }
        ]
      }
    ],
    { message: `${target} 에 로컬에 없는 커밋이 있어 push 가 거부됐습니다.`, okLabel: '진행' }
  )
  if (!r) return
  if (r.action === 'pull') {
    const before = activeRepo()?.state?.head
    await pull('merge')
    const after = activeRepo()?.state
    // Retry only when the pull actually brought commits in; a failed pull (network) would loop back here.
    if (after && !after.operation && after.head !== before) await pushWithRecovery(opts, target)
  } else if (await confirm('Force Push', `${target} 를 로컬 브랜치로 덮어씁니다. 원격의 새 커밋은 사라집니다.`, 'Force Push', true)) {
    await run('Force push', () => repoApi().push({ ...opts, force: 'lease' }), { success: 'Force push 완료' })
  }
}

export async function pushBranch(b?: Branch): Promise<void> {
  const branch = b ?? current()
  if (!branch) return toast('현재 브랜치가 없습니다 (detached HEAD)', 'error')
  const remotes = activeRepo()?.remotes ?? []
  if (!remotes.length) return toast('원격 저장소가 없습니다. 사이드바에서 추가하세요.', 'error')
  if (!branch.upstream || branch.gone) {
    const r = await form(
      `${branch.name} 의 원격 브랜치 만들기`,
      [
        { name: 'remote', label: '원격', type: 'select', value: remotes[0].name, options: remotes.map((x) => ({ value: x.name, label: x.name })) },
        { name: 'name', label: '원격 브랜치 이름', value: branch.name, required: true }
      ],
      { message: 'upstream 이 없습니다. 원격에 브랜치를 만들고 추적하도록 설정합니다.', okLabel: 'Push' }
    )
    if (!r) return
    await pushWithRecovery({ remote: String(r.remote), branch: `${branch.name}:${String(r.name).trim()}`, setUpstream: true }, `${r.remote}/${r.name}`)
    return
  }
  const slash = branch.upstream.indexOf('/')
  await pushWithRecovery({ remote: branch.upstream.slice(0, slash), branch: `${branch.name}:${branch.upstream.slice(slash + 1)}` }, branch.upstream)
}

export function branchMenu(b: Branch): MenuItem[] {
  const isCur = b.current
  const cur = currentName()
  const curB = current()
  return [
    { label: b.remote ? `${b.name} 체크아웃 (로컬 브랜치 생성)` : `${b.name} 체크아웃`, onClick: () => checkoutBranch(b), disabled: isCur },
    ...(isCur && b.upstream
      ? [
          { label: `Pull (${b.upstream})`, onClick: () => pull() },
          { label: 'Pull (fast-forward only)', onClick: () => pull('ff-only') }
        ]
      : []),
    ...(b.remote ? [] : [{ label: 'Push', onClick: () => pushBranch(b) }, { label: 'Upstream 설정…', onClick: () => setUpstream(b) }]),
    ...(curB && !isCur ? [{ label: `${cur} 를 ${b.name} 로 fast-forward`, onClick: () => fastForward(cur, b.name) }] : []),
    ...(!b.remote && !isCur && b.upstream && b.behind > 0 && b.ahead === 0
      ? [{ label: `${b.name} 를 ${b.upstream} 로 fast-forward`, onClick: () => fastForward(b.name, b.upstream!) }]
      : []),
    { separator: true, label: '' },
    { label: `${b.name} 를 ${cur} 에 병합`, onClick: () => mergeInto(b.name), disabled: isCur },
    { label: `${cur} 를 ${b.name} 위로 리베이스`, onClick: () => rebaseOnto(b.name), disabled: isCur },
    { label: `${cur} 를 ${b.name} 로 대화형 리베이스…`, onClick: () => openInteractiveRebase(b.name), disabled: isCur },
    { label: `${cur} 를 여기로 reset…`, onClick: () => resetTo(b.name), disabled: isCur || !curB },
    { separator: true, label: '' },
    { label: 'Pull/Merge Request 시작…', onClick: () => openCreatePullRequest(b.remote ? b.name.slice(b.name.indexOf('/') + 1) : b.name) },
    { label: '여기서 브랜치 만들기…', onClick: () => createBranch(b.name) },
    { label: '여기서 worktree 만들기…', onClick: () => createWorktree(b.remote ? undefined : b.name, b.name) },
    { label: '여기에 태그 만들기…', onClick: () => createTag(b.name) },
    { label: '여기에 annotated 태그 만들기…', onClick: () => createTag(b.name, true) },
    { separator: true, label: '' },
    { label: `${cur} 와 비교`, onClick: () => compareWith(b.sha), disabled: isCur },
    { label: '이름 복사', onClick: () => copy(b.name) },
    ...(b.remote ? [] : [{ label: '이름 변경…', onClick: () => renameBranch(b) }]),
    ...refVisibilityItems(b.fullName),
    { separator: true, label: '' },
    { label: `${b.name} 삭제`, onClick: () => deleteBranch(b), disabled: isCur }
  ]
}

export async function pull(mode?: 'merge' | 'rebase' | 'ff-only'): Promise<void> {
  // Toolbar default (unless it is Fetch) wins over the older settings value.
  const pd = useUi.getState().pullDefault
  const m = mode ?? (pd !== 'fetch' ? pd : getState().settings?.defaultPullMode ?? 'merge')
  await run('Pull', () => repoApi().pull(m), { success: 'Pull 완료' })
}

/** Shows two commits compared in the right panel, like a two-commit selection. */
export function compareWith(sha: string): void {
  const head = activeRepo()?.state?.head
  if (head) getState().set({ selection: { kind: 'commits', shas: [sha, head] }, openDiff: null })
}

// ------------------------------------------------------------- solo / hide

export function isHidden(fullName: string): boolean {
  return (useUi.getState().hidden[getState().active ?? ''] ?? []).includes(fullName)
}

export function isSoloed(fullName: string): boolean {
  return (useUi.getState().solo[getState().active ?? ''] ?? []).includes(fullName)
}

export function toggleRef(kind: 'hidden' | 'solo', fullName: string): void {
  const repo = getState().active
  if (!repo) return
  toggleRepoList(kind, repo, fullName)
  void loadRepo(repo)
}

export function setRefList(kind: 'hidden' | 'solo', refs: string[]): void {
  const repo = getState().active
  if (!repo) return
  setUi((s) => ({ [kind]: { ...s[kind], [repo]: refs } }))
  void loadRepo(repo)
}

function refVisibilityItems(fullName: string): MenuItem[] {
  return [
    { separator: true, label: '' },
    { label: isSoloed(fullName) ? 'Solo 해제' : 'Solo (이것만 보기)', onClick: () => toggleRef('solo', fullName) },
    { label: isHidden(fullName) ? '그래프에 다시 보이기' : '그래프에서 숨기기', onClick: () => toggleRef('hidden', fullName) }
  ]
}

export async function fastForward(branch: string, target: string): Promise<void> {
  await run(`${branch} fast-forward`, () => repoApi().fastForward(branch, target), { success: `${branch} 를 ${target} 로 fast-forward 했습니다` })
}

export async function createWorktree(branch?: string, startPoint?: string): Promise<void> {
  const repo = getState().active!
  const branches = activeRepo()?.branches.filter((x) => !x.remote && !x.current) ?? []
  const base = repo.split(/[\\/]/).pop()
  const r = await form(
    'Worktree 만들기',
    [
      { name: 'parent', label: '상위 폴더', value: repo.replace(/[\\/][^\\/]+$/, ''), required: true, type: 'directory' },
      { name: 'dir', label: '폴더 이름', value: `${base}-${(branch ?? 'worktree').replace(/[\\/]/g, '-')}`, required: true },
      {
        name: 'mode',
        label: '브랜치',
        type: 'select',
        value: branch && branches.some((x) => x.name === branch) ? 'existing' : 'new',
        options: [
          { value: 'existing', label: '기존 브랜치 체크아웃' },
          { value: 'new', label: `새 브랜치 만들기 (${startPoint ?? 'HEAD'} 에서)` }
        ]
      },
      { name: 'branch', label: '기존 브랜치', type: 'select', value: branch ?? branches[0]?.name ?? '', options: branches.map((x) => ({ value: x.name, label: x.name })) },
      { name: 'newName', label: '새 브랜치 이름 (새로 만들 때)', value: '' }
    ],
    { okLabel: '만들기' }
  )
  if (!r) return
  const path = `${r.parent}/${r.dir}`
  if (r.mode === 'new') {
    const name = String(r.newName).trim()
    if (!name) return toast('새 브랜치 이름을 입력하세요', 'error')
    await run('Worktree 추가', () => repoApi().addWorktreeFrom(path, name, startPoint ?? 'HEAD'))
  } else await run('Worktree 추가', () => repoApi().addWorktree(path, String(r.branch)))
}

// --------------------------------------------------------------- drag & drop

export interface DragRef {
  name: string
  fullName: string
  type: Ref['type']
  sha: string
}

/** Menu shown when a ref label is dropped onto another ref or a commit, like GitKraken. */
export async function dropMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, src: DragRef, target: DragRef | { sha: string; name?: undefined; type?: undefined; fullName?: undefined }): Promise<void> {
  const data = activeRepo()
  if (!data || src.sha === target.sha && src.fullName === target.fullName) return
  const cur = currentName()
  const curB = current()
  const targetName = target.name ?? shortSha(target.sha)
  const targetIsCurrent = target.type === 'head' && target.name === cur
  const srcIsCurrent = src.type === 'head' && src.name === cur
  const items: MenuItem[] = []
  const ffOk = await repoApi().isAncestor(target.name ?? target.sha, src.name).catch(() => false)

  const ensureCheckout = async (name: string): Promise<boolean> => {
    if (name === currentName()) return true
    if (!(await confirm('체크아웃 필요', `${name} 를 체크아웃한 뒤 진행합니다.`, '체크아웃 후 진행'))) return false
    await run(`${name} 체크아웃`, () => repoApi().checkout(name))
    return currentName() === name
  }

  if (target.type === 'head') {
    if (ffOk) items.push({ label: `${target.name} 를 ${src.name} 로 fast-forward`, onClick: () => fastForward(target.name!, src.name) })
    items.push(
      { label: `${src.name} 를 ${target.name} 에 병합`, onClick: async () => (await ensureCheckout(target.name!)) && mergeInto(src.name) },
      { label: `${target.name} 를 ${src.name} 위로 리베이스`, onClick: async () => (await ensureCheckout(target.name!)) && rebaseOnto(src.name) },
      { label: `${target.name} 를 ${src.name} 로 대화형 리베이스…`, onClick: async () => (await ensureCheckout(target.name!)) && openInteractiveRebase(src.name) }
    )
    if (targetIsCurrent) items.push({ label: `${cur} 를 ${src.name} 로 reset…`, onClick: () => resetTo(src.name) })
    if (srcIsCurrent || src.type === 'head')
      items.push({ separator: true, label: '' }, { label: `${src.name} → ${target.name} Pull/Merge Request 시작…`, onClick: () => openCreatePullRequest(src.name, target.name) })
  } else if (target.type === 'remote' && src.type === 'head') {
    const slash = target.name!.indexOf('/')
    const remote = target.name!.slice(0, slash)
    const rb = target.name!.slice(slash + 1)
    items.push(
      { label: `${src.name} 를 ${target.name} 로 push`, onClick: () => run('Push', () => repoApi().push({ remote, branch: `${src.name}:${rb}` }), { success: 'Push 완료' }) },
      { label: `${src.name} 를 ${target.name} 로 force push (with lease)…`, onClick: async () => {
        if (await confirm('Force push', `${target.name} 를 ${src.name} 로 덮어씁니다.`, 'Force push', true))
          await run('Force push', () => repoApi().push({ remote, branch: `${src.name}:${rb}`, force: 'lease' }), { success: 'Push 완료' })
      } },
      { label: `${src.name} 의 upstream 을 ${target.name} 로 설정`, onClick: () => run('upstream 설정', () => repoApi().setUpstream(src.name, target.name!)) },
      { separator: true, label: '' },
      { label: `${src.name} → ${rb} Pull/Merge Request 시작…`, onClick: () => openCreatePullRequest(src.name, rb) }
    )
  } else {
    // Dropped on a tag, a remote branch from a remote, or a bare commit: act on the current branch.
    if (curB) {
      items.push(
        { label: `${src.name} 를 ${cur} 에 병합`, onClick: () => mergeInto(src.name), disabled: srcIsCurrent },
        { label: `${cur} 를 ${targetName} 위로 리베이스`, onClick: () => rebaseOnto(target.name ?? target.sha) },
        { label: `${cur} 를 ${targetName} 로 reset…`, onClick: () => resetTo(target.name ?? target.sha) }
      )
    }
  }
  if (!items.length) return
  contextMenu(e, items)
}

// ----------------------------------------------------------- multi-select

function isLinear(commits: Commit[]): boolean {
  // Newest first: each commit's first parent must be the next one.
  return commits.every((c, i) => i === commits.length - 1 || (c.parents.length === 1 && c.parents[0] === commits[i + 1].sha))
}

export function multiCommitMenu(commits: Commit[]): MenuItem[] {
  const oldestFirst = [...commits].reverse()
  const hasMerge = commits.some((c) => c.parents.length > 1)
  const squashable = commits.length > 1 && !hasMerge && isLinear(commits) && oldestFirst[0].parents.length === 1
  return [
    {
      label: `${commits.length}개 커밋 cherry-pick`,
      disabled: hasMerge,
      onClick: () => run('Cherry-pick', () => repoApi().cherryPick(oldestFirst.map((c) => c.sha)))
    },
    { label: `${commits.length}개 커밋 squash…`, disabled: !squashable, onClick: () => squashCommits(commits) },
    {
      label: `${commits.length}개 커밋 되돌리기 (Revert)…`,
      disabled: hasMerge,
      onClick: async () => {
        if (await confirm('Revert', `${commits.length}개 커밋을 되돌리는 커밋을 만듭니다 (최신부터).`, 'Revert'))
          await run('Revert', () => repoApi().revertMany(commits.map((c) => c.sha)))
      }
    },
    { separator: true, label: '' },
    {
      label: `${commits.length}개 커밋으로 patch 만들기…`,
      disabled: !isLinear(commits),
      onClick: async () => {
        const dir = await bridge.app.pickDirectory('패치를 저장할 폴더')
        if (dir) await run('Patch 생성', () => repoApi().formatPatch(`${oldestFirst[0].sha}^..${commits[0].sha}`, dir), { success: '패치를 만들었습니다' })
      }
    },
    { label: 'SHA 복사', onClick: () => copy(commits.map((c) => c.sha).join('\n')) }
  ]
}

/** Squashes consecutive commits on the current branch through a scripted interactive rebase. */
export async function squashCommits(commits: Commit[]): Promise<void> {
  const oldest = commits[commits.length - 1]
  const base = oldest.parents[0]
  const todo = await repoApi().rebaseTodo(base)
  const chosen = new Set(commits.map((c) => c.sha))
  const idx = todo.map((t, i) => (chosen.has(t.sha) ? i : -1)).filter((i) => i >= 0)
  if (idx.length !== commits.length || idx[idx.length - 1] - idx[0] !== idx.length - 1)
    return toast('현재 브랜치에 연속으로 있는 커밋만 squash 할 수 있습니다', 'error')
  const r = await form(`${commits.length}개 커밋 squash`, [
    { name: 'message', label: '합쳐진 커밋 메시지', type: 'textarea', value: oldestFirst(commits).map((c) => c.subject).join('\n\n'), required: true }
  ], { okLabel: 'Squash' })
  if (!r) return
  const items = todo.map((t, i) =>
    i === idx[0] ? { ...t, action: 'reword' as const, message: String(r.message) } : i > idx[0] && i <= idx[idx.length - 1] ? { ...t, action: 'fixup' as const } : t
  )
  await run('Squash', () => repoApi().interactiveRebase(base, items))
}

function oldestFirst(commits: Commit[]): Commit[] {
  return [...commits].reverse()
}

// -------------------------------------------------------------------- commits

export async function createTag(target = 'HEAD', annotated = false): Promise<void> {
  const r = await form(annotated ? 'Annotated 태그 만들기' : '태그 만들기', [
    { name: 'name', label: '태그 이름', required: true },
    { name: 'message', label: annotated ? '메시지' : '메시지 (입력하면 annotated 태그)', type: 'textarea', required: annotated },
    { name: 'push', label: '만든 뒤 원격에 push', type: 'checkbox' }
  ])
  if (!r) return
  const name = String(r.name).trim()
  await run('태그 생성', () => repoApi().createTag(name, target, String(r.message).trim() || undefined))
  const remote = activeRepo()?.remotes[0]?.name
  if (r.push && remote) await run('태그 push', () => repoApi().pushTag(remote, name), { success: '태그를 push 했습니다' })
}

export async function resetTo(sha: string): Promise<void> {
  const r = await form(`${currentName()} 를 ${shortSha(sha)} 로 reset`, [
    {
      name: 'mode',
      label: '방식',
      type: 'select',
      value: 'mixed',
      options: [
        { value: 'soft', label: 'Soft — 변경사항을 스테이징에 남김' },
        { value: 'mixed', label: 'Mixed — 변경사항을 작업 디렉터리에 남김' },
        { value: 'hard', label: 'Hard — 모든 변경사항 버림' }
      ]
    }
  ], { okLabel: 'Reset', danger: true })
  if (r) await run('Reset', () => repoApi().reset(sha, r.mode as 'soft'))
}

export function commitMenu(c: Commit): MenuItem[] {
  const merge = c.parents.length > 1
  const cur = currentName()
  const local = (activeRepo()?.refsBySha.get(c.sha) ?? []).filter((r) => r.type === 'head' && r.name !== cur)
  return [
    ...local.map((r) => ({ label: `${r.name} 체크아웃`, onClick: () => run(`${r.name} 체크아웃`, () => repoApi().checkout(r.name)) })),
    { label: '이 커밋 체크아웃 (detached)', onClick: () => run('체크아웃', () => repoApi().checkout(c.sha, { detach: true })) },
    { label: '여기서 브랜치 만들기…', onClick: () => createBranch(c.sha) },
    { label: '여기서 worktree 만들기…', onClick: () => createWorktree(undefined, c.sha) },
    { separator: true, label: '' },
    { label: '커밋 cherry-pick', onClick: () => run('Cherry-pick', () => repoApi().cherryPick([c.sha])), disabled: merge },
    { label: `${cur} 를 여기로 reset…`, onClick: () => resetTo(c.sha) },
    {
      label: '커밋 되돌리기 (Revert)',
      onClick: async () => {
        if (await confirm('Revert', `${shortSha(c.sha)} "${c.subject}" 를 되돌리는 커밋을 만듭니다.`, 'Revert')) {
          await run('Revert', () => repoApi().revert(c.sha, merge ? 1 : undefined))
        }
      }
    },
    { label: `${cur} 를 여기로 리베이스`, onClick: () => rebaseOnto(c.sha) },
    { label: '여기부터 대화형 리베이스…', onClick: () => openInteractiveRebase(c.sha) },
    ...(c.sha === activeRepo()?.state?.head ? [{ label: '커밋 메시지 수정 (amend)…', onClick: () => rewordHead(c) }] : []),
    { separator: true, label: '' },
    { label: '작업 디렉터리와 비교', onClick: () => compareWithWorkdir(c.sha) },
    { label: '현재 브랜치(HEAD)와 비교', onClick: () => compareWith(c.sha) },
    {
      label: '커밋으로 patch 만들기…',
      onClick: async () => {
        const dir = await bridge.app.pickDirectory('패치를 저장할 폴더')
        if (dir) await run('Patch 생성', () => repoApi().formatPatch(`${c.sha}^!`, dir), { success: '패치를 만들었습니다' })
      }
    },
    { separator: true, label: '' },
    { label: '여기에 태그 만들기…', onClick: () => createTag(c.sha) },
    { label: '여기에 annotated 태그 만들기…', onClick: () => createTag(c.sha, true) },
    { separator: true, label: '' },
    { label: 'SHA 복사', onClick: () => copy(c.sha) },
    { label: '짧은 SHA 복사', onClick: () => copy(shortSha(c.sha)) },
    { label: '메시지 복사', onClick: () => copy(c.subject) }
  ]
}

async function rewordHead(c: Commit): Promise<void> {
  const full = await repoApi().lastCommitMessage()
  const r = await form('커밋 메시지 수정', [{ name: 'message', label: '메시지', type: 'textarea', value: full || c.subject, required: true }], { okLabel: '메시지 수정' })
  if (r) await run('메시지 수정', () => repoApi().amendMessage(String(r.message)))
}

/** Lists a commit's tree against the working directory in the right panel. */
export function compareWithWorkdir(sha: string): void {
  getState().set({ selection: { kind: 'commits', shas: ['WORKDIR', sha] }, openDiff: null })
}

// ---------------------------------------------------------------- tags/stash

export function tagMenu(t: Tag): MenuItem[] {
  const remotes = activeRepo()?.remotes ?? []
  return [
    { label: '이 태그 체크아웃 (detached)', onClick: () => run('체크아웃', () => repoApi().checkout(t.name, { detach: true })) },
    { label: '여기서 브랜치 만들기…', onClick: () => createBranch(t.name) },
    { label: `${t.name} 를 ${currentName()} 에 병합`, onClick: () => mergeInto(t.name) },
    { label: `${currentName()} 를 ${t.name} 위로 리베이스`, onClick: () => rebaseOnto(t.name) },
    { label: `${currentName()} 와 비교`, onClick: () => compareWith(t.sha) },
    { separator: true, label: '' },
    ...remotes.map((r) => ({ label: `${r.name} 에 push`, onClick: () => run('태그 push', () => repoApi().pushTag(r.name, t.name), { success: '태그를 push 했습니다' }) })),
    { separator: true, label: '' },
    { label: '이름 복사', onClick: () => copy(t.name) },
    ...refVisibilityItems(`refs/tags/${t.name}`),
    { separator: true, label: '' },
    {
      label: `${t.name} 로컬에서 삭제`,
      onClick: async () => {
        if (await confirm('태그 삭제', `${t.name} 태그를 삭제합니다.`, '삭제', true)) await run('태그 삭제', () => repoApi().deleteTag(t.name))
      }
    },
    ...remotes.map((r) => ({
      label: `${t.name} 를 ${r.name} 에서 삭제`,
      onClick: async () => {
        if (await confirm('원격 태그 삭제', `${r.name} 의 ${t.name} 태그를 삭제합니다.`, '삭제', true)) await run('원격 태그 삭제', () => repoApi().deleteRemoteTag(r.name, t.name))
      }
    }))
  ]
}

export async function stashSave(): Promise<void> {
  const r = await form('Stash', [
    { name: 'message', label: '메시지 (선택)' },
    { name: 'untracked', label: '추적하지 않는 파일 포함', type: 'checkbox', value: true },
    { name: 'keepIndex', label: '스테이징된 변경은 남겨두기 (--keep-index)', type: 'checkbox' }
  ], { okLabel: 'Stash' })
  if (r) await run('Stash', () => repoApi().stashSave(String(r.message).trim() || undefined, { includeUntracked: !!r.untracked, keepIndex: !!r.keepIndex }))
}

export function stashMenu(s: Stash): MenuItem[] {
  return [
    { label: 'Stash 적용 (Apply)', onClick: () => run('Stash apply', () => repoApi().stashApply(s.index)) },
    { label: 'Stash 꺼내기 (Pop)', onClick: () => run('Stash pop', () => repoApi().stashApply(s.index, true)) },
    {
      label: '이 stash 로 브랜치 만들기…',
      onClick: async () => {
        const name = await prompt('Stash 에서 브랜치', '브랜치 이름')
        if (name) await run('Stash 브랜치', () => repoApi().stashBranch(s.index, name.trim()))
      }
    },
    { separator: true, label: '' },
    {
      label: '삭제 (Drop)',
      onClick: async () => {
        if (await confirm('Stash 삭제', `${s.ref} "${s.message}" 를 삭제합니다.`, '삭제', true)) await run('Stash 삭제', () => repoApi().stashDrop(s.index))
      }
    }
  ]
}

export async function popLatestStash(): Promise<void> {
  if (!activeRepo()?.stashes.length) return toast('stash 가 없습니다')
  await run('Stash pop', () => repoApi().stashApply(0, true))
}

export function selectedCommit(): Commit | undefined {
  const sel = getState().selection
  if (sel?.kind !== 'commit') return undefined
  return activeRepo()?.commits.find((c) => c.sha === sel.sha)
}
