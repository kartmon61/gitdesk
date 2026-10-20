# gitdesk

GitKraken 을 대체하는 가벼운 데스크톱 Git 클라이언트. AI 기능 없이 Git 기능과 GitHub/GitLab 연동만 둔다. 사내 GitLab(Self-Managed, 예: https://gitlab.nexon.com)과 GitHub Enterprise Server 도 설정 → GitHub / GitLab 에서 서버 주소와 PAT 로 연결한다.

- Electron + React + TypeScript (Windows / macOS / Linux)
- Git 작업은 시스템 `git` 을 셸 없이 직접 호출 — 인증·hook·`.gitconfig` 가 터미널과 똑같이 동작한다
- 기능 목록과 구현 상태: [docs/features.md](docs/features.md)

## 설치

[Actions](https://github.com/kartmon61/gitdesk/actions/workflows/build.yml) 의 최신 `build` 실행 → Artifacts 에서 OS 별 설치 파일을 받는다.

| OS | 파일 | 비고 |
|----|------|------|
| Windows | `gitdesk Setup <버전>.exe` | 사용자 단위 설치, 경로 선택 가능, 바로가기 생성 |
| macOS (Apple Silicon) | `gitdesk-<버전>-arm64.dmg` | M1 이상 |
| macOS (Intel) | `gitdesk-<버전>-x64.dmg` | |
| Linux | `.AppImage`, `.deb` | |

- PC 에 git 이 설치돼 있어야 한다 (앱에 내장하지 않음). macOS 는 Xcode Command Line Tools 의 git 또는 Homebrew git.
- macOS 빌드는 애드혹 서명만 돼 있고 공증(notarization)되지 않았다. 인터넷/메신저로 받은 경우 "손상되었기 때문에 열 수 없습니다" 가 뜨면 앱을 Applications 로 옮긴 뒤 한 번 실행한다:
  ```bash
  xattr -cr /Applications/gitdesk.app
  ```
- macOS 에서 Finder/Dock 으로 실행해도 로그인 셸의 PATH 를 읽어 Homebrew 의 git, git-lfs, gpg 를 찾는다.

## 설치 파일 만들기

설치 파일은 해당 OS 에서 빌드한다 (electron-builder). macOS 앱은 Windows 에서 만들 수 없다.

- **GitHub Actions**: Actions → `build` → Run workflow, 또는 `v*` 태그 push. mac/win/linux 를 한 번에 빌드해 Artifacts 로 올린다.
- **로컬**:

| OS | 명령 | 결과물 (`dist/`) |
|----|------|------------------|
| Windows | `npm run dist:win` | `gitdesk Setup <버전>.exe` |
| macOS | `npm run dist:mac` | `gitdesk-<버전>-{arm64,x64}.dmg`, `.zip` |
| Linux | `npm run dist:linux` | `.AppImage`, `.deb` |

Windows 에서 최소 PATH 로 빌드할 때는 PowerShell 경로(`C:WindowsSystem32WindowsPowerShell1.0`)가 필요하다. 첫 빌드에서 NSIS 캐시 EPERM 이 나면(백신 잠금) 한 번 더 실행한다.

## 개발 실행

```bash
npm install
npm run dev      # 개발 모드
npm run build    # out/ 에 빌드
npm start        # 빌드 결과 실행
npm test         # 단위 + 실제 git 통합 테스트
npm run typecheck
```

npm 11 은 install script 를 기본으로 막는다. 처음 설치 후 `npm install-scripts approve electron esbuild` 가 필요하다.

> Windows 에서 `npm install` 이 `'node'은(는) ... 명령이 아닙니다` 로 실패하면 PATH 가 너무 길어 cmd 자식 프로세스에서 잘린 것이다.
> 최소 PATH 를 export 하고 `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" install` 로 실행한다.

## 구조

| 경로 | 역할 |
|------|------|
| `src/main/git/exec.ts` | git 실행 (spawn, 셸 미경유, 비대화형 환경변수) |
| `src/main/git/parse.ts` | porcelain/plumbing 출력 파서, 부분 스테이징 패치 생성 |
| `src/main/git/repository.ts` | 저장소 작업 전체 + Undo/Redo 기록 |
| `src/main/integrations/providers.ts` | GitHub / GitLab REST |
| `src/main/store.ts` | 설정, 계정 (토큰은 Electron safeStorage 로 암호화) |
| `src/shared/api.ts` | 렌더러 ↔ 메인 계약. 렌더러는 `REPO_METHODS` 에 있는 메서드만 호출할 수 있다 |
| `src/shared/graph.ts` | 커밋 그래프 lane 배치 |
| `src/shared/commitSearch.ts` | 커밋 검색 (GitKraken 12.6 commitSearch 워커와 같은 구조: MiniSearch, 단어 AND·접두사, 16진수일 때만 SHA) |
| `src/shared/conflict.ts` | 충돌 마커 파싱/해결 결과 조립 |
| `src/renderer/` | UI |

## 단축키

macOS 에서는 Ctrl 대신 Cmd.

| 키 | 동작 |
|----|------|
| Ctrl+P / Ctrl+Shift+P | 명령 팔레트 |
| Ctrl+/ | 단축키 목록 |
| Ctrl+, | 설정 |
| Ctrl+O / Ctrl+N | 저장소 열기 / 클론 |
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | 새 탭 / 탭 닫기 / 닫은 탭 다시 열기 |
| Ctrl+Tab, Ctrl+1~9 | 탭 전환 |
| Ctrl+F | 커밋 검색 (Enter / Shift+Enter 로 다음·이전) |
| Ctrl+Alt+F | 사이드바 필터 |
| Ctrl+B | 브랜치 만들기 |
| Ctrl+L | 전체 fetch |
| Ctrl+Enter | 커밋 (메시지 입력창) |
| S / U | 선택 파일 스테이지 / 언스테이지 |
| Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) | Undo / Redo |
| Ctrl+J / Ctrl+K | 왼쪽 / 오른쪽 패널 접기 |
| Ctrl+` | git 콘솔 |
| Alt+T / Alt+O | 터미널 / 파일 탐색기에서 열기 |
| F5 | 새로고침 |
| ↑ ↓ / J K, PgUp PgDn, Ctrl+Home/End | 그래프에서 커밋 이동 |
| Shift+F10 | 선택 커밋 메뉴 |
| F7 / Shift+F7 | diff 다음·이전 변경 |
| Ctrl+= / Ctrl+- / Ctrl+0 | 확대 / 축소 / 원래 크기 |
| F11 | 전체 화면 |
| Esc | 맨 위 대화상자·메뉴·diff 하나 닫기 |
