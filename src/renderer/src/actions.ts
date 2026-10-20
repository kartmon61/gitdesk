// Renderer-side workflows: loading repository data and running git actions with feedback.
import type { GitResult } from '@shared/types'
import { layoutGraph } from '@shared/graph'
import { getState, toast, useStore, type RepoData } from './store'
import { indexCommits } from './search/client'
import { useUi } from './ui'

export const bridge = window.gitdesk

export const repoApi = (path = getState().active!) => bridge.repo(path)

const LOG_PAGE = 5000

/** Number of commits loaded per repository; grows with "load more". */
const logLimits = new Map<string, number>()

export function graphFilter(path: string): { include?: string[]; exclude?: string[] } {
  const ui = useUi.getState()
  const solo = ui.solo[path] ?? []
  return solo.length ? { include: solo } : { exclude: ui.hidden[path] ?? [] }
}

export async function loadMore(path: string): Promise<void> {
  logLimits.set(path, (logLimits.get(path) ?? LOG_PAGE) + LOG_PAGE)
  await loadRepo(path)
}

/** Latest load per repository; an older load that finishes late must not overwrite newer data. */
const loadSeq = new Map<string, number>()

/** Clears a selection or open diff that points at something the reload removed. */
function dropStale(path: string): void {
  const s = getState()
  const data = s.repos[path]
  if (s.active !== path || !data?.state) return
  const patch: Partial<Pick<typeof s, 'selection' | 'openDiff'>> = {}
  const shas = new Set(data.commits.map((c) => c.sha))
  const sel = s.selection
  if (sel?.kind === 'wip' && data.state.status.length === 0) {
    // Committed everything: follow the new HEAD like GitKraken.
    patch.selection = data.commits[0] ? { kind: 'commit', sha: data.commits[0].sha } : null
  } else if (sel?.kind === 'commit' && data.loaded && !shas.has(sel.sha)) patch.selection = null
  else if (sel?.kind === 'commits' && data.loaded && sel.shas.some((x) => !shas.has(x))) patch.selection = null
  else if (sel?.kind === 'stash' && data.loaded && sel.index >= data.stashes.length) patch.selection = null
  const od = s.openDiff
  if (od && (od.source === 'unstaged' || od.source === 'staged' || od.source === 'untracked')) {
    const e = data.state.status.find((x) => x.path === od.path)
    const still =
      !!e &&
      (od.source === 'untracked' ? e.untracked : od.source === 'staged' ? !e.untracked && e.index !== ' ' : e.untracked || e.worktree !== ' ')
    if (!still) patch.openDiff = null
  } else if (od && data.loaded && od.source === 'stash' && !data.stashes.some((x) => x.sha === od.sha)) patch.openDiff = null
  else if (od && data.loaded && od.source === 'commit' && od.sha && !shas.has(od.sha)) patch.openDiff = null
  if (Object.keys(patch).length) s.set(patch)
}

/** Reloads everything shown for a repository. Cheap calls run in parallel. */
export async function loadRepo(path: string, full = true): Promise<void> {
  const api = bridge.repo(path)
  const seq = (loadSeq.get(path) ?? 0) + 1
  loadSeq.set(path, seq)
  const stale = (): boolean => loadSeq.get(path) !== seq
  try {
    const [state, undo, redo] = await Promise.all([api.state(), api.undoLabel(), api.redoLabel()])
    if (stale()) return
    // Status drives banners and the WIP panel; show it before the slower history load.
    getState().setRepo(path, { state, undo, redo, loaded: getState().repos[path]?.loaded ?? false })
    const patch: Partial<RepoData> = { loaded: true }
    if (full) {
      const [commits, refs, branches, tags, stashes, remotes, submodules, worktrees, lfs] = await Promise.all([
        api.log(logLimits.get(path) ?? LOG_PAGE, 0, graphFilter(path)),
        api.refs(),
        api.branches(),
        api.tags(),
        api.stashes(),
        api.remotes(),
        api.submodules(),
        api.worktrees(),
        api.lfsDetected()
      ])
      const refsBySha = new Map<string, typeof refs>()
      for (const r of refs) refsBySha.set(r.sha, [...(refsBySha.get(r.sha) ?? []), r])
      const prev = getState().repos[path]
      const sameHistory = prev && prev.commits.length === commits.length && prev.commits.every((c, i) => c.sha === commits[i].sha)
      Object.assign(patch, {
        more: commits.length >= (logLimits.get(path) ?? LOG_PAGE),
        commits: sameHistory ? prev.commits : commits,
        layout: sameHistory ? prev.layout : layoutGraph(commits),
        refsBySha,
        branches,
        tags,
        stashes,
        remotes,
        submodules,
        worktrees,
        lfs
      })
      if (stale()) return
      if (!sameHistory) indexCommits(path, commits)
    }
    getState().setRepo(path, patch)
    dropStale(path)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

export function refresh(full = true): Promise<void> {
  const path = getState().active
  return path ? loadRepo(path, full) : Promise.resolve()
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Strip Electron's IPC wrapper prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * Runs a git action with a busy indicator, then refreshes. Results with a non-zero
 * exit code (merge/rebase conflicts) are reported but still refresh the view.
 */
export async function run<T>(label: string, fn: () => Promise<T>, opts: { success?: string; full?: boolean } = {}): Promise<T | undefined> {
  // One git action at a time: a double click must not start the same push twice.
  const running = getState().busy
  if (running) {
    toast(`"${running}" 작업이 끝난 뒤 다시 시도하세요`)
    return undefined
  }
  useStore.setState({ busy: label, progress: '' })
  try {
    const result = await fn()
    const r = result as unknown as GitResult | undefined
    if (r && typeof r === 'object' && 'code' in r && r.code !== 0) {
      toast((r.stderr || r.stdout).trim() || `${label} 실패`, 'error')
    } else if (opts.success) toast(opts.success, 'success')
    return result
  } catch (e) {
    toast(errorText(e), 'error')
    return undefined
  } finally {
    useStore.setState({ busy: null, progress: '' })
    await refresh(opts.full ?? true)
  }
}

export async function openRepoPath(path: string): Promise<void> {
  try {
    const top = await bridge.app.openRepository(path)
    const s = getState()
    if (!s.tabs.includes(top)) s.set({ tabs: [...s.tabs, top] })
    activate(top)
    await loadRepo(top)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

export function activate(path: string): void {
  const s = getState()
  if (s.active === path && s.repos[path]?.loaded) return
  s.set({ active: path, selection: null, openDiff: null, overlay: null, sidebarFilter: '', searchOpen: false })
  if (!getState().repos[path]?.loaded) void loadRepo(path)
}

export async function closeTab(path: string): Promise<void> {
  await bridge.app.closeRepository(path)
  const s = getState()
  const tabs = s.tabs.filter((t) => t !== path)
  const repos = { ...s.repos }
  delete repos[path]
  if (s.active !== path) return s.set({ tabs, repos })
  s.set({ tabs, repos, active: undefined })
  const next = tabs[tabs.length - 1]
  if (next) activate(next)
}

export function copy(text: string): void {
  void navigator.clipboard.writeText(text)
  toast('클립보드에 복사했습니다')
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function formatDate(unix: number): string {
  const d = new Date(unix * 1000)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '방금 전'
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
