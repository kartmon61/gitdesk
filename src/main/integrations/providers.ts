// GitHub / GitLab REST clients. HTTP is injected so this module stays testable without Electron.
import type { ProviderAccount, ProviderKind, PullRequest, RemoteRepo } from '@shared/types'

export type HttpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface NewPullRequest {
  title: string
  body: string
  source: string
  target: string
  draft: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

export class ProviderClient {
  constructor(
    readonly account: Pick<ProviderAccount, 'kind' | 'baseUrl'>,
    private readonly token: string,
    private readonly http: HttpFetch
  ) {}

  private get apiRoot(): string {
    const base = this.account.baseUrl.replace(/\/+$/, '')
    return this.account.kind === 'gitlab' ? `${base}/api/v4` : base
  }

  private async request(path: string, method = 'GET', body?: unknown): Promise<Json> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.account.kind === 'github') {
      headers.Authorization = `Bearer ${this.token}`
      headers['X-GitHub-Api-Version'] = '2022-11-28'
    } else headers['PRIVATE-TOKEN'] = this.token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await this.http(this.apiRoot + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!res.ok) {
      const text = await res.text()
      let message = text
      try {
        const j = JSON.parse(text)
        message = j.message ?? j.error ?? text
        if (Array.isArray(message)) message = message.join(', ')
      } catch {
        /* plain text */
      }
      throw new Error(`${this.account.kind} API ${res.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`)
    }
    return res.json()
  }

  async username(): Promise<string> {
    const u = await this.request('/user')
    return this.account.kind === 'github' ? u.login : u.username
  }

  async repositories(query = ''): Promise<RemoteRepo[]> {
    if (this.account.kind === 'github') {
      const list: Json[] = await this.request('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member')
      const q = query.toLowerCase()
      return list
        .filter((r) => !q || r.full_name.toLowerCase().includes(q))
        .map((r) => ({
          id: String(r.id),
          fullName: r.full_name,
          cloneHttps: r.clone_url,
          cloneSsh: r.ssh_url,
          webUrl: r.html_url,
          description: r.description ?? '',
          updatedAt: r.updated_at
        }))
    }
    const search = query ? `&search=${encodeURIComponent(query)}` : ''
    const list: Json[] = await this.request(`/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at${search}`)
    return list.map((p) => ({
      id: String(p.id),
      fullName: p.path_with_namespace,
      cloneHttps: p.http_url_to_repo,
      cloneSsh: p.ssh_url_to_repo,
      webUrl: p.web_url,
      description: p.description ?? '',
      updatedAt: p.last_activity_at
    }))
  }

  async pullRequests(repo: string, state: 'open' | 'closed' | 'all'): Promise<PullRequest[]> {
    if (this.account.kind === 'github') {
      const list: Json[] = await this.request(`/repos/${repo}/pulls?state=${state}&per_page=100&sort=updated&direction=desc`)
      return list.map(githubPr)
    }
    const glState = state === 'open' ? 'opened' : state
    const list: Json[] = await this.request(
      `/projects/${encodeURIComponent(repo)}/merge_requests?state=${glState}&per_page=100&order_by=updated_at`
    )
    return list.map(gitlabMr)
  }

  async createPullRequest(repo: string, pr: NewPullRequest): Promise<PullRequest> {
    if (this.account.kind === 'github') {
      return githubPr(await this.request(`/repos/${repo}/pulls`, 'POST', { title: pr.title, body: pr.body, head: pr.source, base: pr.target, draft: pr.draft }))
    }
    return gitlabMr(
      await this.request(`/projects/${encodeURIComponent(repo)}/merge_requests`, 'POST', {
        source_branch: pr.source,
        target_branch: pr.target,
        title: pr.draft ? `Draft: ${pr.title}` : pr.title,
        description: pr.body
      })
    )
  }
}

