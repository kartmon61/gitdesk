// Command palette (Ctrl+P) and keyboard shortcut reference (Ctrl+/), modeled on GitKraken's.
import type { ReactNode } from 'react'
import { bridge, closeTab, openRepoPath, refresh, repoApi, run } from '../actions'
import { openDialog, pickFromList, type PickItem } from '../dialogs'
import { checkoutBranch, createBranch, createTag, popLatestStash, pull, pushBranch, renameBranch, stashSave } from '../menus'
import { activeRepo, getState, useStore } from '../store'
import { setUi, useUi } from '../ui'
import { discardAllChanges } from './RightPanel'
import { openCreatePullRequest, openClone } from './PullRequests'
import { openSettings } from './Settings'
import { applyPatch, bisectStart, fetchAll, openBranchPicker, openRepoPicker, patchAll } from './Toolbar'

export function setZoom(z: number): void {
  const zoom = Math.max(0.6, Math.min(2, Math.round(z * 10) / 10))
  useStore.setState({ zoom })
  document.documentElement.style.zoom = String(zoom)
}

async function pickFile(kind: 'history' | 'blame'): Promise<void> {
  const r = await repoApi().console('ls-files')
  const files = r.stdout.split('\n').filter(Boolean)
  pickFromList(
    files.map((f) => ({ label: f.split('/').pop()!, detail: f, onPick: () => getState().set({ overlay: { kind, path: f } }) })),
    '파일 이름 검색',
    kind === 'history' ? '파일 히스토리' : '파일 Blame'
  )
}

