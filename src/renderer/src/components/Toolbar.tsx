import type { ReactNode } from 'react'
import { activate, bridge, openRepoPath, refresh, repoApi, run } from '../actions'
import { contextMenu, form, pickFromList, type MenuItem, type PickItem } from '../dialogs'
import { checkoutBranch, createBranch, popLatestStash, pull, pushBranch, stashSave } from '../menus'
import { getState, toast, useStore, type RepoData } from '../store'
import { setUi, useUi } from '../ui'
import { openCommandPalette } from './Palette'
import { openSettings } from './Settings'
import { openClone } from './PullRequests'

type PullDefault = 'fetch' | 'merge' | 'ff-only' | 'rebase'
const PULL_LABEL: Record<PullDefault, string> = {
  fetch: 'Fetch All',
  merge: 'Pull (가능하면 fast-forward)',
  'ff-only': 'Pull (fast-forward만)',
  rebase: 'Pull (rebase)'
}

function Tool({
  icon,
  label,
  onClick,
  disabled,
  title,
  onMenu,
  active
}: {
  icon: string
  label: string
  onClick: (e: React.MouseEvent) => void
  disabled?: boolean
  title?: string
  /** Dropdown menu on the caret (and right-click) */
  onMenu?: (e: React.MouseEvent) => void
  active?: boolean
}): ReactNode {
  const busy = useStore((s) => !!s.busy)
  const labels = useUi((s) => s.showToolbarLabels)
  return (
    <span className={`tool-wrap${onMenu ? ' split' : ''}`} onContextMenu={onMenu}>
      <button className={`tool${active ? ' active' : ''}`} onClick={onClick} disabled={disabled || busy} title={title ?? label}>
        <span className="ico">{icon}</span>
        {labels && <span className="lbl">{label}</span>}
      </button>
      {onMenu && (
        <button className="tool-caret" disabled={busy} onClick={onMenu} title={`${label} 옵션`}>
          ▾
        </button>
      )}
    </span>
  )
}

export async function fetchAll(): Promise<void> {
  await run('Fetch', () => repoApi().fetch({ prune: true }), { success: 'Fetch 완료' })
}

export function runPullDefault(): Promise<void> {
  const d = useUi.getState().pullDefault
  return d === 'fetch' ? fetchAll() : pull(d)
}

function pullMenu(e: React.MouseEvent): void {
  const d = useUi.getState().pullDefault
  const action = (k: PullDefault): (() => Promise<void>) => (k === 'fetch' ? fetchAll : () => pull(k))
  contextMenu(e, [
    ...(Object.keys(PULL_LABEL) as PullDefault[]).map((k) => ({ label: PULL_LABEL[k], onClick: action(k) })),
    { label: 'Fetch tags', onClick: () => run('Fetch', () => repoApi().fetch({ tags: true }), { success: 'Fetch 완료' }) },
    { separator: true, label: '' },
    ...(Object.keys(PULL_LABEL) as PullDefault[]).map((k) => ({
      label: `기본값: ${PULL_LABEL[k]}`,
      checked: d === k,
      onClick: () => setUi({ pullDefault: k })
    }))
  ])
}

async function pushTo(): Promise<void> {
  const data = getState().active ? getState().repos[getState().active!] : undefined
  const cur = data?.branches.find((b) => b.current)
  if (!data || !cur) return toast('현재 브랜치가 없습니다 (detached HEAD)', 'error')
  const remotes = data.remotes
  if (!remotes.length) return toast('원격 저장소가 없습니다', 'error')
  const r = await form(`${cur.name} push`, [
    { name: 'remote', label: '원격', type: 'select', value: remotes[0].name, options: remotes.map((x) => ({ value: x.name, label: x.name })) },
    { name: 'name', label: '원격 브랜치 이름', value: cur.upstream ? cur.upstream.slice(cur.upstream.indexOf('/') + 1) : cur.name, required: true },
    { name: 'upstream', label: 'upstream 으로 설정', type: 'checkbox', value: !cur.upstream },
    {
      name: 'force',
      label: '방식',
      type: 'select',
      value: '',
      options: [
        { value: '', label: '일반 push' },
        { value: 'lease', label: 'Force push (with lease)' },
        { value: 'force', label: 'Force push (무조건 덮어쓰기)' }
      ]
    }
  ], { okLabel: 'Push' })
  if (!r) return
  await run('Push', () =>
    repoApi().push({ remote: String(r.remote), branch: `${cur.name}:${String(r.name).trim()}`, setUpstream: !!r.upstream, force: (r.force || undefined) as 'lease' | undefined }), { success: 'Push 완료' })
}

async function pushTags(): Promise<void> {
  const remotes = getState().active ? getState().repos[getState().active!]?.remotes ?? [] : []
  if (!remotes.length) return
  const r = await form('모든 태그 push', [{ name: 'remote', label: '원격', type: 'select', value: remotes[0].name, options: remotes.map((x) => ({ value: x.name, label: x.name })) }])
  if (r) await run('태그 push', () => repoApi().push({ remote: String(r.remote), tags: true }), { success: '태그 push 완료' })
}

