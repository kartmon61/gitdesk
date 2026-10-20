import { useMemo, useState, type ReactNode } from 'react'
import type { Branch } from '@shared/types'
import { bridge, copy, openRepoPath, repoApi, run } from '../actions'
import { confirm, contextMenu, form, prompt, type MenuItem } from '../dialogs'
import { branchMenu, checkoutBranch, createWorktree, dropMenu, setRefList, stashMenu, tagMenu, toggleRef, type DragRef } from '../menus'
import { getState, useStore, type RepoData } from '../store'
import { dragResize, setUi, toggleCollapsed, useUi } from '../ui'
import { PullRequestSection } from './PullRequests'

const NONE: string[] = []

export const REF_DRAG = 'application/x-gitdesk-ref'

function Section({
  id,
  title,
  count,
  children,
  actions,
  onMenu
}: {
  id: string
  title: string
  count?: number
  children: ReactNode
  actions?: ReactNode
  onMenu?: (e: React.MouseEvent) => void
}): ReactNode {
  const closed = useUi((s) => !!s.collapsed[id])
  return (
    <div className="section">
      <div className="section-head" onClick={() => toggleCollapsed(id)} onContextMenu={onMenu}>
        <span>{closed ? '▸' : '▾'}</span>
        <span className="grow">
          {title}
          {count !== undefined && <span className="dim"> {count}</span>}
        </span>
        <span className="section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </div>
      {!closed && children}
    </div>
  )
}

interface Node {
  name: string
  path: string
  children: Map<string, Node>
  branch?: Branch
}

/** Groups branch names on "/" into folders, like GitKraken's left panel. */
function branchTree(branches: Branch[], strip = 0): Node {
  const root: Node = { name: '', path: '', children: new Map() }
  for (const b of branches) {
    const parts = b.name.split('/').slice(strip)
    let node = root
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1
      const key = leaf ? `\0${part}` : part
      if (!node.children.has(key)) node.children.set(key, { name: part, path: node.path ? `${node.path}/${part}` : part, children: new Map() })
      node = node.children.get(key)!
      if (leaf) node.branch = b
    })
  }
  return root
}

function leaves(n: Node): Branch[] {
  return [...(n.branch ? [n.branch] : []), ...[...n.children.values()].flatMap(leaves)]
}

function toDrag(b: Branch): DragRef {
  return { name: b.name, fullName: b.fullName, type: b.remote ? 'remote' : 'head', sha: b.sha }
}

function VisibilityIcons({ fullName }: { fullName: string }): ReactNode {
  const repo = getState().active ?? ''
  const hidden = useUi((s) => (s.hidden[repo] ?? []).includes(fullName))
  const soloed = useUi((s) => (s.solo[repo] ?? []).includes(fullName))
  return (
    <span className={`vis-icons${hidden || soloed ? ' pinned' : ''}`} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`icon-btn${soloed ? ' solo-on' : ''}`} title={soloed ? 'Solo 해제' : '이 브랜치만 보기 (Solo)'} onClick={() => toggleRef('solo', fullName)}>
        ◎
      </button>
      <button className={`icon-btn${hidden ? ' hidden-on' : ''}`} title={hidden ? '그래프에 보이기' : '그래프에서 숨기기'} onClick={() => toggleRef('hidden', fullName)}>
        {hidden ? '⊘' : '👁'}
      </button>
    </span>
  )
}

