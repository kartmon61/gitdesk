import { useEffect, useState, type ReactNode } from 'react'
import type { ProviderKind } from '@shared/types'
import { bridge, errorText, repoApi } from '../actions'
import { confirm, openDialog } from '../dialogs'
import { toast, useStore } from '../store'

type ServerType = 'gitlab.com' | 'gitlab-self' | 'github.com' | 'github-enterprise'

const SERVER_TYPES: { id: ServerType; label: string; kind: ProviderKind; selfHosted: boolean; placeholder?: string }[] = [
  { id: 'gitlab-self', label: 'GitLab Self-Managed', kind: 'gitlab', selfHosted: true, placeholder: 'https://gitlab.nexon.com' },
  { id: 'gitlab.com', label: 'GitLab.com', kind: 'gitlab', selfHosted: false },
  { id: 'github.com', label: 'GitHub', kind: 'github', selfHosted: false },
  { id: 'github-enterprise', label: 'GitHub Enterprise Server', kind: 'github', selfHosted: true, placeholder: 'https://github.example.com' }
]

/** Web root the user typed, for links; mirrors normalizeBaseUrl on the main side. */
function webRoot(type: (typeof SERVER_TYPES)[number], url: string): string {
  if (!type.selfHosted) return type.kind === 'github' ? 'https://github.com' : 'https://gitlab.com'
  const u = url.trim().replace(/\/+$/, '').replace(/\/api\/v[34]$/i, '')
  return !u ? '' : /^https?:\/\//i.test(u) ? u : `https://${u}`
}

function tokenPage(type: (typeof SERVER_TYPES)[number], url: string): string {
  const root = webRoot(type, url)
  if (!root) return ''
  return type.kind === 'github'
    ? `${root}/settings/tokens/new?scopes=repo,read:org,read:user&description=gitdesk`
    : `${root}/-/user_settings/personal_access_tokens?name=gitdesk&scopes=api,read_user,read_repository,write_repository`
}

function accountLabel(a: { kind: ProviderKind; baseUrl: string }): string {
  if (a.kind === 'github') return /\/\/api\.github\.com$/i.test(a.baseUrl) ? 'GitHub' : 'GitHub Enterprise'
  return /\/\/gitlab\.com$/i.test(a.baseUrl) ? 'GitLab.com' : 'GitLab Self-Managed'
}

