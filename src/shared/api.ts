// Contract between renderer and main. The renderer can only call what is listed here.
import type {
  BlameLine,
  Branch,
  ChangedFile,
  Commit,
  CommitDetail,
  ConflictVersions,
  FileDiff,
  GitResult,
  Operation,
  ProviderAccount,
  ProviderKind,
  PullRequest,
  RebaseTodoItem,
  ReflogEntry,
  Ref,
  Remote,
  RemoteRepo,
  RepoState,
  Stash,
  Submodule,
  Tag,
  Worktree
} from './types'

export type PullMode = 'merge' | 'rebase' | 'ff-only'
export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep'
export type MergeMode = 'default' | 'no-ff' | 'ff-only' | 'squash'

/** Operations on one repository. Implemented by main's Repository class. */
export interface RepoApi {
  state(): Promise<RepoState>
  getConfig(key: string): Promise<string>
  setConfig(key: string, value: string, scope?: 'local' | 'global'): Promise<void>
  log(limit?: number, skip?: number, filter?: { include?: string[]; exclude?: string[] }): Promise<Commit[]>
  rangeFileDiff(from: string, to: string, path: string, oldPath?: string, ignoreWhitespace?: boolean, context?: number): Promise<FileDiff | null>
  isAncestor(ancestor: string, descendant: string): Promise<boolean>
  restoreFiles(rev: string, paths: string[]): Promise<void>
  workingPatch(paths?: string[]): Promise<string>
  deleteFiles(paths: string[]): Promise<void>
  fastForward(branch: string, target: string): Promise<void>
  lockWorktree(path: string, lock: boolean): Promise<void>
  addWorktreeFrom(path: string, newBranch: string, startPoint: string): Promise<void>
  revertMany(shas: string[]): Promise<GitResult>
  amendMessage(message: string): Promise<void>
  refs(): Promise<Ref[]>
  commitDetail(sha: string): Promise<CommitDetail>
  commitFileDiff(sha: string, path: string, oldPath?: string, ignoreWhitespace?: boolean, context?: number): Promise<FileDiff | null>
  compare(from: string, to: string): Promise<ChangedFile[]>
  fileHistory(path: string, limit?: number): Promise<Commit[]>
  blame(path: string, rev?: string): Promise<BlameLine[]>
  reflog(ref?: string, limit?: number): Promise<ReflogEntry[]>
  fileAt(rev: string, path: string): Promise<string | null>
  workingDiff(path: string, staged: boolean, untracked: boolean, ignoreWhitespace?: boolean, context?: number): Promise<FileDiff | null>
  stage(paths: string[]): Promise<void>
  stageAll(): Promise<void>
  unstage(paths: string[]): Promise<void>
  unstageAll(): Promise<void>
  discard(paths: string[], untracked?: string[]): Promise<void>
  discardAll(): Promise<void>
  applyLines(diff: FileDiff, selected: string[], action: 'stage' | 'unstage' | 'discard'): Promise<void>
  commit(message: string, opts?: { amend?: boolean; noVerify?: boolean; signoff?: boolean; allowEmpty?: boolean }): Promise<void>
  lastCommitMessage(): Promise<string>
  preparedMessage(): Promise<string>
  addToGitignore(pattern: string): Promise<void>
  branches(): Promise<Branch[]>
  checkout(target: string, opts?: { detach?: boolean; force?: boolean }): Promise<void>
  checkoutRemote(remoteBranch: string, localName?: string): Promise<void>
  createBranch(name: string, startPoint?: string, checkout?: boolean): Promise<void>
  renameBranch(oldName: string, newName: string): Promise<void>
  deleteBranch(name: string, force?: boolean): Promise<void>
  deleteRemoteBranch(remote: string, name: string): Promise<void>
  setUpstream(branch: string, upstream: string | null): Promise<void>
  tags(): Promise<Tag[]>
  createTag(name: string, target?: string, message?: string): Promise<void>
  deleteTag(name: string): Promise<void>
  pushTag(remote: string, name: string): Promise<void>
  deleteRemoteTag(remote: string, name: string): Promise<void>
  remotes(): Promise<Remote[]>
  addRemote(name: string, url: string): Promise<void>
  removeRemote(name: string): Promise<void>
  renameRemote(oldName: string, newName: string): Promise<void>
  setRemoteUrl(name: string, url: string, push?: boolean): Promise<void>
  fetch(opts?: { remote?: string; prune?: boolean; tags?: boolean }): Promise<void>
  pull(mode?: PullMode): Promise<void>
  push(opts?: { remote?: string; branch?: string; setUpstream?: boolean; force?: 'lease' | 'force'; tags?: boolean }): Promise<void>
  merge(target: string, mode?: MergeMode): Promise<GitResult>
  rebase(onto: string): Promise<GitResult>
  rebaseTodo(base: string): Promise<RebaseTodoItem[]>
  interactiveRebase(base: string, items: RebaseTodoItem[]): Promise<GitResult>
  cherryPick(shas: string[], noCommit?: boolean): Promise<GitResult>
  revert(sha: string, mainline?: number): Promise<GitResult>
  reset(target: string, mode: ResetMode): Promise<void>
  sequencer(op: Exclude<Operation, 'bisect'>, action: 'continue' | 'skip' | 'abort'): Promise<GitResult>
  conflictVersions(path: string): Promise<ConflictVersions>
  resolveWithContent(path: string, content: string): Promise<void>
  resolveWithSide(path: string, side: 'ours' | 'theirs'): Promise<void>
  markConflicted(path: string): Promise<void>
  mergetool(path: string): Promise<GitResult>
  stashes(): Promise<Stash[]>
  stashSave(message?: string, opts?: { includeUntracked?: boolean; keepIndex?: boolean; staged?: boolean; paths?: string[] }): Promise<void>
  stashApply(index: number, pop?: boolean): Promise<GitResult>
  stashDrop(index: number): Promise<void>
  stashBranch(index: number, branch: string): Promise<void>
  stashFiles(index: number): Promise<ChangedFile[]>
  submodules(): Promise<Submodule[]>
  submoduleUpdate(path?: string, init?: boolean): Promise<void>
  addSubmodule(url: string, path: string): Promise<void>
  worktrees(): Promise<Worktree[]>
  addWorktree(path: string, branch: string, createBranch?: boolean): Promise<void>
  removeWorktree(path: string, force?: boolean): Promise<void>
  lfsDetected(): Promise<boolean>
  lfs(args: string[]): Promise<GitResult>
  bisect(action: 'start' | 'good' | 'bad' | 'skip' | 'reset', rev?: string): Promise<GitResult>
  formatPatch(range: string, outDir: string): Promise<string[]>
  applyPatch(file: string, asCommits: boolean): Promise<GitResult>
  console(commandLine: string): Promise<GitResult>
  undoLabel(): string | undefined
  redoLabel(): string | undefined
  undo(): Promise<string | undefined>
  redo(): Promise<string | undefined>
}

