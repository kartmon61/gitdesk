// Types shared by main, preload and renderer. Keep this file free of runtime imports.

export type RefType = 'head' | 'remote' | 'tag'

export interface Ref {
  /** Full ref name, e.g. refs/heads/main */
  fullName: string
  /** Short display name, e.g. main, origin/main, v1.0 */
  name: string
  type: RefType
  sha: string
}

export interface Commit {
  sha: string
  parents: string[]
  author: string
  authorEmail: string
  /** Unix seconds */
  authorTime: number
  committer: string
  committerTime: number
  subject: string
}

export interface CommitDetail extends Commit {
  body: string
  files: ChangedFile[]
}

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'unmerged'

export interface ChangedFile {
  path: string
  oldPath?: string
  kind: FileChangeKind
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface StatusEntry {
  path: string
  oldPath?: string
  /** Index (staged) state: one of ' ', M, A, D, R, C, T, U, ? */
  index: string
  /** Worktree state: one of ' ', M, A, D, R, C, T, U, ? */
  worktree: string
  conflicted: boolean
  untracked: boolean
}

export interface Branch {
  name: string
  fullName: string
  remote: boolean
  sha: string
  current: boolean
  upstream?: string
  ahead: number
  behind: number
  /** Upstream configured but missing on remote */
  gone: boolean
  subject: string
  committerTime: number
}

export interface Tag {
  name: string
  sha: string
  annotated: boolean
  message: string
}

export interface Stash {
  index: number
  ref: string
  sha: string
  message: string
}

export interface Remote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface Submodule {
  path: string
  sha: string
  /** ' ' up to date, '-' not initialized, '+' checked out commit differs, 'U' conflicts */
  state: string
  describe: string
}

export interface Worktree {
  path: string
  sha: string
  branch?: string
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}

export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface RepoState {
  path: string
  gitDir: string
  head?: string
  /** Current branch short name, undefined when detached */
  branch?: string
  detached: boolean
  operation?: Operation
  /** Rebase progress when operation === 'rebase' */
  rebaseStep?: { current: number; total: number }
  upstream?: string
  ahead: number
  behind: number
  status: StatusEntry[]
}

export interface ReflogEntry {
  sha: string
  selector: string
  message: string
  time: number
}

export interface BlameLine {
  sha: string
  author: string
  time: number
  lineNo: number
  content: string
}

// --- diff ---

export type DiffLineKind = 'context' | 'add' | 'del' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  content: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  /** Raw header lines up to the first hunk; needed to rebuild partial patches */
  header: string[]
  binary: boolean
  hunks: DiffHunk[]
}

// --- conflicts ---

export interface ConflictVersions {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  /** Current worktree content with conflict markers */
  merged: string
}

// --- interactive rebase ---

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop' | 'edit'

export interface RebaseTodoItem {
  action: RebaseAction
  sha: string
  subject: string
  /** New message for reword */
  message?: string
}

// --- operations ---

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}

export interface HeadSnapshot {
  sha: string
  /** Branch HEAD pointed to, undefined when detached */
  branch?: string
}

/**
 * One undoable action. Undo restores `before`, redo restores `after`.
 * - move-head: the current branch moved (commit, amend, reset, merge, rebase, cherry-pick, revert).
 *   Restored with `reset --soft` for commit/amend (changes come back staged) and `reset --keep` otherwise.
 * - checkout: HEAD switched to another branch or commit.
 * - refs: refs were created or deleted without moving HEAD (branch/tag create/delete).
 */
export interface UndoEntry {
  label: string
  kind: 'move-head' | 'checkout' | 'refs'
  resetMode?: 'soft' | 'keep'
  before: HeadSnapshot
  after: HeadSnapshot
  /** Full ref name -> sha (null = ref did not exist) */
  refsBefore: Record<string, string | null>
  refsAfter: Record<string, string | null>
}

// --- integrations ---

export type ProviderKind = 'github' | 'gitlab'

export interface ProviderAccount {
  id: string
  kind: ProviderKind
  /** API base, e.g. https://api.github.com or https://gitlab.example.com */
  baseUrl: string
  username: string
}

export interface RemoteRepo {
  id: string
  fullName: string
  cloneHttps: string
  cloneSsh: string
  webUrl: string
  description: string
  updatedAt: string
}

export interface PullRequest {
  id: number
  number: number
  title: string
  author: string
  state: string
  sourceBranch: string
  targetBranch: string
  webUrl: string
  draft: boolean
  updatedAt: string
  body: string
}
