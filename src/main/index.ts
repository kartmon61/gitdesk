import { BrowserWindow, app, dialog, ipcMain, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { REPO_METHODS, type AppApi, type AskpassRequest } from '@shared/api'
import type { ProviderKind } from '@shared/types'
import { AskpassServer } from './auth/askpass'
import { createAskpassHandler } from './auth/handler'
import { setGitBinary, setGitDefaults } from './git/exec'
import { adoptLoginShellPath } from './shellPath'
import { Repository } from './git/repository'
import { ProviderClient, accountCredentialScope, matchRemoteToAccount, normalizeBaseUrl, type HttpFetch } from './integrations/providers'
import { AccountStore, SettingsStore } from './store'

const settings = new SettingsStore()
const accounts = new AccountStore()

interface OpenRepo {
  repo: Repository
  watcher?: FSWatcher
  fetchTimer?: NodeJS.Timeout
}

/** Only repositories opened through the app can be operated on from the renderer. */
const repos = new Map<string, OpenRepo>()
let win: BrowserWindow | null = null

const PROGRESS_METHODS = new Set(['fetch', 'pull', 'push'])

// ------------------------------------------------------------- authentication

/** URL scopes of connected accounts; git uses their tokens through the relay helper. */
let credentialScopes: string[] = []
const askpassWaiting = new Map<number, (answer: string | null) => void>()
let askpassId = 0

async function refreshCredentialHosts(): Promise<void> {
  credentialScopes = [...new Set((await accounts.list()).map(accountCredentialScope))]
}

function askUser(req: Omit<AskpassRequest, 'id'>): Promise<string | null> {
  if (!win) return Promise.resolve(null)
  const id = ++askpassId
  win.webContents.send('askpass', { ...req, id })
  if (win.isMinimized()) win.restore()
  win.focus()
  return new Promise((resolve) => {
    // Give up after 5 minutes so a forgotten dialog does not hang git forever.
    const timer = setTimeout(() => {
      askpassWaiting.delete(id)
      resolve(null)
    }, 300_000)
    askpassWaiting.set(id, (answer) => {
      clearTimeout(timer)
      resolve(answer)
    })
  })
}

const askpass = new AskpassServer(
  createAskpassHandler({
    async accountFor(scope) {
      const found = await accounts.forScope(scope, accountCredentialScope)
      return found ? { username: found.account.username, password: found.token } : null
    },
    ask: askUser
  }),
  process.execPath
)

function normalize(path: string): string {
  return resolve(path)
}

function notifyChanged(path: string): void {
  win?.webContents.send('repo:changed', path)
}

function startWatching(path: string, entry: OpenRepo): void {
  let timer: NodeJS.Timeout | undefined
  try {
    entry.watcher = watch(path, { recursive: true }, (_event, file) => {
      const f = (file ?? '').toString()
      // Inside .git only HEAD, index and refs matter; ignore objects, logs and lock churn.
      if (f.startsWith(`.git${sep}`) || f.startsWith('.git/')) {
        const rest = f.slice(5)
        if (!/^(HEAD|index|refs|packed-refs|MERGE_HEAD|rebase-|CHERRY_PICK_HEAD|REVERT_HEAD|FETCH_HEAD)/.test(rest)) return
      }
      clearTimeout(timer)
      timer = setTimeout(() => notifyChanged(path), 300)
    })
  } catch {
    // Recursive watch unsupported (old Linux): the renderer still refreshes on focus.
  }
}

async function scheduleAutoFetch(path: string, entry: OpenRepo): Promise<void> {
  clearInterval(entry.fetchTimer)
  const minutes = (await settings.get()).autoFetchMinutes
  if (minutes <= 0) return
  entry.fetchTimer = setInterval(() => {
    entry.repo
      .fetch({ prune: true })
      .then(() => notifyChanged(path))
      .catch(() => {
        /* offline or auth needed; manual fetch reports errors */
      })
  }, minutes * 60_000)
}

async function openRepository(path: string): Promise<string> {
  if (!(await Repository.isRepository(path))) throw new Error(`Git 저장소가 아닙니다: ${path}`)
  const top = normalize(await Repository.topLevel(path))
  if (!repos.has(top)) {
    const entry: OpenRepo = { repo: new Repository(top) }
    repos.set(top, entry)
    startWatching(top, entry)
    await scheduleAutoFetch(top, entry)
  }
  await settings.addRecent(top)
  const s = await settings.get()
  if (!s.openRepos.includes(top)) await settings.update({ openRepos: [...s.openRepos, top] })
  return top
}

function getRepo(path: string): Repository {
  const entry = repos.get(normalize(path))
  if (!entry) throw new Error('열려 있지 않은 저장소입니다.')
  return entry.repo
}

const httpFetch: HttpFetch = async (url, init) => {
  // net.fetch uses Chromium's network stack and the OS certificate store (corporate CAs).
  const res = await net.fetch(url, { method: init?.method, headers: init?.headers, body: init?.body })
  return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() }
}