function pushMenu(e: React.MouseEvent): void {
  contextMenu(e, [
    { label: 'Push', onClick: () => pushBranch() },
    { label: '다른 곳으로 push / force push…', onClick: pushTo },
    { label: '모든 태그 push…', onClick: pushTags }
  ])
}

function stashMenuTool(e: React.MouseEvent): void {
  contextMenu(e, [
    { label: 'Stash (추적 안 하는 파일 포함)', onClick: () => run('Stash', () => repoApi().stashSave(undefined, { includeUntracked: true })) },
    { label: '스테이징된 변경만 stash', onClick: () => run('Stash', () => repoApi().stashSave(undefined, { staged: true })) },
    { label: 'Stash (옵션 선택)…', onClick: stashSave }
  ])
}

function popMenuTool(e: React.MouseEvent): void {
  contextMenu(e, [
    { label: '최근 stash 꺼내기 (Pop)', onClick: popLatestStash },
    { label: '최근 stash 적용 (Apply)', onClick: () => run('Stash apply', () => repoApi().stashApply(0)) }
  ])
}

export function openRepoPicker(): void {
  const s = getState()
  const items: PickItem[] = [
    ...s.tabs.map((t) => ({ group: '열린 탭', label: t.split(/[\\/]/).pop()!, detail: t, onPick: () => activate(t) })),
    ...(s.settings?.recentRepos ?? []).filter((p) => !s.tabs.includes(p)).map((p) => ({ group: '최근 연 저장소', label: p.split(/[\\/]/).pop()!, detail: p, onPick: () => openRepoPath(p) })),
    {
      group: '저장소',
      label: '폴더에서 저장소 열기…',
      hint: 'Ctrl+O',
      onPick: async () => {
        const dir = await bridge.app.pickDirectory('저장소 열기')
        if (dir) await openRepoPath(dir)
      }
    },
    { group: '저장소', label: '클론…', hint: 'Ctrl+N', onPick: () => openClone() },
    { group: '저장소', label: '새 저장소 (init)…', hint: 'Ctrl+I', onPick: () => s.set({ active: undefined }) }
  ]
  pickFromList(items, '저장소 이름으로 검색', '저장소 전환')
}

export function openBranchPicker(): void {
  const data = getState().active ? getState().repos[getState().active!] : undefined
  if (!data) return
  const wt = new Set(data.worktrees.slice(1).map((w) => w.branch).filter(Boolean))
  const local = data.branches.filter((b) => !b.remote)
  const localNames = new Set(local.map((b) => b.name))
  const items: PickItem[] = [
    { group: '작업', label: '새 브랜치 만들기…', hint: 'Ctrl+B', onPick: () => createBranch() },
    ...local.map((b) => ({
      group: '로컬 브랜치',
      label: `${b.current ? '✓ ' : ''}${b.name}`,
      detail: wt.has(b.name) ? '다른 worktree 에서 사용 중' : b.subject,
      onPick: () => (wt.has(b.name) ? toast('다른 worktree 에서 체크아웃된 브랜치입니다', 'error') : checkoutBranch(b))
    })),
    ...data.branches
      .filter((b) => b.remote && !b.name.endsWith('/HEAD') && !localNames.has(b.name.slice(b.name.indexOf('/') + 1)))
      .map((b) => ({ group: '원격 브랜치', label: b.name, detail: b.subject, onPick: () => checkoutBranch(b) }))
  ]
  pickFromList(items, '체크아웃할 브랜치 검색', '브랜치 전환')
}