/** Method names the main process will dispatch. Must match RepoApi exactly. */
export const REPO_METHODS = [
  'state', 'getConfig', 'setConfig', 'log', 'refs', 'commitDetail', 'commitFileDiff', 'compare', 'fileHistory', 'blame',
  'reflog', 'fileAt', 'workingDiff', 'stage', 'stageAll', 'unstage', 'unstageAll', 'discard', 'discardAll', 'applyLines',
  'commit', 'lastCommitMessage', 'preparedMessage', 'addToGitignore', 'branches', 'checkout', 'checkoutRemote', 'createBranch',
  'renameBranch', 'deleteBranch', 'deleteRemoteBranch', 'setUpstream', 'tags', 'createTag', 'deleteTag', 'pushTag',
  'deleteRemoteTag', 'remotes', 'addRemote', 'removeRemote', 'renameRemote', 'setRemoteUrl', 'fetch', 'pull', 'push',
  'merge', 'rebase', 'rebaseTodo', 'interactiveRebase', 'cherryPick', 'revert', 'reset', 'sequencer', 'conflictVersions',
  'resolveWithContent', 'resolveWithSide', 'markConflicted', 'mergetool', 'stashes', 'stashSave', 'stashApply',
  'stashDrop', 'stashBranch', 'stashFiles', 'submodules', 'submoduleUpdate', 'addSubmodule', 'worktrees', 'addWorktree',
  'removeWorktree', 'lfsDetected', 'lfs', 'bisect', 'formatPatch', 'applyPatch', 'console', 'undoLabel', 'redoLabel',
  'undo', 'redo', 'rangeFileDiff', 'isAncestor', 'restoreFiles', 'workingPatch', 'deleteFiles', 'fastForward',
  'lockWorktree', 'addWorktreeFrom', 'revertMany', 'amendMessage'
] as const satisfies readonly (keyof RepoApi)[]

