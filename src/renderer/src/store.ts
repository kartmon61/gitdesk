import { create } from 'zustand'
import type { Settings } from '@shared/api'
import type { GraphLayout } from '@shared/graph'
import type {
  Branch,
  Commit,
  FileDiff,
  ProviderAccount,
  Ref,
  Remote,
  RepoState,
  Stash,
  Submodule,
  Tag,
  Worktree
} from '@shared/types'

export interface RepoData {
  state?: RepoState
  commits: Commit[]
  layout: GraphLayout
  refsBySha: Map<string, Ref[]>
  branches: Branch[]
  tags: Tag[]
  stashes: Stash[]
  remotes: Remote[]
  submodules: Submodule[]
  worktrees: Worktree[]
  lfs: boolean
  undo?: string
  redo?: string
  loaded: boolean
  /** True when the log hit its limit and more history can be loaded */
  more: boolean
}

export const emptyRepo = (): RepoData => ({
  commits: [],
  layout: { rows: [], width: 0 },
  refsBySha: new Map(),
  branches: [],
  tags: [],
  stashes: [],
  remotes: [],
  submodules: [],
  worktrees: [],
  lfs: false,
  loaded: false,
  more: false
})

export type Selection =
  | { kind: 'wip' }
  | { kind: 'commit'; sha: string }
  /** Several commits (Ctrl/Shift-click); shas in graph order, newest first */
  | { kind: 'commits'; shas: string[] }
  | { kind: 'stash'; index: number }
  | null

/** File whose diff is open in the center pane. */
export interface OpenDiff {
  path: string
  oldPath?: string
  source: 'unstaged' | 'staged' | 'untracked' | 'commit' | 'stash' | 'range'
  sha?: string
  /** For range diffs: compare `from` to `sha` (sha may be WORKDIR) */
  from?: string
  diff: FileDiff | null
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export type Overlay =
  | { kind: 'merge'; path: string }
  | { kind: 'history'; path: string }
  | { kind: 'blame'; path: string }
  | { kind: 'reflog' }
  | { kind: 'palette' }
  | null

interface AppStore {
  settings?: Settings
  accounts: ProviderAccount[]
  tabs: string[]
  active?: string
  repos: Record<string, RepoData>
  selection: Selection
  openDiff: OpenDiff | null
  overlay: Overlay
  consoleOpen: boolean
  sidebarFilter: string
  leftOpen: boolean
  rightOpen: boolean
  zoom: number
  searchOpen: boolean
  busy: string | null
  progress: string
  toasts: Toast[]
  set: (patch: Partial<AppStore>) => void
  setRepo: (path: string, patch: Partial<RepoData>) => void
}

export const useStore = create<AppStore>((set) => ({
  accounts: [],
  tabs: [],
  repos: {},
  selection: null,
  openDiff: null,
  overlay: null,
  consoleOpen: false,
  sidebarFilter: '',
  leftOpen: true,
  rightOpen: true,
  zoom: 1,
  searchOpen: false,
  busy: null,
  progress: '',
  toasts: [],
  set: (patch) => set(patch),
  setRepo: (path, patch) =>
    set((s) => ({ repos: { ...s.repos, [path]: { ...(s.repos[path] ?? emptyRepo()), ...patch } } }))
}))

export const getState = useStore.getState

export function activeRepo(): RepoData | undefined {
  const s = getState()
  return s.active ? s.repos[s.active] : undefined
}

let toastId = 0

export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 9000 : 3500): void {
  const id = ++toastId
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
  setTimeout(() => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}
