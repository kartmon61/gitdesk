import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChangedFile, CommitDetail, StatusEntry } from '@shared/types'
import { bridge, copy, errorText, formatDate, repoApi, run, shortSha } from '../actions'
import { confirm, contextMenu, form, isTyping, modalOpen, type MenuItem } from '../dialogs'
import { multiCommitMenu, pushBranch } from '../menus'
import { activeRepo, getState, toast, useStore, type RepoData } from '../store'
import { dragResize, setUi, useUi } from '../ui'
import { showDiff } from './DiffView'
import { FileList, ViewToggle, type FileItem } from './FileList'

const SUMMARY_LIMIT = 72

function statusLetter(e: StatusEntry, staged: boolean): string {
  if (e.untracked) return 'A'
  return (staged ? e.index : e.worktree).trim() || 'M'
}

const repoPath = (): string => getState().active!
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const plural = (paths: string[], one: string, many: string): string => (paths.length > 1 ? many.replace('{n}', String(paths.length)) : one)

/** History, blame, open and copy items shared by every file menu. */
function commonFileItems(paths: string[]): MenuItem[] {
  const path = paths[0]
  const single = paths.length === 1
  return [
    { separator: true, label: '' },
    { label: '파일 히스토리', disabled: !single, onClick: () => useStore.getState().set({ overlay: { kind: 'history', path } }) },
    { label: '파일 Blame', disabled: !single, onClick: () => useStore.getState().set({ overlay: { kind: 'blame', path } }) },
    { separator: true, label: '' },
    { label: '기본 프로그램으로 열기', disabled: !single, onClick: () => bridge.app.openInExplorer(`${repoPath()}/${path}`) },
    { label: '폴더에서 보기', disabled: !single, onClick: () => bridge.app.openInExplorer(`${repoPath()}/${dirOf(path)}`) },
    { label: plural(paths, '파일 경로 복사', '{n}개 파일 경로 복사'), onClick: () => copy(paths.join('\n')) }
  ]
}

export async function discardAllChanges(): Promise<void> {
  if (await confirm('모든 변경 폐기', '스테이징 여부와 관계없이 모든 변경과 추적하지 않는 파일을 버립니다.', '모두 폐기', true))
    await run('모두 폐기', () => repoApi().discardAll())
}

async function discardPaths(entries: StatusEntry[]): Promise<void> {
  const names = entries.length === 1 ? entries[0].path : `${entries.length}개 파일`
  if (!(await confirm('변경 폐기', `${names} 의 변경을 버립니다. 되돌릴 수 없습니다.`, '폐기', true))) return
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path)
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path)
  await run('폐기', () => repoApi().discard(tracked, untracked), { full: false })
}

async function savePatch(paths: string[]): Promise<void> {
  const patch = await repoApi().workingPatch(paths)
  if (!patch.trim()) return toast('patch 로 만들 변경이 없습니다')
  const saved = await bridge.app.saveText('Patch 저장', paths.length === 1 ? `${paths[0].split('/').pop()}.patch` : 'changes.patch', patch)
  if (saved) toast(`저장했습니다: ${saved}`, 'success')
}

function ignoreItems(paths: string[]): MenuItem[] {
  if (paths.length !== 1) return [{ label: `${paths.length}개 파일 ignore`, onClick: () => run('ignore', async () => { for (const p of paths) await repoApi().addToGitignore(p) }, { full: false }) }]
  const p = paths[0]
  const ext = p.includes('.') ? p.slice(p.lastIndexOf('.')) : ''
  const dir = dirOf(p)
  return [
    { label: `Ignore: ${p.split('/').pop()}`, onClick: () => run('ignore', () => repoApi().addToGitignore(p), { full: false }) },
    ...(ext ? [{ label: `Ignore: 모든 *${ext} 파일`, onClick: () => run('ignore', () => repoApi().addToGitignore(`*${ext}`), { full: false }) }] : []),
    ...(dir ? [{ label: `Ignore: ${dir}/ 폴더 전체`, onClick: () => run('ignore', () => repoApi().addToGitignore(`${dir}/`), { full: false }) }] : [])
  ]
}

