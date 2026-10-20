import { useEffect, useRef, useState, type ReactNode } from 'react'
import { buildOutput, parseConflicts, resolvedLines, unresolvedCount, type ConflictSegment, type Resolution, type Segment } from '@shared/conflict'
import type { ConflictVersions } from '@shared/types'
import { errorText, repoApi, run } from '../actions'
import { confirm } from '../dialogs'
import { toast, useStore } from '../store'

const LABELS: [Resolution, string][] = [
  ['ours', '내 것'],
  ['theirs', '상대 것'],
  ['both', '둘 다 (내 것 먼저)'],
  ['theirs-ours', '둘 다 (상대 것 먼저)']
]

function Lines({ lines }: { lines: string[] }): ReactNode {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className="dl">
          <span className="tx">{l || ' '}</span>
        </div>
      ))}
    </>
  )
}

export function MergeEditor({ path }: { path: string }): ReactNode {
  const set = useStore((s) => s.set)
  const [versions, setVersions] = useState<ConflictVersions | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [cursor, setCursor] = useState(-1)
  const out = useRef<HTMLDivElement>(null)
  const branch = useStore((st) => (st.active ? st.repos[st.active]?.state?.branch : undefined)) ?? 'HEAD'
  const eol = versions?.merged.includes('\r\n') ? '\r\n' : '\n'

  useEffect(() => {
    repoApi()
      .conflictVersions(path)
      .then((v) => {
        setVersions(v)
        setSegments(parseConflicts(v.merged))
      }, (e) => toast(errorText(e), 'error'))
  }, [path])

  const close = (): void => set({ overlay: null })
  /** Closing throws away unsaved choices, so ask first when there are any. */
  const closeAsk = async (): Promise<void> => {
    const chosen = segments.some((sg) => sg.type === 'conflict' && sg.resolution !== 'none')
    if (chosen && !(await confirm('병합 편집기 닫기', '저장하지 않은 충돌 해결 내용을 버립니다.', '닫기', true))) return
    close()
  }

  /** After resolving, move on to the next conflicted file like GitKraken. */
  const next = (): void => {
    const st = useStore.getState()
    const data = st.active ? st.repos[st.active] : undefined
    const other = data?.state?.status.find((e) => e.conflicted && e.path !== path)
    set({ overlay: other ? { kind: 'merge', path: other.path } : null })
  }

  const conflictIdx = segments.map((sg, i) => (sg.type === 'conflict' ? i : -1)).filter((i) => i >= 0)
  const goConflict = (delta: number): void => {
    if (!conflictIdx.length) return
    const n = (cursor + delta + conflictIdx.length) % conflictIdx.length
    setCursor(n)
    out.current?.querySelector(`[data-seg="${conflictIdx[n]}"]`)?.scrollIntoView({ block: 'center' })
  }
  const update = (i: number, patch: Partial<ConflictSegment>): void =>
    setSegments((segs) => segs.map((s, j) => (j === i && s.type === 'conflict' ? { ...s, ...patch } : s)))

  const save = async (): Promise<void> => {
    const left = unresolvedCount(segments)
    if (left > 0 && !(await confirm('미해결 충돌', `${left}개 충돌이 남아 있습니다. 충돌 마커를 남긴 채 해결됨으로 표시할까요?`, '그래도 저장', true))) return
    const ok = await run('충돌 해결', async () => {
      await repoApi().resolveWithContent(path, buildOutput(segments, eol))
      return true
    }, { full: false })
    if (ok) next()
  }

  const side = async (s: 'ours' | 'theirs'): Promise<void> => {
    const ok = await run('충돌 해결', async () => {
      await repoApi().resolveWithSide(path, s)
      return true
    }, { full: false })
    if (ok) next()
  }

  if (!versions) return <div className="merge"><div className="empty">불러오는 중…</div></div>
  const conflicts = segments.filter((s) => s.type === 'conflict').length
  // Delete/modify conflicts and binary files have no markers to edit.
  const markerless = conflicts === 0

  return (
    <div
      className="merge"
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void save()
        } else if (e.target instanceof HTMLTextAreaElement) {
          // Escape only leaves the hand-edit box; it must not discard the resolutions.
          if (e.key === 'Escape') e.target.blur()
          return
        } else if (e.key === 'Escape') void closeAsk()
        else if (e.key === 'ArrowDown' && e.altKey) goConflict(1)
        else if (e.key === 'ArrowUp' && e.altKey) goConflict(-1)
      }}
    >
      <div className="diff-head">
        <strong className="mono grow ellipsis">{path}</strong>
        {!markerless && (
          <span className="dim">
            충돌 {conflicts}개 중 {conflicts - unresolvedCount(segments)}개 해결
          </span>
        )}
        {!markerless && (
          <>
            <button className="icon-btn" title="이전 충돌 (Alt+↑)" onClick={() => goConflict(-1)}>
              ↑
            </button>
            <button className="icon-btn" title="다음 충돌 (Alt+↓)" onClick={() => goConflict(1)}>
              ↓
            </button>
            <button className="btn small" title="모든 충돌에 현재 브랜치 쪽 선택" onClick={() => setSegments((sg) => sg.map((x) => (x.type === 'conflict' ? { ...x, resolution: 'ours' } : x)))}>
              모두 A
            </button>
            <button className="btn small" title="모든 충돌에 들어오는 쪽 선택" onClick={() => setSegments((sg) => sg.map((x) => (x.type === 'conflict' ? { ...x, resolution: 'theirs' } : x)))}>
              모두 B
            </button>
          </>
        )}
        <button className="btn small" onClick={() => side('ours')}>
          현재 쪽 파일 선택 ({branch})
        </button>
        <button className="btn small" onClick={() => side('theirs')}>
          들어오는 쪽 파일 선택
        </button>
        <button className="btn small" onClick={() => run('mergetool', () => repoApi().mergetool(path), { full: false })}>
          외부 머지툴
        </button>
        {!markerless && (
          <button className="btn small primary" onClick={save}>
            저장 (Ctrl+S) 후 다음 파일
          </button>
        )}
        <button className="icon-btn" onClick={() => void closeAsk()}>
          ✕
        </button>
      </div>
      {markerless ? (
        <div className="empty">
          충돌 마커가 없는 충돌입니다 (한쪽에서 삭제됐거나 바이너리 파일).
          <br />
          내 것: {versions.ours === null ? '삭제됨' : '있음'} · 상대 것: {versions.theirs === null ? '삭제됨' : '있음'}
          <br />
          위의 「전체 내 것」 또는 「전체 상대 것」으로 해결하세요.
        </div>
      ) : (
        <>
          <div className="merge-panes" style={{ flex: '0 0 35%' }}>
            <div className="merge-pane mono">
              <h4>A — 현재 ({branch})</h4>
              <Lines lines={(versions.ours ?? '').split(/\r?\n/)} />
            </div>
            <div className="merge-pane mono">
              <h4>B — 들어오는 변경</h4>
              <Lines lines={(versions.theirs ?? '').split(/\r?\n/)} />
            </div>
          </div>
          <div className="merge-out mono" ref={out}>
            <h4>결과</h4>
            {segments.map((s, i) => {
              if (s.type === 'common') return <Lines key={i} lines={s.lines} />
              const resolved = resolvedLines(s)
              return (
                <div key={i} data-seg={i} className={`chunk ${resolved ? 'resolved' : 'unresolved'}${conflictIdx[cursor] === i ? ' current' : ''}`}>
                  <div className="chunk-bar">
                    {LABELS.map(([r, label]) => (
                      <button key={r} className={`btn small${s.resolution === r ? ' primary' : ''}`} onClick={() => update(i, { resolution: r })}>
                        {label}
                      </button>
                    ))}
                    {s.base && (
                      <button className={`btn small${s.resolution === 'base' ? ' primary' : ''}`} onClick={() => update(i, { resolution: 'base' })}>
                        base
                      </button>
                    )}
                    <button
                      className={`btn small${s.resolution === 'custom' ? ' primary' : ''}`}
                      onClick={() => {
                        update(i, { resolution: 'custom', custom: resolved ?? [...s.ours, ...s.theirs] })
                        setEditing(i)
                      }}
                    >
                      직접 편집
                    </button>
                    {s.resolution !== 'none' && (
                      <button className="btn small" onClick={() => update(i, { resolution: 'none' })}>
                        되돌리기
                      </button>
                    )}
                  </div>
                  {editing === i && s.resolution === 'custom' ? (
                    <textarea
                      className="mono"
                      style={{ width: '100%', minHeight: 120 }}
                      value={(s.custom ?? []).join('\n')}
                      onChange={(e) => update(i, { custom: e.target.value.split('\n') })}
                      onBlur={() => setEditing(null)}
                      autoFocus
                    />
                  ) : resolved ? (
                    <Lines lines={resolved} />
                  ) : (
                    <>
                      <div className="chunk conflict ours">
                        <Lines lines={s.ours} />
                      </div>
                      {s.base && (
                        <div className="chunk dim">
                          <Lines lines={s.base} />
                        </div>
                      )}
                      <div className="chunk conflict theirs">
                        <Lines lines={s.theirs} />
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
