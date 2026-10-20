import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GraphRow } from '@shared/graph'
import type { Commit, Ref } from '@shared/types'
import { formatDate, loadMore, repoApi, run, shortSha } from '../actions'
import { contextMenu, type MenuItem } from '../dialogs'
import { branchMenu, commitMenu, dropMenu, multiCommitMenu, setRefList, stashSave, tagMenu, type DragRef } from '../menus'
import { search } from '../search/client'
import { activeRepo, getState, useStore, type RepoData } from '../store'
import { dragResize, setColumn, setUi, useUi, type GraphColumn } from '../ui'

const ROW = 28
const LANE = 14
const MAX_LANES = 24
const COLORS = ['#3fa7f5', '#4cc38a', '#e5c07b', '#c678dd', '#f0616d', '#56b6c2', '#e78a4e', '#98c379', '#d19a66', '#61afef']
const color = (i: number): string => COLORS[i % COLORS.length]
const NONE: string[] = []
const MIN_MESSAGE = 180
const DRAG_TYPE = 'application/x-gitdesk-ref'

/** Left inset so the HEAD ring (r 8.5 + stroke) is not clipped by the cell edge. */
const PAD = 4
const laneX = (lane: number): number => PAD + Math.min(lane, MAX_LANES - 1) * LANE + LANE / 2

function edgePath(fromX: number, y1: number, toX: number, y2: number): string {
  if (fromX === toX) return `M${fromX} ${y1}L${toX} ${y2}`
  const my = (y1 + y2) / 2
  return `M${fromX} ${y1}C${fromX} ${my} ${toX} ${my} ${toX} ${y2}`
}

const COLUMN_LABEL: Record<GraphColumn, string> = {
  refs: '브랜치 / 태그',
  graph: '그래프',
  message: '커밋 메시지',
  author: '작성자',
  date: '날짜 / 시간',
  sha: 'SHA'
}

/** Stable color for an author's initials avatar. */
function avatarColor(email: string): string {
  let h = 0
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 45% 42%)`
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase()
}

const GraphCell = memo(function GraphCell({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const cx = laneX(row.lane)
  return (
    <svg width={width} height={ROW} style={{ flexShrink: 0, overflow: 'visible' }}>
      {row.up.map((e, i) => (
        <path key={`u${i}`} d={edgePath(laneX(e.from), 0, laneX(e.to), ROW / 2)} stroke={color(e.color)} strokeWidth={2} fill="none" />
      ))}
      {row.down.map((e, i) => (
        <path key={`d${i}`} d={edgePath(laneX(e.from), ROW / 2, laneX(e.to), ROW)} stroke={color(e.color)} strokeWidth={2} fill="none" />
      ))}
      <circle cx={cx} cy={ROW / 2} r={row.merge ? 4 : 5.5} fill={row.merge ? 'var(--bg)' : color(row.color)} stroke={color(row.color)} strokeWidth={2} />
      {head && <circle cx={cx} cy={ROW / 2} r={8.5} fill="none" stroke="#fff" strokeWidth={1.5} />}
    </svg>
  )
})

function toDrag(r: Ref): DragRef {
  return { name: r.name, fullName: r.fullName, type: r.type, sha: r.sha }
}

function readDrag(e: React.DragEvent): DragRef | null {
  try {
    return JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragRef
  } catch {
    return null
  }
}

function refMenu(r: Ref, data: RepoData): MenuItem[] | null {
  if (r.type === 'tag') {
    const t = data.tags.find((x) => x.name === r.name)
    return t ? tagMenu(t) : null
  }
  const b = data.branches.find((x) => x.fullName === r.fullName)
  return b ? branchMenu(b) : null
}

export function checkoutRef(r: Ref): void {
  const cur = activeRepo()?.state?.branch
  if (r.type === 'head' && r.name !== cur) void run(`${r.name} 체크아웃`, () => repoApi().checkout(r.name))
  else if (r.type === 'remote') void run(`${r.name} 체크아웃`, () => repoApi().checkoutRemote(r.name))
}

function RefBadges({ refs, currentBranch, data }: { refs: Ref[]; currentBranch?: string; data: RepoData }): ReactNode {
  // Local branches first (current one leading), then remotes, then tags.
  const order = { head: 0, remote: 1, tag: 2 }
  const sorted = [...refs].sort((a, b) => order[a.type] - order[b.type] || Number(b.name === currentBranch) - Number(a.name === currentBranch))
  // A local branch and its same-named remote share one badge, like GitKraken.
  const localNames = new Set(sorted.filter((r) => r.type === 'head').map((r) => r.name))
  const shown = sorted.filter((r) => !(r.type === 'remote' && localNames.has(r.name.slice(r.name.indexOf('/') + 1))))
  return (
    <div className="cell-refs" title={sorted.map((r) => r.name).join('\n')}>
      {shown.map((r) => {
        const isCurrent = r.type === 'head' && r.name === currentBranch
        const remoteTwin = r.type === 'head' && sorted.some((x) => x.type === 'remote' && x.name.endsWith(`/${r.name}`))
        return (
          <span
            key={r.fullName}
            className={`ref ${r.type}${isCurrent ? ' current' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(toDrag(r)))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.classList.add('drop-target')
              }
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              e.currentTarget.classList.remove('drop-target')
              const src = readDrag(e)
              if (src) void dropMenu(e, src, toDrag(r))
            }}
            onContextMenu={(e) => {
              const items = refMenu(r, data)
              if (items) contextMenu(e, items)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              checkoutRef(r)
            }}
          >
            {isCurrent ? '✓ ' : r.type === 'tag' ? '🏷 ' : ''}
            {r.name}
            {remoteTwin && <span className="ref-cloud" title="원격에도 있음"> ☁</span>}
          </span>
        )
      })}
    </div>
  )
}