function SettingsDialog({ close }: { close: () => void }): ReactNode {
  const { settings, accounts, active, set } = useStore()
  const [tab, setTab] = useState<'general' | 'repo' | 'accounts'>('general')
  const [gitPath, setGitPath] = useState(settings?.gitPath ?? '')
  const [autoFetch, setAutoFetch] = useState(String(settings?.autoFetchMinutes ?? 5))
  const [pullMode, setPullMode] = useState(settings?.defaultPullMode ?? 'merge')
  const [user, setUser] = useState({ name: '', email: '', gname: '', gemail: '' })
  const [serverType, setServerType] = useState<ServerType>('gitlab-self')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!active) return
    const api = repoApi(active)
    void Promise.all([api.getConfig('user.name'), api.getConfig('user.email'), api.console('config --global user.name'), api.console('config --global user.email')]).then(
      ([name, email, g1, g2]) => setUser({ name, email, gname: g1.stdout.trim(), gemail: g2.stdout.trim() })
    )
  }, [active])

  const saveGeneral = async (): Promise<void> => {
    const next = await bridge.app.updateSettings({ gitPath: gitPath.trim(), autoFetchMinutes: Math.max(0, Number(autoFetch) || 0), defaultPullMode: pullMode })
    set({ settings: next })
    toast('저장했습니다', 'success')
  }

  const saveUser = async (): Promise<void> => {
    if (!active) return
    try {
      const api = repoApi(active)
      await api.setConfig('user.name', user.name.trim())
      await api.setConfig('user.email', user.email.trim())
      if (user.gname.trim()) await api.setConfig('user.name', user.gname.trim(), 'global')
      if (user.gemail.trim()) await api.setConfig('user.email', user.gemail.trim(), 'global')
      toast('저장했습니다', 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const addAccount = async (): Promise<void> => {
    setBusy(true)
    try {
      const type = SERVER_TYPES.find((t) => t.id === serverType)!
      if (type.selfHosted && !baseUrl.trim()) throw new Error('서버 주소를 입력하세요 (예: https://gitlab.nexon.com)')
      const a = await bridge.app.addAccount(type.kind, type.selfHosted ? baseUrl.trim() : '', token.trim())
      set({ accounts: await bridge.app.listAccounts() })
      setToken('')
      toast(`${accountLabel(a)} ${a.username} 계정을 연결했습니다`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog" style={{ width: 620 }}>
      <div className="row">
        <h3 className="grow">설정</h3>
        <button className="icon-btn" onClick={close}>
          ✕
        </button>
      </div>
      <div className="row">
        {(['general', 'repo', 'accounts'] as const).map((t) => (
          <button key={t} className={`btn small${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)}>
            {{ general: '일반', repo: '사용자 정보', accounts: 'GitHub / GitLab' }[t]}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <>
          <label>
            git 실행 파일 (비우면 PATH 의 git)
            <input value={gitPath} onChange={(e) => setGitPath(e.target.value)} placeholder="C:\Program Files\Git\cmd\git.exe" />
          </label>
          <label>
            자동 fetch 간격 (분, 0 = 끔)
            <input value={autoFetch} onChange={(e) => setAutoFetch(e.target.value)} />
          </label>
          <label>
            Pull 기본 방식
            <select value={pullMode} onChange={(e) => setPullMode(e.target.value as typeof pullMode)}>
              <option value="merge">merge</option>
              <option value="rebase">rebase</option>
              <option value="ff-only">fast-forward only</option>
            </select>
          </label>
          <div className="buttons">
            <button className="btn primary" onClick={saveGeneral}>
              저장
            </button>
          </div>
        </>
      )}

      {tab === 'repo' && (
        <>
          {active ? (
            <>
              <div className="dim">이 저장소 전용 (비우면 전역 값 사용)</div>
              <label>
                이름
                <input value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value })} />
              </label>
              <label>
                이메일
                <input value={user.email} onChange={(e) => setUser({ ...user, email: e.target.value })} />
              </label>
              <div className="dim">전역 (~/.gitconfig)</div>
              <label>
                이름
                <input value={user.gname} onChange={(e) => setUser({ ...user, gname: e.target.value })} />
              </label>
              <label>
                이메일
                <input value={user.gemail} onChange={(e) => setUser({ ...user, gemail: e.target.value })} />
              </label>
              <div className="buttons">
                <button className="btn primary" onClick={saveUser}>
                  저장
                </button>
              </div>
            </>
          ) : (
            <div className="dim">저장소를 먼저 여세요.</div>
          )}
        </>
      )}

      {tab === 'accounts' && (
        <>
          {accounts.map((a) => (
            <div key={a.id} className="row">
              <span className="grow">
                {accountLabel(a)} · <strong>{a.username}</strong> <span className="dim">{a.baseUrl}</span>
              </span>
              <button
                className="btn small danger"
                onClick={async () => {
                  if (!(await confirm('계정 연결 해제', `${a.username} (${a.baseUrl}) 연결과 저장된 토큰을 지웁니다.`, '해제', true))) return
                  await bridge.app.removeAccount(a.id)
                  set({ accounts: await bridge.app.listAccounts() })
                }}
              >
                해제
              </button>
            </div>
          ))}
          <div className="dim" style={{ marginTop: 8 }}>
            계정 추가 — 토큰은 OS 키체인으로 암호화되어 이 PC 에만 저장됩니다. 연결하면 이 서버의 clone/fetch/pull/push 인증에도 자동으로 쓰입니다.
          </div>
          <div className="row">
            {SERVER_TYPES.map((t) => (
              <button key={t.id} className={`btn small${serverType === t.id ? ' primary' : ''}`} onClick={() => setServerType(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          {(() => {
            const type = SERVER_TYPES.find((t) => t.id === serverType)!
            const page = tokenPage(type, baseUrl)
            return (
              <>
                {type.selfHosted && (
                  <label>
                    서버 주소 (http/https, 포트·하위 경로 포함 가능)
                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={type.placeholder} />
                  </label>
                )}
                <div className="dim">
                  {type.kind === 'github' ? '필요 권한: repo, read:org, read:user' : '필요 권한: api, read_user, read_repository, write_repository'}
                  {page && (
                    <>
                      {' · '}
                      <a href="#" onClick={(e) => (e.preventDefault(), void bridge.app.openExternal(page))}>
                        토큰 만들기 페이지 열기
                      </a>
                    </>
                  )}
                </div>
              </>
            )
          })()}
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Personal Access Token" />
          <div className="buttons">
            <button className="btn primary" disabled={!token.trim() || busy} onClick={addAccount}>
              {busy ? '확인 중…' : '연결'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function openSettings(): void {
  openDialog((close) => <SettingsDialog close={close} />)
}
