import { promises as fs } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AskpassServer, classifyPrompt, stripUser, type AskpassHandler } from '../src/main/auth/askpass'
import { runGit, setGitDefaults } from '../src/main/git/exec'

describe('classifyPrompt', () => {
  it('recognises git and ssh prompts', () => {
    expect(classifyPrompt("Username for 'https://gitlab.example.com': ")).toEqual({ kind: 'username', url: 'https://gitlab.example.com' })
    expect(classifyPrompt("Password for 'https://kim@gitlab.example.com': ")).toEqual({ kind: 'password', url: 'https://kim@gitlab.example.com' })
    expect(classifyPrompt("Enter passphrase for key '/home/kim/.ssh/id_ed25519': ")).toEqual({ kind: 'passphrase', key: '/home/kim/.ssh/id_ed25519' })
    expect(classifyPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? ').kind).toBe('hostkey')
    expect(classifyPrompt('Token: ')).toEqual({ kind: 'text', secret: true })
  })

  it('strips user info from URLs', () => {
    expect(stripUser('https://kim@gitlab.example.com')).toBe('https://gitlab.example.com')
    expect(stripUser('https://gitlab.example.com')).toBe('https://gitlab.example.com')
  })
})

describe('AskpassServer with real git', () => {
  let dir: string
  let server: AskpassServer
  let emptyConfig: string
  const prompts: string[] = []
  let answers: (string | null)[] = []
  const handler: AskpassHandler = {
    async credential(f) {
      const scope = `${f.protocol}://${f.host}`
      if (scope === 'https://gitlab.example.com') return { username: 'kim', password: 'glpat-secret' }
      if (scope === 'http://gitlab.corp.local:8080') return { username: 'kim', password: 'http-token' }
      return null
    },
    async prompt(text) {
      prompts.push(text)
      return answers.shift() ?? null
    }
  }

  // Isolate from the machine's system/global config so no real helper (e.g. GCM) runs.
  const fill = (host: string, protocol = 'https') =>
    runGit(['credential', 'fill'], {
      cwd: dir,
      input: `protocol=${protocol}\nhost=${host}\n\n`,
      allowFailure: true,
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig }
    })

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'gitdesk-askpass-'))
    emptyConfig = join(dir, 'empty.gitconfig')
    await fs.writeFile(emptyConfig, '')
    server = new AskpassServer(handler, process.execPath)
    await server.start(join(dir, 'bin'))
    setGitDefaults(server.env(), () => server.configArgs(['https://gitlab.example.com', 'http://gitlab.corp.local:8080']))
  })

  afterAll(async () => {
    setGitDefaults({}, () => [])
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('supplies the account token as credential helper for a connected host', async () => {
    const r = await fill('gitlab.example.com')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('username=kim\n')
    expect(r.stdout).toContain('password=glpat-secret\n')
  })

  it('supports self-managed servers on http with a port', async () => {
    const r = await fill('gitlab.corp.local:8080', 'http')
    expect(r.stdout).toContain('password=http-token\n')
  })

  it('asks the user through askpass for other hosts', async () => {
    prompts.length = 0
    answers = ['lee', 'pw123']
    const r = await fill('other.example.com')
    expect(r.code).toBe(0)
    expect(prompts[0]).toMatch(/^Username for 'https:\/\/other\.example\.com'/)
    expect(prompts[1]).toMatch(/^Password for 'https:\/\/lee@other\.example\.com'/)
    expect(r.stdout).toContain('username=lee\n')
    expect(r.stdout).toContain('password=pw123\n')
  })

  it('fails the git operation when the user cancels', async () => {
    answers = []
    const r = await fill('other.example.com')
    expect(r.code).not.toBe(0)
  })

  it('overrides existing global helpers only for connected hosts', async () => {
    const globalConfig = join(dir, 'global.gitconfig')
    // Stands in for GCM / store configured in ~/.gitconfig.
    await fs.writeFile(globalConfig, '[credential]\n\thelper = "!f() { echo username=from-global; echo password=global-pw; }; f"\n')
    const withGlobal = (host: string) =>
      runGit(['credential', 'fill'], {
        cwd: dir,
        input: `protocol=https\nhost=${host}\n\n`,
        allowFailure: true,
        env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig }
      })
    expect((await withGlobal('gitlab.example.com')).stdout).toContain('password=glpat-secret\n')
    prompts.length = 0
    const other = await withGlobal('other.example.com')
    expect(other.stdout).toContain('password=global-pw\n')
    expect(prompts).toEqual([])
  })

  it('rejects connections without the per-run secret', async () => {
    const env = server.env()
    const reply = await new Promise<string>((resolve) => {
      const s = connect(env.GITDESK_ASKPASS_SOCKET)
      let data = ''
      s.on('data', (d) => (data += d))
      s.on('close', () => resolve(data))
      s.on('error', () => resolve(data))
      s.write(JSON.stringify({ secret: 'wrong', type: 'prompt', prompt: 'x' }) + '\n')
    })
    expect(reply).toBe('')
  })
})
