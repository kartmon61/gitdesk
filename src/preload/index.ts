import { contextBridge, ipcRenderer } from 'electron'
import { REPO_METHODS, type AppApi, type AskpassRequest, type GitdeskBridge, type ProgressEvent } from '@shared/api'

// Keep in sync with AppApi; the main process registers one `app:<name>` handler per entry.
const APP_METHODS: (keyof AppApi)[] = [
  'pickDirectory',
  'saveText',
  'toggleFullScreen',
  'pickFile',
  'openRepository',
  'closeRepository',
  'initRepository',
  'cloneRepository',
  'getSettings',
  'updateSettings',
  'openExternal',
  'openInExplorer',
  'openTerminal',
  'listAccounts',
  'addAccount',
  'removeAccount',
  'listRemoteRepos',
  'listPullRequests',
  'createPullRequest',
  'answerAskpass',
  'matchRemote'
]

const app = Object.fromEntries(APP_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`app:${m}`, ...args)])) as unknown as AppApi

const bridge: GitdeskBridge = {
  // contextBridge cannot pass a Proxy across worlds, so build a plain object of methods.
  repo(path) {
    return Object.fromEntries(
      REPO_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke('repo', path, m, args)])
    ) as ReturnType<GitdeskBridge['repo']>
  },
  app,
  onRepoChanged(cb) {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('repo:changed', listener)
    return () => ipcRenderer.off('repo:changed', listener)
  },
  onProgress(cb) {
    const listener = (_e: unknown, ev: ProgressEvent): void => cb(ev)
    ipcRenderer.on('progress', listener)
    return () => ipcRenderer.off('progress', listener)
  },
  onAskpass(cb) {
    const listener = (_e: unknown, req: AskpassRequest): void => cb(req)
    ipcRenderer.on('askpass', listener)
    return () => ipcRenderer.off('askpass', listener)
  }
}

contextBridge.exposeInMainWorld('gitdesk', bridge)
