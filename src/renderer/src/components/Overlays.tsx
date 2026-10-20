import { useEffect, useState, type ReactNode } from 'react'
import type { BlameLine, Commit, ReflogEntry } from '@shared/types'
import { copy, errorText, formatDate, repoApi, run, shortSha } from '../actions'
import { contextMenu } from '../dialogs'
import { resetTo } from '../menus'
import { toast, useStore } from '../store'
import { showDiff } from './DiffView'

function Frame({ title, children }: { title: string; children: ReactNode }): ReactNode {
  const set = useStore((s) => s.set)
  return (
    <div className="diff-view" onKeyDown={(e) => e.key === 'Escape' && set({ overlay: null })} tabIndex={0}>
      <div className="diff-head">
        <strong className="grow ellipsis mono">{title}</strong>
        <button className="icon-btn" onClick={() => set({ overlay: null })}>
          ✕
        </button>
      </div>
      <div className="diff-body">{children}</div>
    </div>
  )
}

export function FileHistory({ path }: { path: string }): ReactNode {
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const set = useStore((s) => s.set)
  useEffect(() => {
    repoApi().fileHistory(path).then(setCommits, (e) => toast(errorText(e), 'error'))
  }, [path])
  return (
    <Frame title={`히스토리: ${path}`}>
      {!commits ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        commits.map((c) => (
          <div
            key={c.sha}
            className="file"
            onClick={() => {
              set({ overlay: null, selection: { kind: 'commit', sha: c.sha } })
              void showDiff({ path, source: 'commit', sha: c.sha })
            }}
          >
            <span className="mono dim">{shortSha(c.sha)}</span>
            <span className="grow ellipsis">{c.subject}</span>
            <span className="dim">{c.author}</span>
            <span className="dim">{formatDate(c.authorTime)}</span>
          </div>
        ))
      )}
    </Frame>
  )
}

export function Blame({ path }: { path: string }): ReactNode {
  const [lines, setLines] = useState<BlameLine[] | null>(null)
  const set = useStore((s) => s.set)
  useEffect(() => {
    repoApi().blame(path).then(setLines, (e) => toast(errorText(e), 'error'))
  }, [path])
  return (
    <Frame title={`Blame: ${path}`}>
      {!lines ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        <table className="blame mono">
          <tbody>
            {lines.map((l, i) => {
              const showMeta = i === 0 || lines[i - 1].sha !== l.sha
              const uncommitted = /^0+$/.test(l.sha)
              return (
                <tr key={i}>
                  <td className="meta" onClick={() => !uncommitted && set({ overlay: null, selection: { kind: 'commit', sha: l.sha } })}>
                    {showMeta ? (uncommitted ? '커밋되지 않음' : `${shortSha(l.sha)} ${l.author} · ${formatDate(l.time)}`) : ''}
                  </td>
                  <td className="dim" style={{ textAlign: 'right', width: 40 }}>
                    {l.lineNo}
                  </td>
                  <td>{l.content}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Frame>
  )
}

export function Reflog(): ReactNode {
  const [entries, setEntries] = useState<ReflogEntry[] | null>(null)
  const set = useStore((s) => s.set)
  useEffect(() => {
    repoApi().reflog().then(setEntries, (e) => toast(errorText(e), 'error'))
  }, [])
  return (
    <Frame title="Reflog (HEAD 이동 기록)">
      {!entries ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        entries.map((e) => (
          <div
            key={e.selector}
            className="file"
            onClick={() => set({ overlay: null, selection: { kind: 'commit', sha: e.sha } })}
            onContextMenu={(ev) =>
              contextMenu(ev, [
                { label: '이 커밋 체크아웃 (detached)', onClick: () => run('체크아웃', () => repoApi().checkout(e.sha, { detach: true })) },
                { label: '현재 브랜치를 여기로 reset…', onClick: () => resetTo(e.sha) },
                { label: 'SHA 복사', onClick: () => copy(e.sha) }
              ])
            }
          >
            <span className="mono dim">{e.selector}</span>
            <span className="mono">{shortSha(e.sha)}</span>
            <span className="grow ellipsis">{e.message}</span>
            <span className="dim">{formatDate(e.time)}</span>
          </div>
        ))
      )}
    </Frame>
  )
}
