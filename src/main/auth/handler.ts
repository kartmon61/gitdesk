import type { AskpassRequest } from '@shared/api'
import { classifyPrompt, stripUser, type AskpassHandler, type Credential } from './askpass'

export interface AskpassDeps {
  /** Account credential for a URL scope such as https://gitlab.nexon.com (host may include :port). */
  accountFor(scope: string): Promise<Credential | null>
  /** Shows a question to the user; null when cancelled or no window. */
  ask(req: Omit<AskpassRequest, 'id'>): Promise<string | null>
  now?: () => number
}

/** Passwords entered together with a username live this long, only in memory. */
const PENDING_TTL_MS = 120_000

export function createAskpassHandler(deps: AskpassDeps): AskpassHandler {
  const now = deps.now ?? Date.now
  const pending = new Map<string, { password: string; at: number }>()

  const takePending = (url: string): string | undefined => {
    const key = stripUser(url)
    const p = pending.get(key)
    pending.delete(key)
    return p && now() - p.at < PENDING_TTL_MS ? p.password : undefined
  }

  return {
    async credential(fields) {
      if (!fields.host || !/^https?$/.test(fields.protocol ?? '')) return null
      return deps.accountFor(`${fields.protocol}://${fields.host.toLowerCase()}`)
    },

    async prompt(text) {
      const p = classifyPrompt(text)
      switch (p.kind) {
        case 'username': {
          const u = new URL(p.url)
          const account = await deps.accountFor(`${u.protocol}//${u.host.toLowerCase()}`)
          if (account) {
            pending.set(stripUser(p.url), { password: account.password, at: now() })
            return account.username
          }
          const answer = await deps.ask({ kind: 'login', title: '로그인이 필요합니다', message: p.url })
          if (answer === null) return null
          const { username, password } = JSON.parse(answer) as Credential
          pending.set(stripUser(p.url), { password, at: now() })
          return username
        }
        case 'password': {
          const cached = takePending(p.url)
          if (cached !== undefined) return cached
          return deps.ask({ kind: 'secret', title: '비밀번호 / 토큰', message: p.url })
        }
        case 'passphrase':
          return deps.ask({ kind: 'secret', title: 'SSH 키 암호', message: p.key })
        case 'hostkey': {
          const answer = await deps.ask({ kind: 'confirm', title: '처음 접속하는 SSH 서버', message: text })
          return answer === null ? 'no' : answer
        }
        default:
          return deps.ask({ kind: p.secret ? 'secret' : 'text', title: 'git 질문', message: text })
      }
    }
  }
}
