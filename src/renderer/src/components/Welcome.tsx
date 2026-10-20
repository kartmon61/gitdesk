import type { ReactNode } from 'react'
import { bridge, errorText, openRepoPath } from '../actions'
import { useStore, toast } from '../store'
import { openClone } from './PullRequests'
import { openSettings } from './Settings'

export function Welcome(): ReactNode {
  const settings = useStore((s) => s.settings)
  const open = async (): Promise<void> => {
    const dir = await bridge.app.pickDirectory('Git 저장소 열기')
    if (dir) await openRepoPath(dir)
  }
  const init = async (): Promise<void> => {
    const dir = await bridge.app.pickDirectory('새 저장소를 만들 폴더')
    if (!dir) return
    try {
      await openRepoPath(await bridge.app.initRepository(dir))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  return (
    <div className="welcome">
      <div className="welcome-box">
        <h1>gitdesk</h1>
        <div className="row">
          <button className="btn primary" onClick={open}>
            저장소 열기
          </button>
          <button className="btn" onClick={openClone}>
            클론
          </button>
          <button className="btn" onClick={init}>
            새 저장소 (init)
          </button>
          <span className="grow" />
          <button className="btn" onClick={openSettings}>
            설정
          </button>
        </div>
        {!!settings?.recentRepos.length && (
          <>
            <div className="dim">최근 저장소</div>
            <div className="recent">
              {settings.recentRepos.map((p) => (
                <div key={p} className="item" onClick={() => openRepoPath(p)} title={p}>
                  <strong>{p.split(/[\\/]/).pop()}</strong>
                  <span className="dim ellipsis">{p}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
