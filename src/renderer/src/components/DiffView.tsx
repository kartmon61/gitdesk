import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiffHunk, DiffLine, FileDiff } from '@shared/types'
import { bridge, errorText, refresh, repoApi } from '../actions'
import { confirm, contextMenu, modalOpen } from '../dialogs'
import { getState, toast, useStore, type OpenDiff } from '../store'
import { setUi, useUi } from '../ui'

/** Context lines that make "inline view" show the whole file. */
const WHOLE_FILE = 1_000_000

/** Loads the diff for an OpenDiff source. */
export async function loadDiff(d: Omit<OpenDiff, 'diff'>, ignoreWhitespace = false, context?: number): Promise<FileDiff | null> {
  const api = repoApi()
  switch (d.source) {
    case 'unstaged':
      return api.workingDiff(d.path, false, false, ignoreWhitespace, context)
    case 'staged':
      return api.workingDiff(d.path, true, false, ignoreWhitespace, context)
    case 'untracked':
      return api.workingDiff(d.path, false, true, ignoreWhitespace, context)
    case 'commit':
    case 'stash':
      return api.commitFileDiff(d.sha!, d.path, d.oldPath, ignoreWhitespace, context)
    case 'range':
      return api.rangeFileDiff(d.from!, d.sha!, d.path, d.oldPath, ignoreWhitespace, context)
  }
}

export async function showDiff(d: Omit<OpenDiff, 'diff'>): Promise<void> {
  try {
    const inline = useUi.getState().diffMode === 'inline'
    const diff = await loadDiff(d, false, inline ? WHOLE_FILE : undefined)
    getState().set({ openDiff: { ...d, diff } })
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

const key = (h: number, l: number): string => `${h}:${l}`

function changeKeys(hunk: DiffHunk, hi: number): string[] {
  return hunk.lines.flatMap((l, li) => (l.kind === 'add' || l.kind === 'del' ? [key(hi, li)] : []))
}

interface SplitRow {
  left?: { line: DiffLine; k: string; pair?: DiffLine }
  right?: { line: DiffLine; k: string; pair?: DiffLine }
}

/** Pairs deletions with following additions so changed lines sit side by side. */
function splitRows(hunk: DiffHunk, hi: number): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: { line: DiffLine; k: string }[] = []
  let adds: { line: DiffLine; k: string }[] = []
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) {
      const l = dels[i]
      const r = adds[i]
      rows.push({ left: l && { ...l, pair: r?.line }, right: r && { ...r, pair: l?.line } })
    }
    dels = []
    adds = []
  }
  hunk.lines.forEach((line, li) => {
    const item = { line, k: key(hi, li) }
    if (line.kind === 'del') dels.push(item)
    else if (line.kind === 'add') adds.push(item)
    else {
      flush()
      if (line.kind === 'context') rows.push({ left: item, right: item })
    }
  })
  flush()
  return rows
}

/** For unified views: the paired line of each changed line, for word-level highlighting. */
function unifiedPairs(hunk: DiffHunk): Map<number, DiffLine> {
  const pairs = new Map<number, DiffLine>()
  let dels: number[] = []
  let adds: number[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
      pairs.set(dels[i], hunk.lines[adds[i]])
      pairs.set(adds[i], hunk.lines[dels[i]])
    }
    dels = []
    adds = []
  }
  hunk.lines.forEach((l, i) => {
    if (l.kind === 'del') {
      if (adds.length) flush()
      dels.push(i)
    } else if (l.kind === 'add') adds.push(i)
    else flush()
  })
  flush()
  return pairs
}

/** Highlights the part of `text` that differs from `other` (common prefix/suffix stays plain). */
function wordDiff(text: string, other: string | undefined, kind: 'add' | 'del'): ReactNode {
  if (other === undefined || text === other) return text || ' '
  let a = 0
  while (a < text.length && a < other.length && text[a] === other[a]) a++
  let b = 0
  while (b < text.length - a && b < other.length - a && text[text.length - 1 - b] === other[other.length - 1 - b]) b++
  // Snap to word boundaries so whole tokens are marked.
  while (a > 0 && /\w/.test(text[a - 1])) a--
  while (b > 0 && /\w/.test(text[text.length - b])) b--
  const mid = text.slice(a, text.length - b)
  if (!mid || mid.length > text.length * 0.8) return text || ' '
  return (
    <>
      {text.slice(0, a)}
      <mark className={`wd ${kind}`}>{mid}</mark>
      {text.slice(text.length - b)}
    </>
  )
}

