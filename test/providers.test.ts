import { describe, expect, it } from 'vitest'
import { ProviderClient, accountCredentialScope, accountHost, matchRemoteToAccount, normalizeBaseUrl, parseRemoteUrl, type HttpFetch } from '../src/main/integrations/providers'

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'github.com', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'github.com', 'owner/repo'],
    ['ssh://git@gitlab.example.com:2222/group/sub/repo.git', 'gitlab.example.com', 'group/sub/repo'],
    ['https://user:pw@gitlab.example.com/group/repo', 'gitlab.example.com', 'group/repo']
  ])('%s', (url, host, path) => {
    expect(parseRemoteUrl(url)).toEqual({ host, path })
  })

  it('rejects local paths', () => {
    expect(parseRemoteUrl('C:/repos/x')).toBeNull()
    expect(parseRemoteUrl('/srv/git/x.git')).toBeNull()
  })
})

describe('accountHost', () => {
  it('maps the github API host to github.com', () => {
    expect(accountHost({ kind: 'github', baseUrl: 'https://api.github.com' })).toBe('github.com')
    expect(accountHost({ kind: 'gitlab', baseUrl: 'https://gitlab.example.com/' })).toBe('gitlab.example.com')
  })
})

describe('ProviderClient', () => {
  function fakeHttp(responses: Record<string, unknown>, calls: { url: string; init?: Parameters<HttpFetch>[1] }[]): HttpFetch {
    return async (url, init) => {
      calls.push({ url, init })
      const body = responses[url]
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        json: async () => body,
        text: async () => JSON.stringify(body ?? { message: 'Not Found' })
      }
    }
  }

  it('uses PRIVATE-TOKEN and /api/v4 for GitLab merge requests', async () => {
    const calls: { url: string; init?: Parameters<HttpFetch>[1] }[] = []
    const url = 'https://gl.test/api/v4/projects/infradev%2Fncsr-ai-api/merge_requests?state=opened&per_page=100&order_by=updated_at'
    const http = fakeHttp({ [url]: [{ id: 1, iid: 7, title: 't', author: { username: 'kim' }, state: 'opened', source_branch: 'f', target_branch: 'develop', web_url: 'w', draft: false, updated_at: 'u', description: 'd' }] }, calls)
    const client = new ProviderClient({ kind: 'gitlab', baseUrl: 'https://gl.test/' }, 'tok', http)
    const prs = await client.pullRequests('infradev/ncsr-ai-api', 'open')
    expect(prs[0]).toMatchObject({ number: 7, sourceBranch: 'f', targetBranch: 'develop', author: 'kim' })
    expect(calls[0].init?.headers?.['PRIVATE-TOKEN']).toBe('tok')
  })

  it('reports API errors with the provider message', async () => {
    const client = new ProviderClient({ kind: 'github', baseUrl: 'https://api.github.com' }, 'tok', fakeHttp({}, []))
    await expect(client.username()).rejects.toThrow('github API 404: Not Found')
  })
})

describe('self-managed servers', () => {
  it('normalizes what the user types', () => {
    expect(normalizeBaseUrl('gitlab', 'gitlab.nexon.com')).toBe('https://gitlab.nexon.com')
    expect(normalizeBaseUrl('gitlab', 'https://gitlab.nexon.com/')).toBe('https://gitlab.nexon.com')
    expect(normalizeBaseUrl('gitlab', 'https://gitlab.nexon.com/api/v4')).toBe('https://gitlab.nexon.com')
    expect(normalizeBaseUrl('gitlab', '')).toBe('https://gitlab.com')
    expect(normalizeBaseUrl('github', '')).toBe('https://api.github.com')
    expect(normalizeBaseUrl('github', 'https://github.com')).toBe('https://api.github.com')
    expect(normalizeBaseUrl('github', 'ghe.corp.com')).toBe('https://ghe.corp.com/api/v3')
  })

  it('derives web host and credential scope', () => {
    expect(accountHost({ kind: 'github', baseUrl: 'https://ghe.corp.com/api/v3' })).toBe('ghe.corp.com')
    expect(accountCredentialScope({ kind: 'gitlab', baseUrl: 'http://gitlab.corp.local:8080' })).toBe('http://gitlab.corp.local:8080')
    expect(accountCredentialScope({ kind: 'github', baseUrl: 'https://api.github.com' })).toBe('https://github.com')
  })

  const accounts = [
    { id: 'nexon', kind: 'gitlab' as const, baseUrl: 'https://gitlab.nexon.com' },
    { id: 'sub', kind: 'gitlab' as const, baseUrl: 'https://code.corp.com/gitlab' },
    { id: 'gh', kind: 'github' as const, baseUrl: 'https://api.github.com' }
  ]

  it.each([
    ['https://gitlab.nexon.com/infradev/ncsr-ai-api.git', 'nexon', 'infradev/ncsr-ai-api'],
    ['git@gitlab.nexon.com:infradev/nop/acs-ai-api.git', 'nexon', 'infradev/nop/acs-ai-api'],
    ['ssh://git@gitlab.nexon.com:2222/infradev/x.git', 'nexon', 'infradev/x'],
    ['https://code.corp.com/gitlab/team/app.git', 'sub', 'team/app'],
    ['git@github.com:kartmon61/my-brain.git', 'gh', 'kartmon61/my-brain']
  ])('matches %s', (url, id, path) => {
    const m = matchRemoteToAccount(url, accounts)
    expect(m?.account.id).toBe(id)
    expect(m?.repoPath).toBe(path)
  })

  it('does not match unknown hosts', () => {
    expect(matchRemoteToAccount('https://gitlab.com/a/b.git', accounts)).toBeNull()
  })
})
