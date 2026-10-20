import { describe, expect, it } from 'vitest'
import type { AskpassRequest } from '../src/shared/api'
import { createAskpassHandler } from '../src/main/auth/handler'

function setup(answers: (string | null)[] = []) {
  const asked: Omit<AskpassRequest, 'id'>[] = []
  let t = 0
  const handler = createAskpassHandler({
    accountFor: async (scope) => (scope === 'https://gitlab.example.com' ? { username: 'kim', password: 'tok' } : null),
    ask: async (req) => {
      asked.push(req)
      return answers.shift() ?? null
    },
    now: () => t
  })
  return { handler, asked, advance: (ms: number) => (t += ms) }
}

describe('askpass handler', () => {
  it('answers credential requests only for connected https hosts', async () => {
    const { handler } = setup()
    expect(await handler.credential({ protocol: 'https', host: 'gitlab.example.com' })).toEqual({ username: 'kim', password: 'tok' })
    expect(await handler.credential({ protocol: 'https', host: 'other.com' })).toBeNull()
    expect(await handler.credential({ protocol: 'http', host: 'gitlab.example.com' })).toBeNull()
  })

  it('asks once for username and password together', async () => {
    const { handler, asked } = setup([JSON.stringify({ username: 'lee', password: 'pw' })])
    expect(await handler.prompt("Username for 'https://other.com': ")).toBe('lee')
    expect(await handler.prompt("Password for 'https://lee@other.com': ")).toBe('pw')
    expect(asked.map((a) => a.kind)).toEqual(['login'])
  })

  it('forgets a pending password after the TTL', async () => {
    const { handler, asked, advance } = setup([JSON.stringify({ username: 'lee', password: 'pw' }), 'typed'])
    await handler.prompt("Username for 'https://other.com': ")
    advance(121_000)
    expect(await handler.prompt("Password for 'https://lee@other.com': ")).toBe('typed')
    expect(asked.map((a) => a.kind)).toEqual(['login', 'secret'])
  })

  it('uses the account for askpass prompts on connected hosts without asking', async () => {
    const { handler, asked } = setup()
    expect(await handler.prompt("Username for 'https://gitlab.example.com': ")).toBe('kim')
    expect(await handler.prompt("Password for 'https://kim@gitlab.example.com': ")).toBe('tok')
    expect(asked).toEqual([])
  })

  it('answers no to an unknown host key when cancelled', async () => {
    const { handler } = setup([null])
    expect(await handler.prompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')).toBe('no')
  })
})