export function Sidebar({ path, data }: { path: string; data: RepoData }): ReactNode {
  const filter = useStore((s) => s.sidebarFilter)
  const set = useStore((s) => s.set)
  const selection = useStore((s) => s.selection)
  const width = useUi((s) => s.sidebarWidth)
  const leftOpen = useStore((s) => s.leftOpen)
  const collapsed = useUi((s) => s.collapsed)
  const hiddenRefs = useUi((s) => s.hidden[path]) ?? NONE
  const soloRefs = useUi((s) => s.solo[path]) ?? NONE
  const [multi, setMulti] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)

  const f = filter.toLowerCase().replace(':', '/')
  const match = (name: string): boolean => !f || name.toLowerCase().includes(f)
  const local = data.branches.filter((b) => !b.remote && match(b.name))
  const remoteBranches = data.branches.filter((b) => b.remote && !b.name.endsWith('/HEAD') && match(b.name))
  const tags = data.tags.filter((t) => match(t.name))
  const stashes = data.stashes.filter((s) => match(s.message))
  const submodules = data.submodules.filter((s) => match(s.path))
  const worktrees = data.worktrees.filter((w) => match(w.branch ?? w.path))
  const localTree = useMemo(() => branchTree(local), [local])
  // Shift-range follows the rows as drawn (folders first, collapsed folders skipped).
  const localOrder = useMemo(() => {
    const out: string[] = []
    const walk = (n: Node): void => {
      const kids = [...n.children.values()].sort((a, b) => Number(!!a.branch) - Number(!!b.branch) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      for (const k of kids) {
        if (k.branch) out.push(k.branch.fullName)
        else if (!collapsed[`folder:local:${k.path}`] || f) walk(k)
      }
    }
    walk(localTree)
    return out
  }, [localTree, collapsed, f])

  const select = (sha: string): void => set({ selection: { kind: 'commit', sha }, openDiff: null })

  const clickBranch = (b: Branch, e: React.MouseEvent): void => {
    if (!b.remote && (e.ctrlKey || e.metaKey)) {
      const next = new Set(multi)
      if (next.has(b.fullName)) next.delete(b.fullName)
      else next.add(b.fullName)
      setAnchor(b.fullName)
      return setMulti(next)
    }
    if (!b.remote && e.shiftKey && anchor) {
      const [x, y] = [localOrder.indexOf(anchor), localOrder.indexOf(b.fullName)].sort((p, q) => p - q)
      if (x >= 0 && y >= 0) return setMulti(new Set(localOrder.slice(x, y + 1)))
    }
    setAnchor(b.fullName)
    setMulti(new Set())
    select(b.sha)
  }

  const multiMenu = (names: string[]): MenuItem[] => {
    const branches = data.branches.filter((b) => names.includes(b.fullName))
    const deletable = branches.filter((b) => !b.current)
    return [
      {
        label: `로컬 브랜치 ${deletable.length}개 삭제…`,
        disabled: !deletable.length,
        onClick: async () => {
          const r = await form('브랜치 삭제', [{ name: 'force', label: '병합되지 않았어도 강제 삭제 (-D)', type: 'checkbox' }], {
            message: deletable.map((b) => b.name).join('\n'),
            okLabel: `${deletable.length}개 삭제`,
            danger: true
          })
          if (r)
            await run('브랜치 삭제', async () => {
              for (const b of deletable) await repoApi().deleteBranch(b.name, !!r.force)
            })
          setMulti(new Set())
        }
      },
      { label: `${names.length}개 그래프에서 숨기기`, onClick: () => setRefList('hidden', [...new Set([...hiddenRefs, ...names])]) },
      { label: `${names.length}개 그래프에 보이기`, onClick: () => setRefList('hidden', hiddenRefs.filter((r) => !names.includes(r))) },
      { label: `${names.length}개만 보기 (Solo)`, onClick: () => setRefList('solo', names) }
    ]
  }

  const branchRow = (b: Branch, depth: number, label: string): ReactNode => {
    const hidden = hiddenRefs.includes(b.fullName)
    const cls = ['item', 'branch-item']
    if (b.current) cls.push('current')
    if (multi.has(b.fullName)) cls.push('active')
    if (hidden) cls.push('is-hidden')
    return (
      <div
        key={b.fullName}
        className={cls.join(' ')}
        style={{ paddingLeft: 14 + depth * 12 }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData(REF_DRAG, JSON.stringify(toDrag(b)))}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(REF_DRAG)) {
            e.preventDefault()
            e.currentTarget.classList.add('drop-target')
          }
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('drop-target')
          try {
            void dropMenu(e, JSON.parse(e.dataTransfer.getData(REF_DRAG)) as DragRef, toDrag(b))
          } catch {
            /* not a ref */
          }
        }}
        onClick={(e) => clickBranch(b, e)}
        onDoubleClick={(e) => !e.ctrlKey && !e.shiftKey && checkoutBranch(b)}
        onContextMenu={(e) => contextMenu(e, multi.size > 1 && multi.has(b.fullName) ? multiMenu([...multi]) : branchMenu(b))}
        title={`${b.name}${b.upstream ? ` → ${b.upstream}` : ''}\n${b.subject}\n\n더블클릭: 체크아웃 · 끌어서 다른 브랜치에 놓기: 병합/리베이스`}
      >
        <span className="branch-icon">{b.current ? '✓' : b.remote ? '☁' : '⑂'}</span>
        <span className="ellipsis grow">{label}</span>
        {!b.remote && (b.gone || b.ahead > 0 || b.behind > 0) && (
          <span className="badge">{b.gone ? '⚠ upstream 없음' : `${b.ahead ? `↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''}`}</span>
        )}
        <VisibilityIcons fullName={b.fullName} />
      </div>
    )
  }

  const treeRows = (n: Node, depth: number, id: string): ReactNode[] => {
    const out: ReactNode[] = []
    const kids = [...n.children.values()].sort((a, b) => Number(!!a.branch) - Number(!!b.branch) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const k of kids) {
      if (k.branch) {
        out.push(branchRow(k.branch, depth, k.name))
        continue
      }
      const key = `folder:${id}:${k.path}`
      const closed = !!collapsed[key] && !f
      const inside = leaves(k)
      out.push(
        <div
          key={key}
          className="item folder-item"
          style={{ paddingLeft: 14 + depth * 12 }}
          onClick={() => toggleCollapsed(key)}
          onContextMenu={(e) =>
            contextMenu(e, [
              ...(id === 'local' ? multiMenu(inside.map((b) => b.fullName)) : []),
              ...(id !== 'local'
                ? [
                    { label: `${inside.length}개 그래프에서 숨기기`, onClick: () => setRefList('hidden', [...new Set([...hiddenRefs, ...inside.map((b) => b.fullName)])]) },
                    { label: `${inside.length}개 그래프에 보이기`, onClick: () => setRefList('hidden', hiddenRefs.filter((r) => !inside.some((b) => b.fullName === r))) }
                  ]
                : [])
            ])
          }
        >
          <span className="dim">{closed ? '▸' : '▾'}</span>
          <span className="ellipsis grow">📁 {k.name}</span>
          <span className="dim" style={{ fontSize: 11 }}>
            {inside.length}
          </span>
        </div>
      )
      if (!closed) out.push(...treeRows(k, depth + 1, id))
    }
    return out
  }

  const allOf = (kind: 'local' | 'remote' | 'tags'): string[] =>
    kind === 'tags' ? data.tags.map((t) => `refs/tags/${t.name}`) : data.branches.filter((b) => b.remote === (kind === 'remote')).map((b) => b.fullName)
  const sectionMenu = (kind: 'local' | 'remote' | 'tags', label: string) => (e: React.MouseEvent) =>
    contextMenu(e, [
      { label: `${label} 모두 숨기기`, onClick: () => setRefList('hidden', [...new Set([...hiddenRefs, ...allOf(kind)])]) },
      { label: `${label} 모두 보이기`, onClick: () => setRefList('hidden', hiddenRefs.filter((r) => !allOf(kind).includes(r))) }
    ])

  if (!leftOpen) return null

  return (
    // The resize handle sits outside the scrolling list so it spans the full height and never scrolls away.
    <div className="sidebar-wrap" style={{ width }}>
      <div className="panel-resize right" onMouseDown={(e) => dragResize(e, width, (w) => setUi({ sidebarWidth: w }), 180, 600)} />
      <div className="sidebar">
        <div className="filter-row">
          <input
            id="sidebar-filter"
            className="filter-box"
            placeholder="필터 (Ctrl+Alt+F)"
            value={filter}
            onChange={(e) => set({ sidebarFilter: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && set({ sidebarFilter: '' })}
          />
          {filter && (
            <button className="icon-btn clear-filter" title="필터 지우기" onClick={() => set({ sidebarFilter: '' })}>
              ✕
            </button>
          )}
        </div>
        {(soloRefs.length > 0 || hiddenRefs.length > 0) && (
          <div className="status-chips">
            {soloRefs.length > 0 && (
              <span className="chip solo">
                Solo {soloRefs.length}
                <button className="icon-btn" title="Solo 해제" onClick={() => setRefList('solo', [])}>
                  ✕
                </button>
              </span>
            )}
            {hiddenRefs.length > 0 && (
              <span className="chip">
                숨김 {hiddenRefs.length}
                <button className="icon-btn" title="모두 보이기" onClick={() => setRefList('hidden', [])}>
                  모두 보기
                </button>
              </span>
            )}
          </div>
        )}

        <Section id="local" title="로컬" count={local.length} onMenu={sectionMenu('local', '로컬 브랜치')}>
          {treeRows(localTree, 0, 'local')}
        </Section>

        <Section
          id="remote"
          title="원격"
          count={data.remotes.length}
          onMenu={sectionMenu('remote', '원격 브랜치')}
          actions={
            <button
              className="icon-btn"
              title="원격 추가"
              onClick={async () => {
                const r = await form('원격 추가', [
                  { name: 'name', label: '이름', value: data.remotes.length ? '' : 'origin', required: true },
                  { name: 'url', label: 'Pull(fetch) URL', required: true },
                  { name: 'push', label: 'Push URL (다르면 입력)' }
                ])
                if (!r) return
                const name = String(r.name).trim()
                await run('원격 추가', async () => {
                  await repoApi().addRemote(name, String(r.url).trim())
                  if (String(r.push).trim()) await repoApi().setRemoteUrl(name, String(r.push).trim(), true)
                  await repoApi().fetch({ remote: name })
                })
              }}
            >
              +
            </button>
          }
        >
          {data.remotes.map((r) => {
            const key = `remote:${r.name}`
            const closed = !!collapsed[key] && !f
            const mine = remoteBranches.filter((b) => b.name.startsWith(`${r.name}/`))
            const all = data.branches.filter((b) => b.remote && b.name.startsWith(`${r.name}/`)).map((b) => b.fullName)
            return (
              <div key={r.name}>
                <div
                  className="item remote-item"
                  title={`${r.fetchUrl}${r.pushUrl && r.pushUrl !== r.fetchUrl ? `\npush: ${r.pushUrl}` : ''}`}
                  onClick={() => toggleCollapsed(key)}
                  onContextMenu={(e) =>
                    contextMenu(e, [
                      { label: `${r.name} fetch`, onClick: () => run('Fetch', () => repoApi().fetch({ remote: r.name, prune: true }), { success: 'Fetch 완료' }) },
                      {
                        label: `${r.name} 편집…`,
                        onClick: async () => {
                          const v = await form(`${r.name} 편집`, [
                            { name: 'name', label: '이름', value: r.name, required: true },
                            { name: 'url', label: 'Pull(fetch) URL', value: r.fetchUrl, required: true },
                            { name: 'push', label: 'Push URL', value: r.pushUrl || r.fetchUrl }
                          ])
                          if (!v) return
                          await run('원격 편집', async () => {
                            if (String(v.url).trim() !== r.fetchUrl) await repoApi().setRemoteUrl(r.name, String(v.url).trim())
                            if (String(v.push).trim() && String(v.push).trim() !== (r.pushUrl || r.fetchUrl)) await repoApi().setRemoteUrl(r.name, String(v.push).trim(), true)
                            if (String(v.name).trim() !== r.name) await repoApi().renameRemote(r.name, String(v.name).trim())
                          })
                        }
                      },
                      { label: 'URL 복사', onClick: () => copy(r.fetchUrl) },
                      { separator: true, label: '' },
                      { label: `${r.name} 브랜치 모두 숨기기`, onClick: () => setRefList('hidden', [...new Set([...hiddenRefs, ...all])]) },
                      { label: `${r.name} 브랜치 모두 보이기`, onClick: () => setRefList('hidden', hiddenRefs.filter((x) => !all.includes(x))) },
                      { label: `${r.name} 만 보기 (Solo)`, onClick: () => setRefList('solo', all) },
                      { separator: true, label: '' },
                      {
                        label: `${r.name} 삭제`,
                        onClick: async () => {
                          if (await confirm('원격 삭제', `${r.name} 원격과 그 추적 브랜치를 로컬에서 지웁니다.`, '삭제', true)) await run('원격 삭제', () => repoApi().removeRemote(r.name))
                        }
                      }
                    ])
                  }
                >
                  <span className="dim">{closed ? '▸' : '▾'}</span>
                  <span className="grow ellipsis">☁ {r.name}</span>
                  <span className="dim" style={{ fontSize: 11 }}>
                    {mine.length}
                  </span>
                </div>
                {!closed && treeRows(branchTree(mine, 1), 1, `remote-${r.name}`)}
              </div>
            )
          })}
        </Section>

        <Section id="prs" title="Pull / Merge Requests">
          <PullRequestSection path={path} />
        </Section>

        <Section id="tags" title="태그" count={tags.length} onMenu={sectionMenu('tags', '태그')}>
          {tags.map((t) => (
            <div
              key={t.name}
              className={`item branch-item${hiddenRefs.includes(`refs/tags/${t.name}`) ? ' is-hidden' : ''}`}
              title={`${t.name}${t.message ? `\n${t.message}` : ''}\n더블클릭: 커밋으로 이동`}
              onClick={() => select(t.sha)}
              onDoubleClick={() => select(t.sha)}
              onContextMenu={(e) => contextMenu(e, tagMenu(t))}
            >
              <span className="branch-icon">🏷</span>
              <span className="ellipsis grow">{t.name}</span>
              <VisibilityIcons fullName={`refs/tags/${t.name}`} />
            </div>
          ))}
        </Section>

        <Section id="stashes" title="Stash" count={stashes.length}>
          {stashes.map((s) => (
            <div
              key={s.ref}
              className={`item${selection?.kind === 'stash' && selection.index === s.index ? ' active' : ''}`}
              title={`${s.ref}\n${s.message}\n더블클릭: 적용 (apply)`}
              onClick={() => set({ selection: { kind: 'stash', index: s.index }, openDiff: null })}
              onDoubleClick={() => run('Stash apply', () => repoApi().stashApply(s.index))}
              onContextMenu={(e) => contextMenu(e, stashMenu(s))}
            >
              <span className="branch-icon">≡</span>
              <span className="ellipsis grow">{s.message}</span>
            </div>
          ))}
        </Section>

        <Section
          id="submodules"
          title="Submodule"
          count={submodules.length}
          actions={
            <button
              className="icon-btn"
              title="submodule 추가"
              onClick={async () => {
                const r = await form('Submodule 추가', [
                  { name: 'url', label: 'URL', required: true },
                  { name: 'path', label: '저장소 안 경로', required: true, placeholder: 'libs/name' }
                ])
                if (r) await run('Submodule 추가', () => repoApi().addSubmodule(String(r.url).trim(), String(r.path).trim()))
              }}
            >
              +
            </button>
          }
        >
          {submodules.map((s) => (
            <div
              key={s.path}
              className="item"
              title={`${s.sha} ${s.describe}\n더블클릭: 새 탭에서 열기`}
              onDoubleClick={() => s.state !== '-' && openRepoPath(`${path}/${s.path}`)}
              onContextMenu={(e) =>
                contextMenu(e, [
                  { label: '이 submodule 열기 (새 탭)', onClick: () => openRepoPath(`${path}/${s.path}`), disabled: s.state === '-' },
                  { label: `${s.path} 초기화 (init)`, onClick: () => run('Submodule init', () => repoApi().submoduleUpdate(s.path, true)) },
                  { label: `${s.path} 업데이트`, onClick: () => run('Submodule update', () => repoApi().submoduleUpdate(s.path, false)), disabled: s.state === '-' },
                  { label: '탐색기에서 열기', onClick: () => bridge.app.openInExplorer(`${path}/${s.path}`) },
                  { label: '경로 복사', onClick: () => copy(s.path) }
                ])
              }
            >
              <span className="branch-icon">{s.state === '-' ? '○' : s.state === '+' ? '●' : '◉'}</span>
              <span className="ellipsis grow">{s.path}</span>
              <span className="badge">{s.state === '-' ? '미초기화' : s.state === '+' ? '변경됨' : ''}</span>
            </div>
          ))}
          {submodules.length > 0 && (
            <div className="item dim" onClick={() => run('Submodule update', () => repoApi().submoduleUpdate())}>
              ↻ 모두 업데이트
            </div>
          )}
        </Section>

        <Section
          id="worktrees"
          title="Worktree"
          count={worktrees.length}
          actions={
            <button className="icon-btn" title="worktree 추가" onClick={() => createWorktree()}>
              +
            </button>
          }
        >
          {worktrees.map((w, i) => (
            <div
              key={w.path}
              className="item"
              title={`${w.path}${w.locked ? '\n(잠김)' : ''}\n더블클릭: 새 탭에서 열기`}
              onDoubleClick={() => openRepoPath(w.path)}
              onContextMenu={(e) =>
                contextMenu(e, [
                  { label: '이 worktree 열기 (새 탭)', onClick: () => openRepoPath(w.path) },
                  { label: '탐색기에서 열기', onClick: () => bridge.app.openInExplorer(w.path) },
                  { label: '경로 복사', onClick: () => copy(w.path) },
                  { separator: true, label: '' },
                  { label: w.locked ? '잠금 해제' : '잠그기', disabled: i === 0, onClick: () => run('Worktree 잠금', () => repoApi().lockWorktree(w.path, !w.locked)) },
                  {
                    label: '이 worktree 삭제',
                    disabled: i === 0,
                    onClick: async () => {
                      const r = await form('Worktree 삭제', [{ name: 'force', label: '변경이 남아 있어도 강제로 삭제', type: 'checkbox' }], { message: w.path, okLabel: '삭제', danger: true })
                      if (r) await run('Worktree 삭제', () => repoApi().removeWorktree(w.path, !!r.force))
                    }
                  },
                  {
                    label: 'worktree 와 브랜치 함께 삭제',
                    disabled: i === 0 || !w.branch,
                    onClick: async () => {
                      if (!(await confirm('Worktree·브랜치 삭제', `${w.path}\n브랜치 ${w.branch} 도 삭제합니다.`, '삭제', true))) return
                      await run('Worktree 삭제', async () => {
                        await repoApi().removeWorktree(w.path, true)
                        await repoApi().deleteBranch(w.branch!, true)
                      })
                    }
                  },
                  { separator: true, label: '' },
                  { label: 'Worktree 정리 (prune)', onClick: () => run('Worktree prune', () => repoApi().console('worktree prune')) }
                ])
              }
            >
              <span className="branch-icon">{w.locked ? '🔒' : '⧉'}</span>
              <span className="ellipsis grow">
                {w.branch ?? (w.detached ? `(detached ${w.sha.slice(0, 7)})` : w.path)}
                {i === 0 ? ' (메인)' : ''}
              </span>
            </div>
          ))}
        </Section>

        {data.lfs && (
          <Section id="lfs" title="Git LFS">
            <div className="item" onClick={() => run('LFS pull', () => repoApi().lfs(['pull']))}>
              ↓ 모든 LFS 파일 pull
            </div>
            <div className="item" onClick={() => run('LFS fetch', () => repoApi().lfs(['fetch']))}>
              ↓ 모든 LFS 파일 fetch
            </div>
            <div className="item" onClick={() => run('LFS push', () => repoApi().lfs(['push', '--all', 'origin']))}>
              ↑ 모든 LFS 파일 push
            </div>
            <div className="item" onClick={() => run('LFS prune', () => repoApi().lfs(['prune']))}>
              ✂ 로컬 LFS 정리 (prune)
            </div>
            <div
              className="item"
              onClick={async () => {
                const pattern = await prompt('LFS track', '패턴 (예: *.psd)')
                if (pattern) await run('LFS track', () => repoApi().lfs(['track', pattern]))
              }}
            >
              + track 패턴 추가
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

