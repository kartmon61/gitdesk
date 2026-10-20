import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PullRequest, RemoteRepo } from '@shared/types'
import { bridge, errorText, formatDate, openRepoPath, repoApi, run } from '../actions'
import { contextMenu, openDialog } from '../dialogs'
import { activeRepo, toast, useStore } from '../store'

/** Resolves the provider account and repo path for the repository's main remote. */
async function remoteTarget(): Promise<{ accountId: string; repoFullName: string } | null> {
  const remotes = activeRepo()?.remotes ?? []
  const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0]
  if (!remote) return null
  return bridge.app.matchRemote(remote.fetchUrl)
}

function CreatePrDialog({ source, initialTarget, close }: { source: string; initialTarget?: string; close: () => void }): ReactNode {
  const branches = activeRepo()?.branches.filter((b) => b.remote) ?? []
  const targets = [...new Set(branches.map((b) => b.name.slice(b.name.indexOf('/') + 1)))].filter((n) => n !== 'HEAD' && n !== source)
  const guess = ['develop', 'main', 'master'].find((n) => targets.includes(n)) ?? targets[0] ?? ''
  const [title, setTitle] = useState(source)
  const [body, setBody] = useState('')
  const [target, setTarget] = useState(initialTarget && targets.includes(initialTarget) ? initialTarget : guess)
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    const t = await remoteTarget()
    if (!t) return toast('origin 원격과 일치하는 연결 계정이 없습니다. 설정에서 GitHub/GitLab 계정을 추가하세요.', 'error')
    setBusy(true)
    try {
      const pr = await bridge.app.createPullRequest(t.accountId, t.repoFullName, { title, body, source, target, draft })
      close()
      toast(`#${pr.number} 를 만들었습니다`, 'success')
      await bridge.app.openExternal(pr.webUrl)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog" style={{ width: 600 }}>
      <h3>Pull / Merge Request 만들기</h3>
      <div className="dim">원격에 {source} 브랜치가 push 돼 있어야 합니다.</div>
      <label>
        대상 브랜치
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        제목
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        설명
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
      </label>
      <div className="buttons">
        <button className="btn" onClick={close}>
          취소
        </button>
        <button className="btn primary" disabled={busy || !title.trim() || !target} onClick={submit}>
          {busy ? '만드는 중…' : '만들기'}
        </button>
      </div>
    </div>
  )
}

export function openCreatePullRequest(source: string, target?: string): void {
  openDialog((close) => <CreatePrDialog source={source} initialTarget={target} close={close} />)
}

export function PullRequestSection({ path }: { path: string }): ReactNode {
  const [prs, setPrs] = useState<PullRequest[] | null>(null)
  const [error, setError] = useState('')
  const remotes = useStore((s) => s.repos[path]?.remotes)
  // Only refetch when the remote URLs change, not on every status refresh.
  const remoteKey = remotes?.map((r) => r.fetchUrl).join('|')

  const load = useCallback(async () => {
    setError('')
    try {
      const t = await remoteTarget()
      if (!t) {
        setPrs(null)
        return setError('연결된 계정 없음')
      }
      setPrs(await bridge.app.listPullRequests(t.accountId, t.repoFullName, 'open'))
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, remoteKey])

  return (
    <>
      {error && <div className="item dim" title={error}>{error}</div>}
      {prs?.length === 0 && <div className="item dim">열린 요청 없음</div>}
      {prs?.map((pr) => (
        <div
          key={pr.id}
          className="item"
          title={`${pr.title}\n${pr.sourceBranch} → ${pr.targetBranch}\n${pr.author} · ${pr.updatedAt}`}
          onClick={() => bridge.app.openExternal(pr.webUrl)}
          onContextMenu={(e) =>
            contextMenu(e, [
              { label: '브라우저에서 열기', onClick: () => bridge.app.openExternal(pr.webUrl) },
              {
                label: `${pr.sourceBranch} 체크아웃`,
                onClick: async () => {
                  const origin = activeRepo()?.remotes.find((r) => r.name === 'origin')?.name ?? activeRepo()?.remotes[0]?.name
                  if (!origin) return
                  await run('PR 체크아웃', async () => {
                    await repoApi().fetch({ remote: origin })
                    await repoApi().checkoutRemote(`${origin}/${pr.sourceBranch}`)
                  })
                }
              },
              { label: '새로고침', onClick: load }
            ])
          }
        >
          <span className="dim">{pr.draft ? '✎' : '⇄'}</span>
          <span className="ellipsis">
            #{pr.number} {pr.title}
          </span>
        </div>
      ))}
    </>
  )
}

function CloneDialog({ close }: { close: () => void }): ReactNode {
  const accounts = useStore((s) => s.accounts)
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<RemoteRepo[]>([])
  const [useSsh, setUseSsh] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!accountId) return
    const t = setTimeout(() => {
      bridge.app.listRemoteRepos(accountId, query).then(setRepos, (e) => toast(errorText(e), 'error'))
    }, 300)
    return () => clearTimeout(t)
  }, [accountId, query])

  const dirName = name || url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || ''

  const clone = async (): Promise<void> => {
    setBusy(true)
    const target = `${parent.replace(/[\\/]+$/, '')}/${dirName}`
    useStore.setState({ busy: `클론 중: ${url}` })
    try {
      const top = await bridge.app.cloneRepository(url, target)
      close()
      await openRepoPath(top)
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
      useStore.setState({ busy: null, progress: '' })
    }
  }

  return (
    <div className="dialog" style={{ width: 640 }}>
      <h3>저장소 클론</h3>
      {accounts.length > 0 && (
        <>
          <div className="row">
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.kind} · {a.username} ({new URL(a.baseUrl).host})
                </option>
              ))}
            </select>
            <input className="grow" placeholder="저장소 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="row dim" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={useSsh} onChange={(e) => setUseSsh(e.target.checked)} /> SSH
            </label>
          </div>
          <div className="recent" style={{ maxHeight: 220 }}>
            {repos.map((r) => (
              <div key={r.id} className="item" title={r.description} onClick={() => setUrl(useSsh ? r.cloneSsh : r.cloneHttps)}>
                <span className="ellipsis grow">{r.fullName}</span>
                <span className="badge">{formatDate(Date.parse(r.updatedAt) / 1000)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <label>
        URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… 또는 git@…" />
      </label>
      <label>
        저장할 위치
        <div className="row">
          <input className="grow" value={parent} onChange={(e) => setParent(e.target.value)} />
          <button
            className="btn"
            onClick={async () => {
              const d = await bridge.app.pickDirectory('클론할 상위 폴더')
              if (d) setParent(d)
            }}
          >
            찾아보기
          </button>
        </div>
      </label>
      <label>
        폴더 이름
        <input value={name} placeholder={dirName} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="buttons">
        <button className="btn" onClick={close}>
          취소
        </button>
        <button className="btn primary" disabled={busy || !url || !parent || !dirName} onClick={clone}>
          클론
        </button>
      </div>
    </div>
  )
}

export function openClone(): void {
  openDialog((close) => <CloneDialog close={close} />)
}