export function Toolbar({ path, data }: { path: string; data: RepoData }): ReactNode {
  const set = useStore((s) => s.set)
  const consoleOpen = useStore((s) => s.consoleOpen)
  const searchOpen = useStore((s) => s.searchOpen)
  const pullDefault = useUi((s) => s.pullDefault)
  const state = data.state
  const name = path.split(/[\\/]/).pop()
  const hasChanges = !!state?.status.length
  const branchLabel = state?.detached ? `detached @ ${state.head?.slice(0, 7)}` : state?.branch ?? '…'

  const moreMenu: MenuItem[] = [
    { label: 'Reflog', onClick: () => set({ overlay: { kind: 'reflog' } }) },
    { label: 'Patch 적용…', onClick: applyPatch },
    { label: '모든 작업 변경으로 patch 만들기…', onClick: patchAll },
    { label: 'Bisect 시작…', onClick: bisectStart },
    { separator: true, label: '' },
    { label: '탐색기에서 열기', hint: 'Alt+O', onClick: () => bridge.app.openInExplorer(path) },
    { label: '새로고침', hint: 'F5', onClick: () => refresh() },
    { separator: true, label: '' },
    { label: '툴바 아이콘 이름 표시', checked: useUi.getState().showToolbarLabels, onClick: () => setUi({ showToolbarLabels: !useUi.getState().showToolbarLabels }) }
  ]

  return (
    <div className="toolbar">
      <div className="breadcrumbs">
        <button className="crumb" title="저장소 전환" onClick={openRepoPicker}>
          <span className="dim" style={{ fontSize: 10 }}>저장소</span>
          <span className="repo-title">{name} ▾</span>
        </button>
        <span className="dim">/</span>
        <button className="crumb" title="브랜치 전환 (체크아웃)" onClick={openBranchPicker}>
          <span className="dim" style={{ fontSize: 10 }}>브랜치{state?.upstream ? ` → ${state.upstream}` : ''}</span>
          <span className="branch-title">⑂ {branchLabel} ▾</span>
        </button>
      </div>
      <div className="tool-sep" />
      <Tool icon="↶" label="Undo" title={data.undo ? `Undo ${data.undo} (Ctrl+Z)` : '되돌릴 작업 없음'} disabled={!data.undo} onClick={() => run('Undo', () => repoApi().undo(), { success: `되돌림: ${data.undo}` })} />
      <Tool icon="↷" label="Redo" title={data.redo ? `Redo ${data.redo} (Ctrl+Y)` : '다시 할 작업 없음'} disabled={!data.redo} onClick={() => run('Redo', () => repoApi().redo(), { success: `다시 실행: ${data.redo}` })} />
      <div className="tool-sep" />
      <Tool
        icon="⇣"
        label={`${pullDefault === 'fetch' ? 'Fetch' : 'Pull'}${state?.behind ? ` ${state.behind}` : ''}`}
        title={`${PULL_LABEL[pullDefault]} (▾ 옵션 · Ctrl+L Fetch)`}
        onClick={runPullDefault}
        onMenu={pullMenu}
      />
      <Tool icon="⇡" label={`Push${state?.ahead ? ` ${state.ahead}` : ''}`} title={state?.upstream ? `Push to ${state.upstream}` : 'Push'} disabled={!!state?.detached} onClick={() => pushBranch()} onMenu={pushMenu} />
      <div className="tool-sep" />
      <Tool icon="⑂" label="Branch" title="브랜치 만들기 (Ctrl+B)" onClick={() => createBranch()} />
      <Tool icon="⊞" label="Stash" disabled={!hasChanges} onClick={() => run('Stash', () => repoApi().stashSave(undefined, { includeUntracked: true }))} onMenu={stashMenuTool} />
      <Tool icon="⊟" label="Pop" title="Pop Stash" disabled={!data.stashes.length} onClick={popLatestStash} onMenu={popMenuTool} />
      <div className="tool-sep" />
      <Tool icon="❯_" label="콘솔" title="git 명령 직접 실행 (Ctrl+`)" active={consoleOpen} onClick={() => set({ consoleOpen: !consoleOpen })} />
      <Tool icon="▣" label="터미널" title="터미널 열기 (Alt+T)" onClick={() => bridge.app.openTerminal(path)} />
      <span className="grow" />
      <Tool icon="⌕" label="검색" title="커밋 검색 (Ctrl+F)" active={searchOpen} onClick={() => set({ searchOpen: !searchOpen })} />
      <Tool icon="✦" label="Actions" title="명령 팔레트 (Ctrl+P)" onClick={() => openCommandPalette()} />
      <Tool icon="⋯" label="더보기" onClick={(e) => contextMenu(e, moreMenu)} />
      <Tool icon="⚙" label="설정" title="설정 (Ctrl+,)" onClick={openSettings} />
    </div>
  )
}

export async function applyPatch(): Promise<void> {
  const file = await bridge.app.pickFile('적용할 patch 파일')
  if (!file) return
  const r = await form('Patch 적용', [
    {
      name: 'mode',
      label: '방식',
      type: 'select',
      value: 'apply',
      options: [
        { value: 'apply', label: '작업 디렉터리에 적용 (git apply)' },
        { value: 'am', label: '커밋으로 적용 (git am)' }
      ]
    }
  ])
  if (r) await run('Patch 적용', () => repoApi().applyPatch(file, r.mode === 'am'), { success: 'Patch 를 적용했습니다' })
}

export async function patchAll(): Promise<void> {
  const patch = await repoApi().workingPatch()
  if (!patch.trim()) return toast('patch 로 만들 변경이 없습니다')
  const saved = await bridge.app.saveText('Patch 저장', 'changes.patch', patch)
  if (saved) toast(`저장했습니다: ${saved}`, 'success')
}

export async function bisectStart(): Promise<void> {
  const r = await form('Bisect 시작', [
    { name: 'bad', label: '버그가 있는 커밋 (비우면 HEAD)' },
    { name: 'good', label: '정상이었던 커밋 (SHA, 태그, 브랜치)', required: true }
  ], { message: '시작 후 상단 배너의 Good / Bad / Skip 버튼으로 진행합니다.', okLabel: '시작' })
  if (!r) return
  await run('Bisect', async () => {
    await repoApi().bisect('start')
    await repoApi().bisect('bad', String(r.bad).trim() || undefined)
    return repoApi().bisect('good', String(r.good).trim())
  })
}