function SearchBar({ path, data, onMatches }: { path: string; data: RepoData; onMatches: (rows: number[]) => void }): ReactNode {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<number[]>([])
  const [pos, setPos] = useState(-1)
  const set = useStore((s) => s.set)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const t = setTimeout(async () => {
      const rows = query.trim() ? await search(path, query) : []
      if (rows === null) return
      setMatches(rows)
      onMatches(rows)
      // The first Enter goes to the first match rather than skipping it.
      setPos(-1)
    }, 150)
    return () => clearTimeout(t)
    // Re-run when history changes so results follow new commits.
  }, [query, path, data.commits, onMatches])

  const go = (delta: number): void => {
    if (!matches.length) return
    // Cycles past either end, like GitKraken's next/previous search result.
    const next = pos < 0 ? 0 : (pos + delta + matches.length) % matches.length
    setPos(next)
    set({ selection: { kind: 'commit', sha: data.commits[matches[next]].sha } })
  }

  const close = (): void => {
    onMatches([])
    set({ searchOpen: false })
  }

  return (
    <div className="searchbar">
      <span>🔍</span>
      <input
        ref={input}
        value={query}
        placeholder="커밋 메시지, 작성자, 이메일, SHA 검색 (단어는 모두 일치해야 함) — Enter 다음 / Shift+Enter 이전"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
          if (e.key === 'Escape') {
            e.stopPropagation()
            close()
          }
        }}
      />
      <span className="dim">{matches.length ? `${pos < 0 ? '–' : pos + 1} / ${matches.length}` : query ? '0' : ''}</span>
      <button className="icon-btn" title="이전 (Shift+Enter)" onClick={() => go(-1)}>
        ▲
      </button>
      <button className="icon-btn" title="다음 (Enter)" onClick={() => go(1)}>
        ▼
      </button>
      <button className="icon-btn" title="닫기 (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  )
}

function columnMenu(e: React.MouseEvent): void {
  const ui = useUi.getState()
  const items: MenuItem[] = (Object.keys(COLUMN_LABEL) as GraphColumn[]).map((c) => ({
    label: COLUMN_LABEL[c],
    checked: ui.columns[c].visible,
    disabled: c === 'message',
    onClick: () => setColumn(c, { visible: !ui.columns[c].visible })
  }))
  items.push(
    { separator: true, label: '' },
    { label: '날짜를 상대 시간으로 표시', checked: ui.dateFormat === 'relative', onClick: () => setUi({ dateFormat: ui.dateFormat === 'relative' ? 'absolute' : 'relative' }) },
    { label: '작성자 이니셜 아바타 표시', checked: ui.showAvatars, onClick: () => setUi({ showAvatars: !ui.showAvatars }) }
  )
  contextMenu(e, items)
}

