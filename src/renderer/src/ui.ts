// Per-user UI layout preferences (panel sizes, columns, view modes), kept in localStorage.
import { create } from 'zustand'

export type GraphColumn = 'refs' | 'graph' | 'message' | 'author' | 'date' | 'sha'

export interface UiPrefs {
  sidebarWidth: number
  rightWidth: number
  columns: Record<GraphColumn, { visible: boolean; width: number }>
  /** 'relative' like "3시간 전" or absolute date-time */
  dateFormat: 'relative' | 'absolute'
  diffMode: 'hunk' | 'inline' | 'split'
  fileView: 'path' | 'tree'
  /** Collapsed sidebar sections and tree folders, keyed by id */
  collapsed: Record<string, boolean>
  /** Hidden branches per repository (full ref names) */
  hidden: Record<string, string[]>
  /** Soloed branches per repository; when non-empty only these are drawn */
  solo: Record<string, string[]>
  showAvatars: boolean
  pushAfterCommit: boolean
  /** Toolbar Pull button default */
  pullDefault: 'fetch' | 'merge' | 'ff-only' | 'rebase'
  showToolbarLabels: boolean
  diffWrap: boolean
}

const DEFAULTS: UiPrefs = {
  sidebarWidth: 260,
  rightWidth: 420,
  columns: {
    refs: { visible: true, width: 200 },
    graph: { visible: true, width: 0 },
    message: { visible: true, width: 0 },
    author: { visible: true, width: 140 },
    date: { visible: true, width: 130 },
    sha: { visible: true, width: 76 }
  },
  dateFormat: 'relative',
  diffMode: 'hunk',
  fileView: 'path',
  collapsed: { tags: true, prs: true, submodules: true, worktrees: true },
  hidden: {},
  solo: {},
  showAvatars: true,
  pushAfterCommit: false,
  pullDefault: 'merge',
  showToolbarLabels: true,
  diffWrap: false
}

const KEY = 'gitdesk.ui'

function load(): UiPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<UiPrefs>
    return { ...DEFAULTS, ...raw, columns: { ...DEFAULTS.columns, ...raw.columns } }
  } catch {
    return DEFAULTS
  }
}

export const useUi = create<UiPrefs>(() => load())

export function setUi(patch: Partial<UiPrefs> | ((s: UiPrefs) => Partial<UiPrefs>)): void {
  useUi.setState(patch)
  localStorage.setItem(KEY, JSON.stringify(useUi.getState()))
}

export function toggleCollapsed(id: string): void {
  setUi((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } }))
}

export function setColumn(col: GraphColumn, patch: Partial<{ visible: boolean; width: number }>): void {
  setUi((s) => ({ columns: { ...s.columns, [col]: { ...s.columns[col], ...patch } } }))
}

export function toggleRepoList(kind: 'hidden' | 'solo', repo: string, ref: string): void {
  setUi((s) => {
    const list = s[kind][repo] ?? []
    const next = list.includes(ref) ? list.filter((r) => r !== ref) : [...list, ref]
    return { [kind]: { ...s[kind], [repo]: next } }
  })
}

/** Starts a mouse drag that reports the horizontal delta; used by panel and column splitters. */
export function dragResize(e: React.MouseEvent, start: number, apply: (width: number) => void, min = 60, max = 2000, invert = false): void {
  e.preventDefault()
  e.stopPropagation()
  const x0 = e.clientX
  const move = (ev: MouseEvent): void => {
    const d = (ev.clientX - x0) * (invert ? -1 : 1)
    apply(Math.max(min, Math.min(max, start + d)))
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