function FileView({ od }: { od: OpenDiff }): ReactNode {
  const [text, setText] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    const rev = od.source === 'commit' || od.source === 'stash' || od.source === 'range' ? (od.sha === 'WORKDIR' ? null : od.sha!) : od.source === 'staged' ? '' : null
    // '' reads the index (":path"); the working tree comes from a whole-file diff without deleted lines.
    const load = rev === null ? loadDiff(od, false, WHOLE_FILE).then((d) => d?.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'del' && l.kind !== 'meta').map((l) => l.content)).join('\n') ?? null) : repoApi().fileAt(rev, od.path)
    load.then(setText, (e) => toast(errorText(e), 'error'))
  }, [od])
  if (text === undefined) return <div className="empty">불러오는 중…</div>
  if (text === null) return <div className="empty">이 시점에 파일이 없습니다.</div>
  return (
    <div>
      {text.split('\n').map((l, i) => (
        <div key={i} className="dl context">
          <span className="no">{i + 1}</span>
          <span className="tx">{l || ' '}</span>
        </div>
      ))}
    </div>
  )
}

export function DiffView({ od }: { od: OpenDiff }): ReactNode {
  const set = useStore((s) => s.set)
  const mode = useUi((s) => s.diffMode)
  const wrap = useUi((s) => s.diffWrap)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<{ h: number; l: number } | null>(null)
  const [ignoreWs, setIgnoreWs] = useState(false)
  const [fileView, setFileView] = useState(false)
  const [diff, setDiff] = useState<FileDiff | null>(od.diff)
  const [changeIdx, setChangeIdx] = useState(-1)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDiff(od.diff)
    setSelected(new Set())
    setChangeIdx(-1)
  }, [od])

  // Re-fetch when the view needs different context or whitespace handling.
  useEffect(() => {
    const ctx = mode === 'inline' ? WHOLE_FILE : undefined
    if (!ignoreWs && mode !== 'inline' && od.diff && od.diff.hunks.every((h) => h.lines.length < 2000)) return setDiff(od.diff)
    loadDiff(od, ignoreWs, ctx).then(setDiff, (e) => toast(errorText(e), 'error'))
  }, [ignoreWs, od, mode])

  // Partial staging needs exact lines, so it is only offered without whitespace filtering.
  const editable = !ignoreWs && !fileView && (od.source === 'unstaged' || od.source === 'staged')

  const reload = async (): Promise<void> => {
    await refresh(false)
    const next = await loadDiff(od)
    if (!next || next.hunks.length === 0) set({ openDiff: null })
    else set({ openDiff: { ...od, diff: next } })
  }

  const apply = async (keys: string[], action: 'stage' | 'unstage' | 'discard'): Promise<void> => {
    if (!diff || !keys.length) return
    if (action === 'discard' && !(await confirm('변경 폐기', `선택한 ${keys.length}줄의 변경을 버립니다. 되돌릴 수 없습니다.`, '폐기', true))) return
    try {
      await repoApi().applyLines(diff, keys, action)
      await reload()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const clickLine = (h: number, l: number, line: DiffLine, shift: boolean): void => {
    if (!editable || (line.kind !== 'add' && line.kind !== 'del')) return
    const next = new Set(selected)
    if (shift && anchor && anchor.h === h) {
      const [a, b] = [Math.min(anchor.l, l), Math.max(anchor.l, l)]
      diff!.hunks[h].lines.forEach((x, i) => {
        if (i >= a && i <= b && (x.kind === 'add' || x.kind === 'del')) next.add(key(h, i))
      })
    } else {
      const k = key(h, l)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      setAnchor({ h, l })
    }
    setSelected(next)
  }

  const lineMenu = (e: React.MouseEvent, h: number, l: number): void => {
    if (!editable) return
    const k = key(h, l)
    const keys = selected.has(k) ? [...selected] : [k]
    const items =
      od.source === 'unstaged'
        ? [
            { label: keys.length > 1 ? `선택한 ${keys.length}줄 스테이지` : '이 줄 스테이지', onClick: () => apply(keys, 'stage') },
            { label: keys.length > 1 ? `선택한 ${keys.length}줄 폐기` : '이 줄 폐기', onClick: () => apply(keys, 'discard') },
            { separator: true, label: '' },
            { label: '헌크 스테이지', onClick: () => apply(changeKeys(diff!.hunks[h], h), 'stage') },
            { label: '헌크 폐기', onClick: () => apply(changeKeys(diff!.hunks[h], h), 'discard') }
          ]
        : [
            { label: keys.length > 1 ? `선택한 ${keys.length}줄 언스테이지` : '이 줄 언스테이지', onClick: () => apply(keys, 'unstage') },
            { label: '헌크 언스테이지', onClick: () => apply(changeKeys(diff!.hunks[h], h), 'unstage') }
          ]
    contextMenu(e, items)
  }

  const stats = useMemo(() => {
    let add = 0
    let del = 0
    for (const h of diff?.hunks ?? []) for (const l of h.lines) l.kind === 'add' ? add++ : l.kind === 'del' && del++
    return { add, del }
  }, [diff])

  // Change blocks for previous/next navigation: first line of each run of adds/dels.
  const changeStarts = useMemo(() => {
    const out: string[] = []
    diff?.hunks.forEach((h, hi) => {
      let inRun = false
      h.lines.forEach((l, li) => {
        const changed = l.kind === 'add' || l.kind === 'del'
        if (changed && !inRun) out.push(key(hi, li))
        inRun = changed
      })
    })
    return out
  }, [diff])

  // F7 / Shift+F7 work wherever focus is, as in GitKraken.
  const goRef = useRef<(delta: number) => void>(() => undefined)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F7' || modalOpen()) return
      e.preventDefault()
      goRef.current(e.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const goChange = (delta: number): void => {
    if (!changeStarts.length) return
    const next = (changeIdx + delta + changeStarts.length) % changeStarts.length
    setChangeIdx(next)
    body.current?.querySelector(`[data-k="${changeStarts[next]}"]`)?.scrollIntoView({ block: 'center' })
  }
  goRef.current = goChange

  const lineView = (h: number, l: number, line: DiffLine, side?: 'old' | 'new', pair?: DiffLine): ReactNode => {
    const k = key(h, l)
    const cls = ['dl', line.kind]
    if (selected.has(k)) cls.push('sel')
    if (editable && (line.kind === 'add' || line.kind === 'del')) cls.push('selectable')
    if (changeStarts[changeIdx] === k) cls.push('current-change')
    const no = side === 'old' ? line.oldNo : side === 'new' ? line.newNo : undefined
    const content =
      line.kind === 'meta' ? line.content : line.kind === 'add' || line.kind === 'del' ? wordDiff(line.content, pair?.content, line.kind) : line.content || ' '
    return (
      <div key={`${k}${side ?? ''}`} data-k={k} className={cls.join(' ')} onClick={(e) => clickLine(h, l, line, e.shiftKey)} onContextMenu={(e) => lineMenu(e, h, l)}>
        {side ? (
          <span className="no">{no ?? ''}</span>
        ) : (
          <>
            <span className="no">{line.oldNo ?? ''}</span>
            <span className="no">{line.newNo ?? ''}</span>
          </>
        )}
        <span className="tx">{content}</span>
      </div>
    )
  }

  const hunkButtons = (hunk: DiffHunk, hi: number): ReactNode => (
    <>
      {editable && od.source === 'unstaged' && (
        <>
          <button className="btn small" onClick={() => apply(changeKeys(hunk, hi), 'stage')}>
            헌크 스테이지
          </button>
          <button className="btn small" onClick={() => apply(changeKeys(hunk, hi), 'discard')}>
            헌크 폐기
          </button>
        </>
      )}
      {editable && od.source === 'staged' && (
        <button className="btn small" onClick={() => apply(changeKeys(hunk, hi), 'unstage')}>
          헌크 언스테이지
        </button>
      )}
    </>
  )

  const sel = [...selected]
  const modeBtn = (m: typeof mode, label: string, title: string): ReactNode => (
    <button className={mode === m ? 'on' : ''} title={title} onClick={() => setUi({ diffMode: m })}>
      {label}
    </button>
  )
  return (
    <div className="diff-view">
      <div className="diff-head">
        <strong className="ellipsis grow mono" title={od.path}>
          {od.oldPath && od.oldPath !== od.path ? `${od.oldPath} → ` : ''}
          {od.path}
        </strong>
        <span className="stat-add">+{stats.add}</span>
        <span className="stat-del">-{stats.del}</span>
        <span className="dim">{{ unstaged: '변경됨', staged: '스테이징됨', untracked: '새 파일', commit: '커밋', stash: 'stash', range: '비교' }[od.source]}</span>
        {editable && sel.length > 0 && (
          <>
            {od.source === 'unstaged' && (
              <>
                <button className="btn small primary" onClick={() => apply(sel, 'stage')}>
                  선택한 {sel.length}줄 스테이지
                </button>
                <button className="btn small danger" onClick={() => apply(sel, 'discard')}>
                  선택 폐기
                </button>
              </>
            )}
            {od.source === 'staged' && (
              <button className="btn small" onClick={() => apply(sel, 'unstage')}>
                선택한 {sel.length}줄 언스테이지
              </button>
            )}
          </>
        )}
      </div>
      <div className="diff-tools">
        <span className="seg">
          <button className={!fileView ? 'on' : ''} onClick={() => setFileView(false)}>
            Diff 보기
          </button>
          <button className={fileView ? 'on' : ''} onClick={() => setFileView(true)}>
            파일 보기
          </button>
        </span>
        {!fileView && (
          <span className="seg">
            {modeBtn('hunk', 'Hunk', '변경된 부분만')}
            {modeBtn('inline', 'Inline', '파일 전체에 변경 표시')}
            {modeBtn('split', 'Split', '좌우 나란히')}
          </span>
        )}
        <button className="icon-btn" title="이전 변경 (Shift+F7)" onClick={() => goChange(-1)}>
          ↑
        </button>
        <button className="icon-btn" title="다음 변경 (F7)" onClick={() => goChange(1)}>
          ↓
        </button>
        <span className="dim" style={{ fontSize: 11 }}>
          {changeStarts.length ? `${changeIdx < 0 ? '-' : changeIdx + 1}/${changeStarts.length}` : ''}
        </span>
        <label className="row dim" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} /> 공백 무시
        </label>
        <label className="row dim" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={wrap} onChange={(e) => setUi({ diffWrap: e.target.checked })} /> 줄 바꿈
        </label>
        <span className="grow" />
        <button className="btn small" onClick={() => set({ overlay: { kind: 'history', path: od.path } })}>
          히스토리
        </button>
        <button className="btn small" onClick={() => set({ overlay: { kind: 'blame', path: od.path } })}>
          Blame
        </button>
        {(od.source === 'unstaged' || od.source === 'untracked' || od.source === 'staged') && (
          <button className="btn small" title="기본 프로그램으로 열어 편집" onClick={() => bridge.app.openInExplorer(`${getState().active}/${od.path}`)}>
            파일 편집
          </button>
        )}
        <button className="icon-btn" title="닫기 (Esc)" onClick={() => set({ openDiff: null })}>
          ✕
        </button>
      </div>
      <div
        ref={body}
        className={`diff-body mono${wrap ? ' wrap' : ''}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            set({ openDiff: null })
          }
        }}
      >
        {fileView ? (
          <FileView od={od} />
        ) : !diff ? (
          <div className="empty">변경 내용이 없습니다.</div>
        ) : diff.binary ? (
          <div className="empty">바이너리 파일입니다.</div>
        ) : diff.hunks.length === 0 ? (
          <div className="empty">내용 변경 없음 (권한·이름 변경만)</div>
        ) : (
          diff.hunks.map((hunk, hi) => {
            const pairs = mode === 'split' ? null : unifiedPairs(hunk)
            return (
              <div key={hi}>
                {(mode !== 'inline' || editable) && (
                  <div className="hunk-head">
                    <span className="grow">{mode === 'inline' ? '' : hunk.header}</span>
                    {hunkButtons(hunk, hi)}
                  </div>
                )}
                {mode === 'split' ? (
                  <div className="split">
                    {splitRows(hunk, hi).map((r, i) => (
                      <div key={i} style={{ display: 'contents' }}>
                        {r.left ? lineView(hi, Number(r.left.k.split(':')[1]), r.left.line, 'old', r.left.pair) : <div className="dl empty" />}
                        {r.right ? lineView(hi, Number(r.right.k.split(':')[1]), r.right.line, 'new', r.right.pair) : <div className="dl empty" />}
                      </div>
                    ))}
                  </div>
                ) : (
                  hunk.lines.map((line, li) => lineView(hi, li, line, undefined, pairs!.get(li)))
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