export function openCommandPalette(): void {
  const s = getState()
  const data = activeRepo()
  const cur = data?.branches.find((b) => b.current)
  const repo = s.active
  const items: PickItem[] = [
    { group: '저장소', label: '저장소 전환…', onPick: openRepoPicker },
    { group: '저장소', label: '저장소 열기…', hint: 'Ctrl+O', onPick: async () => { const d = await bridge.app.pickDirectory('저장소 열기'); if (d) await openRepoPath(d) } },
    { group: '저장소', label: '클론…', hint: 'Ctrl+N', onPick: openClone },
    { group: '저장소', label: '새 저장소 (init)…', hint: 'Ctrl+I', onPick: () => s.set({ active: undefined }) },
    ...(repo
      ? [
          { group: '저장소', label: '탭 닫기', hint: 'Ctrl+W', onPick: () => closeTab(repo) },
          { group: '저장소', label: '파일 탐색기에서 열기', hint: 'Alt+O', onPick: () => bridge.app.openInExplorer(repo) },
          { group: '저장소', label: '터미널에서 열기', hint: 'Alt+T', onPick: () => bridge.app.openTerminal(repo) },
          { group: '저장소', label: '저장소 정리 (git gc)', onPick: () => run('저장소 정리', () => repoApi().console('gc'), { success: '정리 완료' }) },
          { group: '저장소', label: '새로고침', hint: 'F5', onPick: () => refresh() },

          { group: '기본', label: 'Undo', hint: 'Ctrl+Z', onPick: () => run('Undo', () => repoApi().undo()) },
          { group: '기본', label: 'Redo', hint: 'Ctrl+Y', onPick: () => run('Redo', () => repoApi().redo()) },

          { group: '브랜치', label: '브랜치 만들기…', hint: 'Ctrl+B', onPick: () => createBranch() },
          { group: '브랜치', label: '브랜치 전환 (체크아웃)…', onPick: openBranchPicker },
          { group: '브랜치', label: '태그 만들기…', onPick: () => createTag() },
          { group: '브랜치', label: 'Annotated 태그 만들기…', onPick: () => createTag('HEAD', true) },
          { group: '브랜치', label: 'Fetch All', hint: 'Ctrl+L', onPick: fetchAll },
          { group: '브랜치', label: 'Pull', onPick: () => pull() },
          { group: '브랜치', label: 'Pull (rebase)', onPick: () => pull('rebase') },
          { group: '브랜치', label: 'Push', onPick: () => pushBranch() },
          ...(cur
            ? [
                { group: '브랜치', label: `브랜치 이름 변경 (${cur.name})…`, onPick: () => renameBranch(cur) },
                { group: '브랜치', label: `Pull/Merge Request 시작 (${cur.name})…`, onPick: () => openCreatePullRequest(cur.name) }
              ]
            : []),
          { group: '브랜치', label: '작업 디렉터리 변경 보기', onPick: () => s.set({ selection: { kind: 'wip' }, openDiff: null }) },

          { group: '파일', label: '모든 변경 스테이지', hint: 'Ctrl+Shift+S', onPick: () => run('모두 스테이지', () => repoApi().stageAll(), { full: false }) },
          { group: '파일', label: '모든 변경 언스테이지', hint: 'Ctrl+Shift+U', onPick: () => run('모두 언스테이지', () => repoApi().unstageAll(), { full: false }) },
          { group: '파일', label: '모든 변경 폐기…', onPick: discardAllChanges },
          { group: '파일', label: '파일 히스토리…', hint: 'Ctrl+Shift+H', onPick: () => pickFile('history') },
          { group: '파일', label: '파일 Blame…', onPick: () => pickFile('blame') },

          { group: 'Stash', label: 'Stash 만들기…', onPick: stashSave },
          { group: 'Stash', label: 'Stash 꺼내기 (Pop)', onPick: popLatestStash },
          { group: 'Stash', label: 'Stash 적용 (Apply)', onPick: () => run('Stash apply', () => repoApi().stashApply(0)) },

          { group: 'Patch', label: '모든 작업 변경으로 patch 만들기…', onPick: patchAll },
          { group: 'Patch', label: 'Patch 적용…', onPick: applyPatch },

          { group: '히스토리', label: '커밋 검색', hint: 'Ctrl+F', onPick: () => s.set({ searchOpen: true }) },
          { group: '히스토리', label: 'Reflog', onPick: () => s.set({ overlay: { kind: 'reflog' } }) },
          { group: '히스토리', label: 'Bisect 시작…', onPick: bisectStart },

          ...(data?.branches ?? [])
            .filter((b) => !b.current && !b.name.endsWith('/HEAD'))
            .map((b) => ({ group: '체크아웃', label: `체크아웃 ${b.name}`, detail: b.subject, onPick: () => checkoutBranch(b) }))
        ]
      : []),
    { group: '보기', label: '왼쪽 패널 토글', hint: 'Ctrl+J', onPick: () => s.set({ leftOpen: !getState().leftOpen }) },
    { group: '보기', label: '상세 패널 토글', hint: 'Ctrl+K', onPick: () => s.set({ rightOpen: !getState().rightOpen }) },
    { group: '보기', label: 'git 콘솔 토글', hint: 'Ctrl+`', onPick: () => s.set({ consoleOpen: !getState().consoleOpen }) },
    { group: '보기', label: '확대', hint: 'Ctrl+=', onPick: () => setZoom(getState().zoom + 0.1) },
    { group: '보기', label: '축소', hint: 'Ctrl+-', onPick: () => setZoom(getState().zoom - 0.1) },
    { group: '보기', label: '확대/축소 초기화', hint: 'Ctrl+0', onPick: () => setZoom(1) },
    { group: '보기', label: '전체 화면', hint: 'F11', onPick: () => bridge.app.toggleFullScreen() },
    { group: '보기', label: '트리 / 경로 보기 전환', onPick: () => setUi({ fileView: useUi.getState().fileView === 'tree' ? 'path' : 'tree' }) },
    { group: '보기', label: '키보드 단축키', hint: 'Ctrl+/', onPick: openShortcuts },
    { group: '설정', label: '설정', hint: 'Ctrl+,', onPick: openSettings }
  ]
  pickFromList(items, '명령 검색 (예: push, 체크아웃 main, stash)')
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    '일반',
    [
      ['Ctrl+P', '명령 팔레트'],
      ['Ctrl+/', '키보드 단축키'],
      ['Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z)', 'Undo / Redo'],
      ['Ctrl+F', '커밋 검색'],
      ['Ctrl+Alt+F', '왼쪽 패널 필터'],
      ['Ctrl+B', '브랜치 만들기'],
      ['Ctrl+L', 'Fetch All'],
      ['F5', '새로고침'],
      ['Esc', '열린 패널/diff 닫기'],
      ['Ctrl+,', '설정']
    ]
  ],
  [
    '커밋 / 스테이징',
    [
      ['S / U', '선택한 파일 스테이지 / 언스테이지'],
      ['Ctrl+Shift+S / Ctrl+Shift+U', '모두 스테이지 / 모두 언스테이지'],
      ['Ctrl+Enter', '커밋'],
      ['Ctrl+Shift+Enter', '모두 스테이지 후 커밋'],
      ['Ctrl+Shift+M', '커밋 메시지로 이동'],
      ['Ctrl/Shift+클릭', '파일 여러 개 선택'],
      ['F7 / Shift+F7', 'diff 에서 다음 / 이전 변경']
    ]
  ],
  [
    '그래프',
    [
      ['↑ ↓ / J K', '커밋 이동'],
      ['Shift+↑ ↓', '범위 선택'],
      ['Ctrl/Shift+클릭', '커밋 여러 개 선택 (비교, cherry-pick, squash)'],
      ['Ctrl+Home / Ctrl+End', '처음 / 마지막 커밋'],
      ['더블클릭 (브랜치 라벨)', '체크아웃'],
      ['브랜치 라벨 끌어 놓기', '병합 / 리베이스 / push / PR 메뉴']
    ]
  ],
  [
    '대화형 리베이스',
    [
      ['P R S F E D', 'pick / reword / squash / fixup / edit / drop'],
      ['Alt+↑ ↓ 또는 끌기', '순서 바꾸기']
    ]
  ],
  [
    '탭 / 창',
    [
      ['Ctrl+T', '새 탭'],
      ['Ctrl+W', '탭 닫기'],
      ['Ctrl+Shift+T', '닫은 탭 다시 열기'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', '다음 / 이전 탭'],
      ['Ctrl+1 … 9', 'N 번째 탭'],
      ['Ctrl+O / Ctrl+N / Ctrl+I', '열기 / 클론 / init'],
      ['Ctrl+J / Ctrl+K', '왼쪽 / 상세 패널 토글'],
      ['Ctrl+` / Alt+T / Alt+O', '콘솔 / 터미널 / 탐색기'],
      ['Ctrl+= / Ctrl+- / Ctrl+0', '확대 / 축소 / 초기화'],
      ['F11', '전체 화면']
    ]
  ]
]

function ShortcutsDialog({ close }: { close: () => void }): ReactNode {
  return (
    <div className="dialog" style={{ width: 640 }} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="row">
        <h3 className="grow">키보드 단축키</h3>
        <button className="icon-btn" autoFocus onClick={close}>
          ✕
        </button>
      </div>
      {SHORTCUTS.map(([group, rows]) => (
        <div key={group}>
          <div className="pick-group" style={{ paddingLeft: 0 }}>
            {group}
          </div>
          <table className="shortcuts">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

export function openShortcuts(): void {
  openDialog((close) => <ShortcutsDialog close={close} />)
}