function githubPr(p: Json): PullRequest {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    author: p.user?.login ?? '',
    state: p.merged_at ? 'merged' : p.state,
    sourceBranch: p.head?.ref ?? '',
    targetBranch: p.base?.ref ?? '',
    webUrl: p.html_url,
    draft: !!p.draft,
    updatedAt: p.updated_at,
    body: p.body ?? ''
  }
}

function gitlabMr(m: Json): PullRequest {
  return {
    id: m.id,
    number: m.iid,
    title: m.title,
    author: m.author?.username ?? '',
    state: m.state,
    sourceBranch: m.source_branch,
    targetBranch: m.target_branch,
    webUrl: m.web_url,
    draft: !!(m.draft ?? m.work_in_progress),
    updatedAt: m.updated_at,
    body: m.description ?? ''
  }
}

/**
 * Normalizes what the user typed into the API base we store.
 * - GitHub: empty or github.com -> https://api.github.com; Enterprise Server web URL -> <url>/api/v3
 * - GitLab: empty -> https://gitlab.com; self-managed web URL (e.g. https://gitlab.nexon.com,
 *   or a sub-path install like https://host/gitlab) is kept as is, /api/v4 is added per request
 */
export function normalizeBaseUrl(kind: ProviderKind, input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`
  if (kind === 'github') {
    if (!url || /^https?:\/\/(www\.)?github\.com$/i.test(url) || /^https?:\/\/api\.github\.com$/i.test(url)) return 'https://api.github.com'
    return /\/api\/v3$/i.test(url) ? url : `${url}/api/v3`
  }
  if (!url) return 'https://gitlab.com'
  return url.replace(/\/api\/v4$/i, '')
}

/** Web root of an account: what remotes and browser links use. */
export function accountWebUrl(account: Pick<ProviderAccount, 'kind' | 'baseUrl'>): URL {
  const u = new URL(account.baseUrl)
  if (account.kind === 'github') {
    if (u.host.toLowerCase() === 'api.github.com') return new URL('https://github.com')
    u.pathname = u.pathname.replace(/\/api\/v3\/?$/i, '')
  }
  return u
}

/** Host (with port) used by git credential requests, e.g. gitlab.nexon.com or host:8443. */
export function accountHost(account: Pick<ProviderAccount, 'kind' | 'baseUrl'>): string {
  return accountWebUrl(account).host.toLowerCase()
}

/** URL prefix git credential config is scoped to, e.g. https://gitlab.nexon.com */
export function accountCredentialScope(account: Pick<ProviderAccount, 'kind' | 'baseUrl'>): string {
  const u = accountWebUrl(account)
  return `${u.protocol}//${u.host.toLowerCase()}`
}

/**
 * Matches a git remote URL to an account and returns the provider repo path.
 * Compares host names only, because SSH remotes use a different port than the web UI,
 * and strips a sub-path install prefix from https remotes.
 */
export function matchRemoteToAccount<A extends Pick<ProviderAccount, 'kind' | 'baseUrl'>>(
  url: string,
  accounts: A[]
): { account: A; repoPath: string } | null {
  const parsed = parseRemoteUrl(url)
  if (!parsed) return null
  for (const account of accounts) {
    const web = accountWebUrl(account)
    if (web.hostname.toLowerCase() !== parsed.host) continue
    const prefix = web.pathname.replace(/^\/+|\/+$/g, '')
    let repoPath = parsed.path
    if (prefix && repoPath.startsWith(prefix + '/')) repoPath = repoPath.slice(prefix.length + 1)
    if (repoPath.includes('/')) return { account, repoPath }
  }
  return null
}

/** Extracts host and `owner/repo` path from https, ssh and scp-like git remote URLs. */
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  const trimmed = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed)
  if (/^[a-z][a-z+.-]*:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      host = u.hostname.toLowerCase()
      path = u.pathname
    } catch {
      return null
    }
  } else if (scp) {
    host = scp[1].toLowerCase()
    path = scp[2]
  } else return null
  path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  if (!path.includes('/')) return null
  return { host, path }
}
