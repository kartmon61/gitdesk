import { useEffect, useState, type ReactNode } from 'react'
import { activate, bridge, closeTab, errorText, loadRepo, openRepoPath, repoApi, run } from './actions'
import { answerAskpass } from './askpass'
import { contextMenu, DialogHost, isTyping, modalOpen } from './dialogs'
import { createBranch } from './menus'
import { getState, toast, useStore, type RepoData } from './store'
import { Console } from './components/Console'
import { DiffView } from './components/DiffView'
import { Graph } from './components/Graph'
import { MergeEditor } from './components/MergeEditor'
import { Blame, FileHistory, Reflog } from './components/Overlays'
import { openCommandPalette, openShortcuts, setZoom } from './components/Palette'
import { openClone } from './components/PullRequests'
import { RightPanel } from './components/RightPanel'
import { openSettings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { fetchAll, Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'

const OP_LABEL = { merge: '병합', rebase: '리베이스', 'cherry-pick': 'Cherry-pick', revert: 'Revert', bisect: 'Bisect' }

/** Recently closed tabs for Ctrl+Shift+T. */
const closedTabs: string[] = []

async function closeTabRemember(path: string): Promise<void> {
  closedTabs.push(path)
  await closeTab(path)
}

function OperationBanner({ data }: { data: RepoData }): ReactNode {
  const state = data.state
  const op = state?.operation
  if (!op) return null
  const conflicts = state.status.filter((e) => e.conflicted).length
  if (op === 'bisect') {
    const mark = (action: 'good' | 'bad' | 'skip'): Promise<unknown> =>
      run(`Bisect ${action}`, async () => {
        const r = await repoApi().bisect(action)
        // git prints the next commit to test, or the first bad commit when done.
        const line = r.stdout.trim().split('\n')[0]
        if (line) import('./store').then((m) => m.toast(line, 'info', 12000))
        return r
      })
    return (
      <div className="banner">
        <strong>Bisect 진행 중</strong>
        <span className="grow">현재 체크아웃된 커밋({state.head?.slice(0, 7)})을 확인하고 결과를 표시하세요.</span>
        <button className="btn small primary" onClick={() => mark('good')}>
          Good (정상)
        </button>
        <button className="btn small danger" onClick={() => mark('bad')}>
          Bad (버그)
        </button>
        <button className="btn small" onClick={() => mark('skip')}>
          Skip
        </button>
        <button className="btn small" onClick={() => run('Bisect reset', () => repoApi().bisect('reset'))}>
          종료 (reset)
        </button>
      </div>
    )
  }
  return (
    <div className="banner">
      <strong>
        {OP_LABEL[op]} 진행 중
        {state.rebaseStep ? ` (${state.rebaseStep.current}/${state.rebaseStep.total})` : ''}
      </strong>
      <span className="grow">{conflicts ? `충돌 파일 ${conflicts}개를 해결하세요. 파일을 클릭하면 머지 도구가 열립니다.` : '충돌이 모두 해결됐습니다. 계속하면 커밋됩니다.'}</span>
      <button className="btn small primary" disabled={conflicts > 0} onClick={() => run('계속', () => repoApi().sequencer(op, 'continue'))}>
        계속 (continue)
      </button>
      {op !== 'merge' && (
        <button className="btn small" onClick={() => run('건너뛰기', () => repoApi().sequencer(op, 'skip'))}>
          건너뛰기 (skip)
        </button>
      )}
      <button className="btn small danger" onClick={() => run('중단', () => repoApi().sequencer(op, 'abort'))}>
        {OP_LABEL[op]} 중단 (abort)
      </button>
    </div>
  )
}

function RepoView({ path }: { path: string }): ReactNode {
  const data = useStore((s) => s.repos[path])
  const { openDiff, overlay, consoleOpen } = useStore()
  if (!data) return <div className="empty">불러오는 중…</div>
  return (
    <>
      <Toolbar path={path} data={data} />
      <OperationBanner data={data} />
      <div className="main">
        <Sidebar path={path} data={data} />
        <div className="center" style={{ position: 'relative' }}>
          <Graph path={path} data={data} />
          {openDiff && <DiffView od={openDiff} />}
          {overlay?.kind === 'merge' && <MergeEditor path={overlay.path} />}
          {overlay?.kind === 'history' && <FileHistory path={overlay.path} />}
          {overlay?.kind === 'blame' && <Blame path={overlay.path} />}
          {overlay?.kind === 'reflog' && <Reflog />}
          {consoleOpen && <Console />}
        </div>
        <RightPanel data={data} />
      </div>
    </>
  )
}

function Tabs(): ReactNode {
  const { tabs, active, set, busy } = useStore()
  const [dragging, setDragging] = useState<string | null>(null)
  const tabMenu = (e: React.MouseEvent, t: string): void => {
    const i = tabs.indexOf(t)
    contextMenu(e, [
      { label: '탭 닫기', hint: 'Ctrl+W', onClick: () => closeTabRemember(t) },
      { label: '다른 탭 닫기', disabled: tabs.length < 2, onClick: async () => { for (const x of tabs.filter((x) => x !== t)) await closeTabRemember(x) } },
      { label: '오른쪽 탭 닫기', disabled: i === tabs.length - 1, onClick: async () => { for (const x of tabs.slice(i + 1)) await closeTabRemember(x) } },
      { label: '닫은 탭 다시 열기', hint: 'Ctrl+Shift+T', disabled: !closedTabs.length, onClick: reopenTab },
      { separator: true, label: '' },
      { label: '탐색기에서 열기', onClick: () => bridge.app.openInExplorer(t) },
      { label: '경로 복사', onClick: () => navigator.clipboard.writeText(t) }
    ])
  }
  return (
    <div className="tabs">
      {tabs.map((t) => {
        const data = getState().repos[t]
        const dirty = !!data?.state?.status.length
        return (
          <div
            key={t}
            className={`tab${t === active ? ' active' : ''}${dragging === t ? ' dragging' : ''}`}
            onClick={() => activate(t)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                void closeTabRemember(t)
              }
            }}
            onContextMenu={(e) => tabMenu(e, t)}
            title={t}
            draggable
            onDragStart={() => setDragging(t)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => dragging && e.preventDefault()}
            onDrop={() => {
              if (!dragging || dragging === t) return
              const next = tabs.filter((x) => x !== dragging)
              next.splice(next.indexOf(t) + (tabs.indexOf(dragging) < tabs.indexOf(t) ? 1 : 0), 0, dragging)
              set({ tabs: next })
              void bridge.app.updateSettings({ openRepos: next })
            }}
          >
            {dirty && <span className="tab-dot" title="작업 중인 변경 있음" />}
            {t === active && busy && <span className="tab-spin">⟳</span>}
            <span className="ellipsis">{t.split(/[\\/]/).pop()}</span>
            <button
              className="icon-btn close"
              title="닫기 (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation()
                void closeTabRemember(t)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
      <div className={`tab new-tab${!active ? ' active' : ''}`} onClick={() => set({ active: undefined })} title="새 탭 — 저장소 열기 / 클론 (Ctrl+T)">
        ＋
      </div>
    </div>
  )
}

async function reopenTab(): Promise<void> {
  const p = closedTabs.pop()
  if (p) await openRepoPath(p)
}

async function openFolder(): Promise<void> {
  const dir = await bridge.app.pickDirectory('저장소 열기')
  if (dir) await openRepoPath(dir)
}

export function App(): ReactNode {
  const { active, toasts, busy, progress, set } = useStore()

  useEffect(() => {
    void (async () => {
      const settings = await bridge.app.getSettings()
      set({ settings, accounts: await bridge.app.listAccounts() })
      for (const p of settings.openRepos) await openRepoPath(p)
    })()
    const offChanged = bridge.onRepoChanged((path) => {
      // Background tabs reload when activated; only the visible one refreshes now.
      if (getState().active === path) void loadRepo(path)
      else getState().setRepo(path, { loaded: false })
    })
    const offProgress = bridge.onProgress((e) => {
      const last = e.text.split(/[\r\n]/).filter(Boolean).pop()
      if (last) useStore.setState({ progress: last })
    })
    const offAskpass = bridge.onAskpass((req) => void answerAskpass(req))
    const onKey = (e: KeyboardEvent): void => {
      const s = getState()
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      const typing = isTyping(e.target)
      // App-wide shortcuts that work without a repository.
      if (mod && !e.shiftKey && k === 'p') return void (e.preventDefault(), openCommandPalette())
      if (mod && e.shiftKey && k === 'p') return void (e.preventDefault(), openCommandPalette())
      if (mod && k === '/') return void (e.preventDefault(), openShortcuts())
      if (mod && k === ',') return void (e.preventDefault(), openSettings())
      if (mod && !e.shiftKey && k === 'o') return void (e.preventDefault(), openFolder())
      if (mod && e.shiftKey && k === 'o') return void (e.preventDefault(), openFolder())
      if (mod && !e.shiftKey && k === 'n') return void (e.preventDefault(), openClone())
      if (mod && !e.shiftKey && k === 'i') return void (e.preventDefault(), s.set({ active: undefined }))
      if (mod && !e.shiftKey && k === 't') return void (e.preventDefault(), s.set({ active: undefined }))
      if (mod && e.shiftKey && k === 't') return void (e.preventDefault(), reopenTab())
      if (mod && (k === '=' || k === '+')) return void (e.preventDefault(), setZoom(s.zoom + 0.1))
      if (mod && k === '-') return void (e.preventDefault(), setZoom(s.zoom - 0.1))
      if (mod && k === '0') return void (e.preventDefault(), setZoom(1))
      if (e.key === 'F11') return void (e.preventDefault(), bridge.app.toggleFullScreen())
      // Dialogs, pickers and menus own the keyboard while open.
      if (modalOpen()) return
      if (mod && e.key === 'Tab' && s.tabs.length) {
        e.preventDefault()
        const i = s.active ? s.tabs.indexOf(s.active) : -1
        return activate(s.tabs[(i + (e.shiftKey ? -1 : 1) + s.tabs.length) % s.tabs.length])
      }
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const t = s.tabs[Number(e.key) - 1]
        if (t) {
          e.preventDefault()
          activate(t)
        }
        return
      }
      if (!s.active) return
      if (mod && k === 'w') return void (e.preventDefault(), closeTabRemember(s.active))
      if (mod && !e.shiftKey && !e.altKey && k === 'f') return void (e.preventDefault(), s.set({ searchOpen: true }))
      if (mod && e.altKey && k === 'f') {
        e.preventDefault()
        s.set({ leftOpen: true })
        setTimeout(() => (document.getElementById('sidebar-filter') as HTMLInputElement | null)?.focus(), 0)
        return
      }
      if (mod && e.key === '`') return void (e.preventDefault(), s.set({ consoleOpen: !s.consoleOpen }))
      if (mod && !e.shiftKey && k === 'j') return void (e.preventDefault(), s.set({ leftOpen: !s.leftOpen }))
      if (mod && !e.shiftKey && k === 'k') return void (e.preventDefault(), s.set({ rightOpen: !s.rightOpen }))
      if (mod && !e.shiftKey && k === 'b') return void (e.preventDefault(), createBranch())
      if (mod && !e.shiftKey && k === 'l') return void (e.preventDefault(), fetchAll())
      if (mod && e.shiftKey && k === 'h') {
        e.preventDefault()
        const od = s.openDiff
        if (od) s.set({ overlay: { kind: 'history', path: od.path } })
        else openCommandPalette()
        return
      }
      if (e.altKey && k === 't') return void (e.preventDefault(), bridge.app.openTerminal(s.active))
      if (e.altKey && k === 'o') return void (e.preventDefault(), bridge.app.openInExplorer(s.active))
      if (e.key === 'F5') return void (e.preventDefault(), loadRepo(s.active))
      if (typing) return
      if (mod && k === 'z') {
        e.preventDefault()
        const data = s.repos[s.active]
        if (e.shiftKey && data?.redo) void run('Redo', () => repoApi().redo())
        else if (!e.shiftKey && data?.undo) void run('Undo', () => repoApi().undo())
      } else if (mod && k === 'y') {
        e.preventDefault()
        if (s.repos[s.active]?.redo) void run('Redo', () => repoApi().redo())
      } else if (e.key === 'Escape') {
        if (s.overlay) s.set({ overlay: null })
        else if (s.openDiff) s.set({ openDiff: null })
        else if (s.searchOpen) s.set({ searchOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    // Failures from menu handlers and fire-and-forget actions surface as toasts instead of vanishing.
    const onError = (e: Event): void => {
      const reason = e instanceof PromiseRejectionEvent ? e.reason : (e as CustomEvent).detail
      toast(errorText(reason), 'error')
    }
    window.addEventListener('unhandledrejection', onError)
    window.addEventListener('gitdesk-error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onError)
      window.removeEventListener('gitdesk-error', onError)
      offChanged()
      offProgress()
      offAskpass()
      window.removeEventListener('keydown', onKey)
    }
  }, [set])

  return (
    <div className="app">
      <Tabs />
      {active ? <RepoView key={active} path={active} /> : <Welcome />}
      {busy && (
        <div className="busy">
          <span className="spin">⟳</span> {busy}
          {progress && <span className="dim"> — {progress}</span>}
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))} title="클릭해서 닫기">
            {t.text}
          </div>
        ))}
      </div>
      <DialogHost />
    </div>
  )
}