function formatTime(unix: number, mode: 'relative' | 'absolute'): string {
  if (mode === 'relative') return formatDate(unix)
  const d = new Date(unix * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Header cell with a right-edge resize handle. */
function HeadCell({ col, width, children }: { col: GraphColumn; width: number; children: ReactNode }): ReactNode {
  return (
    <div className="head-cell" style={{ width }}>
      <span className="ellipsis">{children}</span>
      <span className="col-resize" onMouseDown={(e) => dragResize(e, width, (w) => setColumn(col, { width: w }), 40, 600)} />
    </div>
  )
}

function wipMenu(): MenuItem[] {
  return [
    { label: '모든 변경 스테이지', onClick: () => run('모두 스테이지', () => repoApi().stageAll(), { full: false }) },
    { label: '모든 변경 언스테이지', onClick: () => run('모두 언스테이지', () => repoApi().unstageAll(), { full: false }) },
    { label: 'Stash…', onClick: stashSave },
    { separator: true, label: '' },
    { label: '모든 변경 폐기…', onClick: () => import('./RightPanel').then((m) => m.discardAllChanges()) }
  ]
}

export function Graph({ path, data }: { path: string; data: RepoData }): ReactNode {
  const { selection, searchOpen, set } = useStore()
  const ui = useUi()
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const [width, setWidth] = useState(1200)
  const [matches, setMatches] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const onMatches = useMemo(() => (rows: number[]) => setMatches(new Set(rows)), [])

  const state = data.state
  const dirty = !!state && state.status.length > 0
  const offset = dirty ? 1 : 0
  const total = data.commits.length + offset
  const headSha = state?.head
  // At least wide enough for the header label, so a one-lane history does not squeeze it.
  const graphWidth = Math.max(64, Math.min(Math.max(data.layout.width, 1), MAX_LANES) * LANE + 6 + PAD)
  // In a narrow pane, drop SHA, date, author, then the refs column (badges move into the message) so the message stays readable.
  const cols = useMemo(() => {
    let c = ui.columns
    const used = (): number =>
      (c.refs.visible ? c.refs.width : 0) + (c.graph.visible ? graphWidth : 0) + (['author', 'date', 'sha'] as const).reduce((n, k) => n + (c[k].visible ? c[k].width : 0), 0) + 24
    for (const k of ['sha', 'date', 'author', 'refs'] as const) {
      if (width - used() >= MIN_MESSAGE) break
      if (c[k].visible) c = { ...c, [k]: { ...c[k], visible: false } }
    }
    return c
  }, [ui.columns, graphWidth, width])
  const solo = ui.solo[path] ?? NONE
  const hidden = ui.hidden[path] ?? NONE
  const refCount = data.branches.length + data.tags.length
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const soloSet = useMemo(() => new Set(solo), [solo])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setHeight(el.clientHeight)
      setWidth(el.clientWidth)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowOf = useMemo(() => {
    const m = new Map<string, number>()
    data.commits.forEach((c, i) => m.set(c.sha, i + offset))
    return m
  }, [data.commits, offset])

  const selectedRows = useMemo(() => {
    if (selection?.kind === 'wip') return new Set([0])
    if (selection?.kind === 'commit') return new Set([rowOf.get(selection.sha) ?? -1])
    if (selection?.kind === 'commits') return new Set(selection.shas.map((s) => rowOf.get(s) ?? -1))
    return new Set<number>()
  }, [selection, rowOf])
  const cursor = selection?.kind === 'commit' ? (rowOf.get(selection.sha) ?? -1) : selection?.kind === 'wip' ? 0 : -1

  // Keep the selected row visible.
  useEffect(() => {
    const el = scroller.current
    if (!el || cursor < 0) return
    const top = cursor * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight + ROW * 2
  }, [cursor])

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10)
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW) + 10)

  const shaAt = (i: number): string | null => (dirty && i === 0 ? null : data.commits[i - offset]?.sha ?? null)

  const selectRow = (i: number, mods: { ctrl?: boolean; shift?: boolean } = {}): void => {
    if (i < 0 || i >= total) return
    if (dirty && i === 0) {
      setAnchor(0)
      return set({ selection: { kind: 'wip' }, openDiff: null })
    }
    const sha = shaAt(i)!
    if (mods.shift && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
      const shas: string[] = []
      for (let r = a; r <= b; r++) {
        const s = shaAt(r)
        if (s) shas.push(s)
      }
      return set({ selection: shas.length > 1 ? { kind: 'commits', shas } : { kind: 'commit', sha }, openDiff: null })
    }
    if (mods.ctrl) {
      const cur = selection?.kind === 'commits' ? selection.shas : selection?.kind === 'commit' ? [selection.sha] : []
      const next = cur.includes(sha) ? cur.filter((s) => s !== sha) : [...cur, sha]
      next.sort((x, y) => (rowOf.get(x) ?? 0) - (rowOf.get(y) ?? 0))
      setAnchor(i)
      return set({ selection: next.length === 0 ? null : next.length === 1 ? { kind: 'commit', sha: next[0] } : { kind: 'commits', shas: next }, openDiff: null })
    }
    setAnchor(i)
    // Clicking the selected commit again deselects it, like GitKraken.
    if (selection?.kind === 'commit' && selection.sha === sha && !mods.shift) return set({ selection: null, openDiff: null })
    set({ selection: { kind: 'commit', sha }, openDiff: null })
  }

  const onRowMenu = (e: React.MouseEvent, i: number, c: Commit): void => {
    if (selection?.kind === 'commits' && selectedRows.has(i)) {
      const commits = selection.shas.map((s) => data.commits.find((x) => x.sha === s)!).filter(Boolean)
      return contextMenu(e, multiCommitMenu(commits))
    }
    contextMenu(e, commitMenu(c))
  }

  const rows: ReactNode[] = []
  for (let i = first; i < last; i++) {
    const top = i * ROW
    if (dirty && i === 0) {
      rows.push(
        <div
          key="wip"
          className={`grow-row${selectedRows.has(0) ? ' selected' : ''}`}
          style={{ top }}
          onClick={() => selectRow(0)}
          onContextMenu={(e) => contextMenu(e, wipMenu())}
        >
          {cols.refs.visible && <div className="cell-refs-col" style={{ width: cols.refs.width }} />}
          {cols.graph.visible && (
            <svg width={graphWidth} height={ROW} style={{ flexShrink: 0 }}>
              <circle cx={laneX(0)} cy={ROW / 2} r={5.5} fill="none" stroke="var(--yellow)" strokeWidth={2} strokeDasharray="3 2" />
            </svg>
          )}
          <div className="cell-msg wip">
            // WIP — 변경 파일 {state!.status.length}개{state!.operation ? ` (${state!.operation} 진행 중)` : ''}
          </div>
        </div>
      )
      continue
    }
    const ci = i - offset
    const c: Commit = data.commits[ci]
    const row = data.layout.rows[ci]
    const refs = (data.refsBySha.get(c.sha) ?? []).filter((r) => !hiddenSet.has(r.fullName) && (!soloSet.size || soloSet.has(r.fullName) || r.name === state?.branch))
    const cls = ['grow-row']
    if (selectedRows.has(i)) cls.push('selected')
    if (matches.has(ci)) cls.push('match')
    if (matches.size && !matches.has(ci)) cls.push('dimmed')
    const refsNode = refs.length > 0 && <RefBadges refs={refs} currentBranch={state?.branch} data={data} />
    rows.push(
      <div
        key={c.sha}
        className={cls.join(' ')}
        style={{ top }}
        onClick={(e) => selectRow(i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
        onContextMenu={(e) => onRowMenu(e, i, c)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault()
            e.currentTarget.classList.add('drop-row')
          }
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('drop-row')}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('drop-row')
          const src = readDrag(e)
          if (!src) return
          const target = refs.find((r) => r.type === 'head') ?? refs.find((r) => r.type === 'remote')
          void dropMenu(e, src, target ? toDrag(target) : { sha: c.sha })
        }}
      >
        {cols.refs.visible && (
          <div className="cell-refs-col" style={{ width: cols.refs.width }}>
            {refsNode}
          </div>
        )}
        {cols.graph.visible && <GraphCell row={row} width={graphWidth} head={c.sha === headSha} />}
        <div className="cell-msg msg">
          {!cols.refs.visible && refsNode}
          <span className="ellipsis" title={c.subject}>
            {c.subject}
          </span>
        </div>
        {cols.author.visible && (
          <div className="cell-author ellipsis" style={{ width: cols.author.width }} title={`${c.author} <${c.authorEmail}>`}>
            {ui.showAvatars && (
              <span className="avatar" style={{ background: avatarColor(c.authorEmail) }}>
                {initials(c.author)}
              </span>
            )}
            {c.author}
          </div>
        )}
        {cols.date.visible && (
          <div className="cell-date" style={{ width: cols.date.width }} title={new Date(c.authorTime * 1000).toLocaleString()}>
            {formatTime(c.authorTime, ui.dateFormat)}
          </div>
        )}
        {cols.sha.visible && (
          <div className="cell-sha mono" style={{ width: cols.sha.width }}>
            {shortSha(c.sha)}
          </div>
        )}
      </div>
    )
  }
  if (data.more && last === total) {
    rows.push(
      <div key="more" className="grow-row more-row" style={{ top: total * ROW }}>
        <button className="btn small" onClick={() => loadMore(path)}>
          커밋 더 불러오기 (현재 {data.commits.length.toLocaleString()}개)
        </button>
      </div>
    )
  }

  const move = (delta: number, extend: boolean): void => {
    const from = cursor >= 0 ? cursor : anchor ?? -1
    const to = Math.max(0, Math.min(total - 1, from + delta))
    if (extend) {
      if (anchor === null) setAnchor(Math.max(from, 0))
      selectRow(to, { shift: true })
    } else selectRow(to)
  }

  return (
    <div className="center" style={{ position: 'relative' }}>
      {searchOpen && <SearchBar path={path} data={data} onMatches={onMatches} />}
      {(solo.length > 0 || hidden.length > 0) && (
        <div className="viewing-bar">
          {solo.length > 0 ? `Solo: ${solo.length}개 ref 만 보는 중` : `보는 중: ${refCount - hidden.length} / ${refCount} (숨김 ${hidden.length})`}
          <button
            className="btn small"
            onClick={() => {
              setRefList('solo', [])
              setRefList('hidden', [])
            }}
          >
            모두 보기
          </button>
        </div>
      )}
      <div className="graph-head" onContextMenu={columnMenu} title="우클릭: 열 표시/숨기기">
        {cols.refs.visible && (
          <HeadCell col="refs" width={cols.refs.width}>
            {COLUMN_LABEL.refs}
          </HeadCell>
        )}
        {cols.graph.visible && <div className="head-cell" style={{ width: graphWidth }}>{COLUMN_LABEL.graph}</div>}
        <div className="grow" style={{ paddingLeft: 6 }}>
          {COLUMN_LABEL.message}
        </div>
        {cols.author.visible && (
          <HeadCell col="author" width={cols.author.width}>
            {COLUMN_LABEL.author}
          </HeadCell>
        )}
        {cols.date.visible && (
          <HeadCell col="date" width={cols.date.width}>
            {COLUMN_LABEL.date}
          </HeadCell>
        )}
        {cols.sha.visible && (
          <HeadCell col="sha" width={cols.sha.width}>
            {COLUMN_LABEL.sha}
          </HeadCell>
        )}
        <button className="icon-btn head-gear" title="열 설정" onClick={columnMenu}>
          ⚙
        </button>
      </div>
      <div
        ref={scroller}
        className="graph-scroll"
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          const k = e.key
          if (k === 'ArrowDown' || k === 'j' || k === 'J') {
            e.preventDefault()
            move(1, e.shiftKey)
          } else if (k === 'ArrowUp' || k === 'k' || k === 'K') {
            e.preventDefault()
            move(-1, e.shiftKey)
          } else if (k === 'Home' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            selectRow(0)
          } else if (k === 'End' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            selectRow(total - 1)
          } else if (k === 'PageDown' || k === 'PageUp') {
            e.preventDefault()
            move((k === 'PageDown' ? 1 : -1) * Math.floor(height / ROW), e.shiftKey)
          } else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
            // Keyboard access to the row menu, anchored under the cursor row.
            e.preventDefault()
            const box = scroller.current?.getBoundingClientRect()
            if (!box || cursor < 0) return
            const at = { clientX: box.left + 240, clientY: box.top + (cursor + 1) * ROW - (scroller.current?.scrollTop ?? 0), preventDefault() {}, stopPropagation() {} }
            if (dirty && cursor === 0) return contextMenu(at, wipMenu())
            const c = data.commits[cursor - offset]
            if (c) onRowMenu(at as unknown as React.MouseEvent, cursor, c)
          } else if (k === 'Escape') {
            e.stopPropagation()
            set({ selection: null, openDiff: null })
          }
        }}
      >
        {!data.loaded ? (
          <div className="empty">불러오는 중…</div>
        ) : total === 0 ? (
          <div className="empty">아직 커밋이 없습니다. 파일을 추가하고 첫 커밋을 만들어 보세요.</div>
        ) : (
          <div style={{ height: (total + (data.more ? 1 : 0)) * ROW, position: 'relative' }}>{rows}</div>
        )}
      </div>
    </div>
  )
}

/** Current selection as commits (empty for WIP/stash). Used by keyboard shortcuts. */
export function selectedCommits(): Commit[] {
  const s = getState().selection
  const data = activeRepo()
  if (!data) return []
  if (s?.kind === 'commit') return data.commits.filter((c) => c.sha === s.sha)
  if (s?.kind === 'commits') return s.shas.map((x) => data.commits.find((c) => c.sha === x)!).filter(Boolean)
  return []
}