function WipPanel({ data }: { data: RepoData }): ReactNode {
  const { openDiff, set } = useStore()
  const state = data.state!
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [amend, setAmend] = useState(false)
  const [noVerify, setNoVerify] = useState(false)
  const pushAfter = useUi((s) => s.pushAfterCommit)
  const [unSel, setUnSel] = useState<Set<string>>(new Set())
  const [stSel, setStSel] = useState<Set<string>>(new Set())
  const focusList = useRef<'unstaged' | 'staged'>('unstaged')
  const summaryRef = useRef<HTMLInputElement>(null)

  const conflicted = state.status.filter((e) => e.conflicted)
  const unstaged = state.status.filter((e) => !e.conflicted && (e.untracked || e.worktree !== ' '))
  const staged = state.status.filter((e) => !e.conflicted && !e.untracked && e.index !== ' ')
  const byPath = useMemo(() => new Map(state.status.map((e) => [e.path, e])), [state.status])

  // Drop selections that no longer exist after a refresh.
  useEffect(() => {
    setUnSel((s) => new Set([...s].filter((p) => unstaged.some((e) => e.path === p))))
    setStSel((s) => new Set([...s].filter((p) => staged.some((e) => e.path === p))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status])

  // Prefill the message git prepared for merges, reverts and cherry-picks.
  useEffect(() => {
    if (!state.operation || state.operation === 'bisect') return
    repoApi()
      .preparedMessage()
      .then((msg) => {
        if (!msg) return
        const [first, ...rest] = msg.split('\n')
        setSummary((s) => s || first)
        setDescription((d) => d || rest.join('\n').trim())
      })
      .catch(() => undefined)
  }, [state.operation])

  const toggleAmend = async (on: boolean): Promise<void> => {
    setAmend(on)
    if (on && !summary && !description) {
      try {
        const msg = await repoApi().lastCommitMessage()
        const [first, ...rest] = msg.split('\n')
        setSummary(first)
        setDescription(rest.join('\n').trim())
      } catch (e) {
        // Nothing to amend (empty repository).
        setAmend(false)
        toast(errorText(e), 'error')
      }
    }
  }

  const stage = (paths: string[]): Promise<unknown> => run('스테이지', () => repoApi().stage(paths), { full: false })
  const unstage = (paths: string[]): Promise<unknown> => run('언스테이지', () => repoApi().unstage(paths), { full: false })

  const commit = async (stageAllFirst = false): Promise<void> => {
    if (!summary.trim()) {
      summaryRef.current?.focus()
      return toast('커밋 요약을 입력하세요', 'error')
    }
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim()
    const ok = await run(amend ? 'Amend' : '커밋', async () => {
      if (stageAllFirst) await repoApi().stageAll()
      await repoApi().commit(message, { amend, noVerify })
      return true
    })
    if (ok) {
      setSummary('')
      setDescription('')
      setAmend(false)
      if (pushAfter) await pushBranch()
    }
  }

  // GitKraken shortcuts while the commit panel is shown.
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (modalOpen()) return
      const typing = isTyping(e.target)
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        void commitRef.current(e.shiftKey)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        summaryRef.current?.focus()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void run('모두 스테이지', () => repoApi().stageAll(), { full: false })
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        void run('모두 언스테이지', () => repoApi().unstageAll(), { full: false })
      } else if (!typing && !mod && !e.altKey && (e.key === 's' || e.key === 'u')) {
        // S / U stage or unstage the selected (or open) file.
        const od = getState().openDiff
        if (e.key === 's') {
          const paths = unSel.size ? [...unSel] : od && od.source !== 'staged' && byPath.has(od.path) ? [od.path] : []
          if (paths.length) void stage(paths)
        } else {
          const paths = stSel.size ? [...stSel] : od?.source === 'staged' ? [od.path] : []
          if (paths.length) void unstage(paths)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [unSel, stSel, byPath])

  const unstagedMenu = (paths: string[]): MenuItem[] => {
    const entries = paths.map((p) => byPath.get(p)).filter((x): x is StatusEntry => !!x)
    return [
      { label: plural(paths, '스테이지', '{n}개 파일 스테이지'), onClick: () => stage(paths) },
      { label: plural(paths, '변경 폐기', '{n}개 파일 변경 폐기'), onClick: () => discardPaths(entries) },
      { separator: true, label: '' },
      ...ignoreItems(paths),
      { label: plural(paths, '이 파일 stash', '{n}개 파일 stash'), onClick: () => run('Stash', () => repoApi().stashSave(undefined, { includeUntracked: true, paths }), { success: 'Stash 했습니다' }) },
      { label: plural(paths, '파일 변경으로 patch 만들기…', '{n}개 파일 변경으로 patch 만들기…'), onClick: () => savePatch(paths) },
      ...commonFileItems(paths),
      { separator: true, label: '' },
      {
        label: plural(paths, '파일 삭제', '{n}개 파일 삭제'),
        onClick: async () => {
          if (await confirm('파일 삭제', `${paths.join('\n')}\n\n디스크에서 삭제합니다.`, '삭제', true)) await run('삭제', () => repoApi().deleteFiles(paths), { full: false })
        }
      }
    ]
  }

  const stagedMenu = (paths: string[]): MenuItem[] => [
    { label: plural(paths, '언스테이지', '{n}개 파일 언스테이지'), onClick: () => unstage(paths) },
    { label: plural(paths, '파일 변경으로 patch 만들기…', '{n}개 파일 변경으로 patch 만들기…'), onClick: () => savePatch(paths) },
    ...commonFileItems(paths)
  ]

  const toItems = (list: StatusEntry[], stagedSide: boolean): FileItem[] =>
    list.map((e) => ({ path: e.path, oldPath: stagedSide ? e.oldPath : undefined, letter: statusLetter(e, stagedSide) }))

  const branch = state.branch ?? 'HEAD'
  const theirs = state.operation === 'merge' ? 'MERGE_HEAD' : state.operation ?? '들어오는 쪽'

  return (
    <>
      <div className="panel-head row">
        <strong className="grow">
          {state.status.length}개 파일 변경 · {branch}
        </strong>
        <ViewToggle />
        <button className="icon-btn" title="모든 변경 폐기" onClick={discardAllChanges}>
          🗑
        </button>
      </div>
      <div className="panel-body">
        {conflicted.length > 0 && (
          <>
            <div className="file-list-head" style={{ color: 'var(--red)' }}>
              <span>충돌 파일 ({conflicted.length})</span>
            </div>
            <FileList
              id="conflicted"
              items={conflicted.map((e) => ({ path: e.path, letter: 'U' }))}
              selected={new Set()}
              onSelect={() => undefined}
              onOpen={(it) => set({ overlay: { kind: 'merge', path: it.path } })}
              menu={(paths) => [
                { label: '머지 도구에서 열기', disabled: paths.length !== 1, onClick: () => set({ overlay: { kind: 'merge', path: paths[0] } }) },
                { label: `현재 쪽 선택 (${branch})`, onClick: () => run('해결', async () => { for (const p of paths) await repoApi().resolveWithSide(p, 'ours') }, { full: false }) },
                { label: `들어오는 쪽 선택 (${theirs})`, onClick: () => run('해결', async () => { for (const p of paths) await repoApi().resolveWithSide(p, 'theirs') }, { full: false }) },
                { label: '외부 머지 도구 (git mergetool)', disabled: paths.length !== 1, onClick: () => run('mergetool', () => repoApi().mergetool(paths[0]), { full: false }) },
                { label: '해결됨으로 표시 (현재 내용 스테이지)', onClick: () => stage(paths) },
                ...commonFileItems(paths)
              ]}
              actions={(it) => (
                <button className="btn small" onClick={() => set({ overlay: { kind: 'merge', path: it.path } })}>
                  해결
                </button>
              )}
            />
          </>
        )}
        <div className="file-list-head">
          <span>스테이징 안 된 파일 ({unstaged.length})</span>
          <span className="row">
            {unSel.size > 1 && (
              <button className="btn small" onClick={() => stage([...unSel])}>
                {unSel.size}개 스테이지
              </button>
            )}
            <button className="btn small" disabled={!unstaged.length} onClick={() => run('모두 스테이지', () => repoApi().stageAll(), { full: false })} title="Ctrl+Shift+S">
              모두 스테이지
            </button>
          </span>
        </div>
        <FileList
          id="unstaged"
          items={toItems(unstaged, false)}
          selected={unSel}
          onSelect={(s) => {
            setUnSel(s)
            setStSel(new Set())
          }}
          onFocusList={() => (focusList.current = 'unstaged')}
          activePath={openDiff && openDiff.source !== 'staged' ? openDiff.path : undefined}
          onOpen={(it) => showDiff({ path: it.path, source: byPath.get(it.path)?.untracked ? 'untracked' : 'unstaged' })}
          menu={unstagedMenu}
          onDropFiles={(paths) => unstage(paths)}
          actions={(it) => (
            <>
              <button className="icon-btn" title="변경 폐기" onClick={() => discardPaths([byPath.get(it.path)!])}>
                🗑
              </button>
              <button className="btn small" onClick={() => stage([it.path])}>
                스테이지
              </button>
            </>
          )}
          folderActions={(paths) => (
            <button className="btn small" onClick={() => stage(paths)}>
              폴더 스테이지
            </button>
          )}
        />
        <div className="file-list-head">
          <span>스테이징된 파일 ({staged.length})</span>
          <span className="row">
            {stSel.size > 1 && (
              <button className="btn small" onClick={() => unstage([...stSel])}>
                {stSel.size}개 언스테이지
              </button>
            )}
            <button className="btn small" disabled={!staged.length} onClick={() => run('모두 언스테이지', () => repoApi().unstageAll(), { full: false })} title="Ctrl+Shift+U">
              모두 언스테이지
            </button>
          </span>
        </div>
        <FileList
          id="staged"
          items={toItems(staged, true)}
          selected={stSel}
          onSelect={(s) => {
            setStSel(s)
            setUnSel(new Set())
          }}
          onFocusList={() => (focusList.current = 'staged')}
          activePath={openDiff?.source === 'staged' ? openDiff.path : undefined}
          onOpen={(it) => showDiff({ path: it.path, oldPath: it.oldPath, source: 'staged' })}
          menu={stagedMenu}
          onDropFiles={(paths) => stage(paths)}
          actions={(it) => (
            <button className="btn small" onClick={() => unstage([it.path])}>
              언스테이지
            </button>
          )}
          folderActions={(paths) => (
            <button className="btn small" onClick={() => unstage(paths)}>
              폴더 언스테이지
            </button>
          )}
        />
      </div>
      <div className="commit-box">
        <div className="row">
          <strong className="grow" style={{ fontSize: 12 }}>
            {amend ? '이전 커밋 수정' : '커밋'}
          </strong>
          <span className="dim" style={{ fontSize: 11 }} title="Ctrl+Shift+M 으로 메시지에 포커스">
            Ctrl+Enter 커밋 · Ctrl+Shift+Enter 모두 스테이지 후 커밋
          </span>
        </div>
        <div className="summary-box">
          <input ref={summaryRef} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="커밋 요약" />
          <span className={`counter${summary.length > SUMMARY_LIMIT ? ' over' : ''}`} title={`요약은 ${SUMMARY_LIMIT}자 이하 권장`}>
            {SUMMARY_LIMIT - summary.length}
          </span>
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명" rows={4} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <label className="row dim" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> 이전 커밋 수정 (amend)
          </label>
          <label className="row dim" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={pushAfter} onChange={(e) => setUi({ pushAfterCommit: e.target.checked })} /> 커밋 후 push
          </label>
          <label className="row dim" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={noVerify} onChange={(e) => setNoVerify(e.target.checked)} /> Git hook 건너뛰기
          </label>
        </div>
        <button
          className="btn primary"
          disabled={!summary.trim() || conflicted.length > 0 || (!staged.length && !amend && !state.operation)}
          onClick={() => commit()}
          title={conflicted.length ? '충돌을 먼저 해결하세요' : 'Ctrl+Enter'}
        >
          {amend ? '이전 커밋 수정' : `${staged.length}개 파일 변경 커밋${pushAfter ? ' 후 push' : ''}`}
        </button>
      </div>
    </>
  )
}

const LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', unmerged: 'U' }

function changedItems(files: ChangedFile[]): FileItem[] {
  return files.map((f) => ({
    path: f.path,
    oldPath: f.oldPath,
    letter: LETTER[f.kind],
    extra: f.binary ? (
      <span className="dim stat">bin</span>
    ) : (
      <span className="stat">
        <span className="stat-add">+{f.additions ?? 0}</span> <span className="stat-del">-{f.deletions ?? 0}</span>
      </span>
    )
  }))
}

/** File list for a commit, stash or comparison; `rev` is what "restore" restores from. */
function RevisionFiles({ files, open, rev, source }: { files: ChangedFile[]; open: (f: FileItem) => void; rev?: string; source: string }): ReactNode {
  const openDiff = useStore((s) => s.openDiff)
  const [sel, setSel] = useState<Set<string>>(new Set())
  return (
    <>
      <div className="file-list-head">
        <span>변경된 파일 ({files.length})</span>
        <ViewToggle />
      </div>
      <FileList
        id={`rev-${source}`}
        items={changedItems(files)}
        selected={sel}
        onSelect={setSel}
        activePath={openDiff?.path}
        onOpen={open}
        menu={(paths) => [
          ...(rev
            ? [
                {
                  label: plural(paths, '이 커밋의 파일로 복원', '{n}개 파일을 이 커밋 상태로 복원'),
                  onClick: async () => {
                    if (await confirm('파일 복원', `${paths.join('\n')}\n\n작업 디렉터리의 이 파일들을 ${shortSha(rev)} 시점 내용으로 덮어씁니다.`, '복원', true))
                      await run('복원', () => repoApi().restoreFiles(rev, paths), { full: false })
                  }
                }
              ]
            : []),
          ...commonFileItems(paths)
        ]}
      />
    </>
  )
}

function CommitPanel({ sha }: { sha: string }): ReactNode {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const set = useStore((s) => s.set)
  useEffect(() => {
    let alive = true
    setDetail(null)
    repoApi()
      .commitDetail(sha)
      .then((d) => alive && setDetail(d), (e) => toast(errorText(e), 'error'))
    return () => {
      alive = false
    }
  }, [sha])
  if (!detail) return <div className="empty">불러오는 중…</div>
  const refs = activeRepo()?.refsBySha.get(sha) ?? []
  return (
    <>
      <div className="panel-head col" style={{ gap: 6 }}>
        <div className="row mono dim" style={{ fontSize: 12, flexWrap: 'wrap' }}>
          <span className="sha-chip" title="클릭: SHA 복사" onClick={() => copy(detail.sha)}>
            commit: {shortSha(detail.sha)}
          </span>
          {detail.parents.length > 0 && <span>부모:</span>}
          {detail.parents.map((p) => (
            <a key={p} className="link" title="그래프에서 이 커밋으로 이동" onClick={() => set({ selection: { kind: 'commit', sha: p }, openDiff: null })}>
              {shortSha(p)}
            </a>
          ))}
          {refs.map((r) => (
            <span key={r.fullName} className={`ref ${r.type}`}>
              {r.name}
            </span>
          ))}
        </div>
        <strong style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{detail.subject}</strong>
        {detail.body && <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-dim)' }}>{detail.body}</div>}
        <div className="dim" style={{ fontSize: 12 }}>
          <strong style={{ color: 'var(--text)' }}>{detail.author}</strong> &lt;{detail.authorEmail}&gt; · 작성 {formatDate(detail.authorTime)}
          {(detail.committer !== detail.author || detail.committerTime !== detail.authorTime) && ` · 커밋 ${detail.committer} ${formatDate(detail.committerTime)}`}
        </div>
      </div>
      <div className="panel-body">
        <RevisionFiles files={detail.files} rev={detail.sha} source="commit" open={(f) => showDiff({ path: f.path, oldPath: f.oldPath, source: 'commit', sha })} />
      </div>
    </>
  )
}

/** Two or more selected commits: GitKraken shows the combined diff between the oldest and newest. */
function MultiPanel({ data, shas }: { data: RepoData; shas: string[] }): ReactNode {
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const workdir = shas[0] === 'WORKDIR'
  const commits = shas.map((s) => data.commits.find((c) => c.sha === s)).filter((c): c is NonNullable<typeof c> => !!c)
  // Graph order is newest first; compare oldest (its parent for a contiguous run) to newest.
  const newest = shas[0]
  const oldest = shas[shas.length - 1]
  const contiguous = shas.length > 2 && commits.every((c, i) => i === commits.length - 1 || c.parents[0] === commits[i + 1].sha)
  const from = contiguous ? `${oldest}^` : oldest
  const to = newest

  useEffect(() => {
    let alive = true
    setFiles(null)
    repoApi()
      .compare(from, to)
      .then((f) => alive && setFiles(f), (e) => toast(errorText(e), 'error'))
    return () => {
      alive = false
    }
  }, [from, to])

  const label = (s: string): string => (s === 'WORKDIR' ? '작업 디렉터리' : s.endsWith('^') ? `${shortSha(s.slice(0, -1))}^` : shortSha(s))
  return (
    <>
      <div className="panel-head col" style={{ gap: 6 }}>
        <strong>{workdir ? '작업 디렉터리와 비교' : contiguous ? `${shas.length}개 커밋의 합쳐진 변경` : `${shas.length}개 커밋 비교`}</strong>
        <div className="mono dim" style={{ fontSize: 12 }}>
          {label(from)} → {label(to)}
        </div>
        {!workdir && (
          <div className="multi-commits">
            {commits.map((c) => (
              <div key={c.sha} className="ellipsis dim" style={{ fontSize: 12 }}>
                <span className="mono">{shortSha(c.sha)}</span> {c.subject}
              </div>
            ))}
          </div>
        )}
        {!workdir && commits.length === shas.length && (
          <div className="row">
            <button className="btn small" onClick={(e) => contextMenu(e, multiCommitMenu(commits))}>
              작업 ▾
            </button>
          </div>
        )}
      </div>
      <div className="panel-body">
        {files === null ? (
          <div className="empty">불러오는 중…</div>
        ) : (
          <RevisionFiles files={files} source="range" open={(f) => showDiff({ path: f.path, oldPath: f.oldPath, source: 'range', from, sha: to })} />
        )}
      </div>
    </>
  )
}

function StashPanel({ data, index }: { data: RepoData; index: number }): ReactNode {
  const stash = data.stashes.find((s) => s.index === index)
  const [files, setFiles] = useState<ChangedFile[]>([])
  useEffect(() => {
    repoApi().stashFiles(index).then(setFiles, (e) => toast(errorText(e), 'error'))
  }, [index, stash?.sha])
  if (!stash) return <div className="empty">stash 를 찾을 수 없습니다.</div>
  return (
    <>
      <div className="panel-head col" style={{ gap: 6 }}>
        <strong>{stash.message}</strong>
        <div className="row">
          <button className="btn small primary" onClick={() => run('Stash apply', () => repoApi().stashApply(index))}>
            Stash 적용
          </button>
          <button className="btn small" onClick={() => run('Stash pop', () => repoApi().stashApply(index, true))}>
            Pop
          </button>
          <button
            className="btn small danger"
            onClick={async () => {
              if (await confirm('Stash 삭제', `${stash.ref} 를 삭제합니다.`, '삭제', true)) await run('Stash 삭제', () => repoApi().stashDrop(index))
            }}
          >
            삭제
          </button>
        </div>
      </div>
      <div className="panel-body">
        <RevisionFiles files={files} rev={stash.sha} source="stash" open={(f) => showDiff({ path: f.path, oldPath: f.oldPath, source: 'stash', sha: stash.sha })} />
      </div>
    </>
  )
}

export function RightPanel({ data }: { data: RepoData }): ReactNode {
  const selection = useStore((s) => s.selection)
  const open = useStore((s) => s.rightOpen)
  const width = useUi((s) => s.rightWidth)
  if (!open) return null
  let body: ReactNode
  if (!data.state) body = null
  else if (selection?.kind === 'commit') body = <CommitPanel sha={selection.sha} />
  else if (selection?.kind === 'commits') body = <MultiPanel data={data} shas={selection.shas} />
  else if (selection?.kind === 'stash') body = <StashPanel data={data} index={selection.index} />
  else if (data.state.status.length || selection?.kind === 'wip') body = <WipPanel data={data} />
  else
    body = (
      <div className="empty">
        작업 디렉터리가 깨끗합니다.
        <br />
        <span style={{ fontSize: 12 }}>커밋을 선택하면 상세가 여기 표시됩니다.</span>
      </div>
    )
  return (
    <div className="right" style={{ width }}>
      <div className="panel-resize left" onMouseDown={(e) => dragResize(e, width, (w) => setUi({ rightWidth: w }), 300, 900, true)} />
      {body}
    </div>
  )
}

/** Opens a dialog asking for a commit message — used by palette "Commit". */
export async function quickCommit(): Promise<void> {
  const r = await form('커밋', [{ name: 'message', label: '메시지', type: 'textarea', required: true }])
  if (r) await run('커밋', () => repoApi().commit(String(r.message)))
}