// Compile-time check that every RepoApi method is listed.
type Missing = Exclude<keyof RepoApi, (typeof REPO_METHODS)[number]>
export const _allListed: Missing extends never ? true : Missing = true

export interface Settings {
  gitPath: string
  autoFetchMinutes: number
  defaultPullMode: PullMode
  theme: 'dark' | 'light'
  recentRepos: string[]
  openRepos: string[]
}

/** A git/ssh authentication question shown to the user. */
export interface AskpassRequest {
  id: number
  /** login: username + password · secret: hidden input · text: plain input · confirm: yes/no */
  kind: 'login' | 'secret' | 'text' | 'confirm'
  title: string
  message: string
}

export interface ProgressEvent {
  repo: string
  text: string
}

/** Application-level operations. */
export interface AppApi {
  pickDirectory(title: string): Promise<string | null>
  pickFile(title: string): Promise<string | null>
  openRepository(path: string): Promise<string>
  closeRepository(path: string): Promise<void>
  initRepository(path: string): Promise<string>
  cloneRepository(url: string, dir: string): Promise<string>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  openExternal(url: string): Promise<void>
  openInExplorer(path: string): Promise<void>
  openTerminal(path: string): Promise<void>
  /** Save dialog; writes `content` and returns the chosen path, or null when cancelled */
  saveText(title: string, defaultName: string, content: string): Promise<string | null>
  toggleFullScreen(): Promise<void>
  // integrations
  listAccounts(): Promise<ProviderAccount[]>
  addAccount(kind: ProviderKind, baseUrl: string, token: string): Promise<ProviderAccount>
  removeAccount(id: string): Promise<void>
  listRemoteRepos(accountId: string, query?: string): Promise<RemoteRepo[]>
  listPullRequests(accountId: string, repoFullName: string, state: 'open' | 'closed' | 'all'): Promise<PullRequest[]>
  createPullRequest(
    accountId: string,
    repoFullName: string,
    pr: { title: string; body: string; source: string; target: string; draft: boolean }
  ): Promise<PullRequest>
  /** Answers an AskpassRequest; null cancels. For login, a JSON {username,password}. */
  answerAskpass(id: number, answer: string | null): Promise<void>
  /** Finds the account and repo path matching a remote URL */
  matchRemote(url: string): Promise<{ accountId: string; repoFullName: string } | null>
}

export interface GitdeskBridge {
  repo(path: string): { [K in keyof RepoApi]: (...args: Parameters<RepoApi[K]>) => Promise<Awaited<ReturnType<RepoApi[K]>>> }
  app: AppApi
  onRepoChanged(cb: (path: string) => void): () => void
  onProgress(cb: (e: ProgressEvent) => void): () => void
  onAskpass(cb: (req: AskpassRequest) => void): () => void
}
