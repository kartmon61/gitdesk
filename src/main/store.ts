import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/api'
import type { ProviderAccount } from '@shared/types'

const DEFAULT_SETTINGS: Settings = {
  gitPath: '',
  autoFetchMinutes: 5,
  defaultPullMode: 'merge',
  theme: 'dark',
  recentRepos: [],
  openRepos: []
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return { ...fallback, ...JSON.parse(await fs.readFile(file, 'utf8')) }
  } catch {
    return fallback
  }
}

/** Writes via a temp file so a crash never leaves a truncated settings file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2))
  await fs.rename(tmp, file)
}

export class SettingsStore {
  private file = join(app.getPath('userData'), 'settings.json')
  private cache?: Settings

  async get(): Promise<Settings> {
    this.cache ??= await readJson(this.file, DEFAULT_SETTINGS)
    return this.cache
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch }
    this.cache = next
    await writeJson(this.file, next)
    return next
  }

  async addRecent(path: string): Promise<void> {
    const s = await this.get()
    await this.update({ recentRepos: [path, ...s.recentRepos.filter((p) => p !== path)].slice(0, 20) })
  }
}

interface StoredAccount extends ProviderAccount {
  /** Token encrypted with the OS keychain (base64) */
  secret: string
}

/** Provider accounts; tokens are encrypted with Electron safeStorage (DPAPI / Keychain). */
export class AccountStore {
  private file = join(app.getPath('userData'), 'accounts.json')

  private async load(): Promise<StoredAccount[]> {
    return (await readJson<{ accounts: StoredAccount[] }>(this.file, { accounts: [] })).accounts
  }

  async list(): Promise<ProviderAccount[]> {
    return (await this.load()).map(({ secret: _secret, ...a }) => a)
  }

  async add(account: Omit<ProviderAccount, 'id'>, token: string): Promise<ProviderAccount> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 키체인 암호화를 사용할 수 없어 토큰을 저장하지 않았습니다.')
    const accounts = await this.load()
    const stored: StoredAccount = { ...account, id: randomUUID(), secret: safeStorage.encryptString(token).toString('base64') }
    const others = accounts.filter((a) => !(a.kind === account.kind && a.baseUrl === account.baseUrl && a.username === account.username))
    await writeJson(this.file, { accounts: [...others, stored] })
    const { secret: _secret, ...pub } = stored
    return pub
  }

  async remove(id: string): Promise<void> {
    await writeJson(this.file, { accounts: (await this.load()).filter((a) => a.id !== id) })
  }

  /** Account whose credential scope (scheme://host[:port]) matches, with its decrypted token. */
  async forScope(scope: string, scopeOf: (a: ProviderAccount) => string): Promise<{ account: ProviderAccount; token: string } | null> {
    const a = (await this.list()).find((x) => scopeOf(x) === scope.toLowerCase())
    return a ? this.token(a.id) : null
  }

  async token(id: string): Promise<{ account: ProviderAccount; token: string }> {
    const a = (await this.load()).find((x) => x.id === id)
    if (!a) throw new Error('연결된 계정을 찾을 수 없습니다.')
    const { secret, ...account } = a
    return { account, token: safeStorage.decryptString(Buffer.from(secret, 'base64')) }
  }
}