async function client(accountId: string): Promise<ProviderClient> {
  const { account, token } = await accounts.token(accountId)
  return new ProviderClient(account, token, httpFetch)
}

const appApi: AppApi = {
  async pickDirectory(title) {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  async pickFile(title) {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'] })
    return r.canceled ? null : r.filePaths[0]
  },
  openRepository,
  async closeRepository(path) {
    const key = normalize(path)
    const entry = repos.get(key)
    entry?.watcher?.close()
    clearInterval(entry?.fetchTimer)
    repos.delete(key)
    const s = await settings.get()
    await settings.update({ openRepos: s.openRepos.filter((p) => p !== key) })
  },
  async initRepository(path) {
    await Repository.init(path)
    return openRepository(path)
  },
  async cloneRepository(url, dir) {
    await Repository.clone(url, dir, (text) => win?.webContents.send('progress', { repo: dir, text }))
    return openRepository(dir)
  },
  getSettings: () => settings.get(),
  async updateSettings(patch) {
    const next = await settings.update(patch)
    if (patch.gitPath !== undefined) setGitBinary(next.gitPath)
    if (patch.autoFetchMinutes !== undefined) for (const [p, e] of repos) await scheduleAutoFetch(p, e)
    return next
  },
  async openExternal(url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 열 수 있습니다.')
    await shell.openExternal(url)
  },
  async openInExplorer(path) {
    await shell.openPath(path)
  },
  async openTerminal(path) {
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: path, detached: true, windowsHide: false }).unref()
    else if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', path], { detached: true }).unref()
    else spawn('x-terminal-emulator', [], { cwd: path, detached: true }).unref()
  },
  async saveText(title, defaultName, content) {
    const r = await dialog.showSaveDialog(win!, { title, defaultPath: defaultName })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, content)
    return r.filePath
  },
  async toggleFullScreen() {
    win?.setFullScreen(!win.isFullScreen())
  },
  listAccounts: () => accounts.list(),
  async addAccount(kind: ProviderKind, baseUrl: string, token: string) {
    const base = normalizeBaseUrl(kind, baseUrl)
    const username = await new ProviderClient({ kind, baseUrl: base }, token, httpFetch).username()
    const added = await accounts.add({ kind, baseUrl: base, username }, token)
    await refreshCredentialHosts()
    return added
  },
  async removeAccount(id) {
    await accounts.remove(id)
    await refreshCredentialHosts()
  },
  async answerAskpass(id, answer) {
    askpassWaiting.get(id)?.(answer)
    askpassWaiting.delete(id)
  },
  async listRemoteRepos(accountId, query) {
    return (await client(accountId)).repositories(query)
  },
  async listPullRequests(accountId, repo, state) {
    return (await client(accountId)).pullRequests(repo, state)
  },
  async createPullRequest(accountId, repo, pr) {
    return (await client(accountId)).createPullRequest(repo, pr)
  },
  async matchRemote(url) {
    const m = matchRemoteToAccount(url, await accounts.list())
    return m ? { accountId: m.account.id, repoFullName: m.repoPath } : null
  }
}

function registerIpc(): void {
  const allowed = new Set<string>(REPO_METHODS)
  ipcMain.handle('repo', async (_e, path: string, method: string, args: unknown[]) => {
    if (!allowed.has(method)) throw new Error(`Unknown repository method: ${method}`)
    const repo = getRepo(path)
    const fn = (repo as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    if (PROGRESS_METHODS.has(method)) {
      const onProgress = (text: string): void => win?.webContents.send('progress', { repo: path, text })
      return fn.call(repo, args[0], onProgress)
    }
    return fn.apply(repo, args)
  })
  for (const [name, fn] of Object.entries(appApi)) {
    ipcMain.handle(`app:${name}`, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1b1e24',
    title: 'gitdesk',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  // Never let the renderer navigate or open windows; external links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('focus', () => {
    for (const p of repos.keys()) notifyChanged(p)
  })
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  await adoptLoginShellPath()
  setGitBinary((await settings.get()).gitPath)
  await askpass.start(join(app.getPath('userData'), 'askpass'))
  await refreshCredentialHosts()
  setGitDefaults(askpass.env(), () => askpass.configArgs(credentialScopes))
  registerIpc()
  await createWindow()
})

app.on('window-all-closed', () => {
  for (const e of repos.values()) {
    e.watcher?.close()
    clearInterval(e.fetchTimer)
  }
  void askpass.close()
  app.quit()
})
