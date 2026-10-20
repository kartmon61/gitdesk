# gitdesk 기능 체크리스트

GitKraken Desktop 12.6.0 의 Git 기능을 기준으로 한다. AI 기능(커밋 메시지 생성, 요약, 에이전트)은 범위 밖이다.

근거:
- GitKraken 12.6.0 `app.asar` (SHA-256 `50949f5313f806821a1abd1c49ec8ae8930486a960957a07254cdb7e324f96f4`) 렌더러 번들 UI 라벨:
  Push / Force Push (with lease / without lease) / Pull / Fetch / Stash / Pop / Undo / Redo /
  Stage·Unstage Selection / Stage·Unstage This File / Discard Selection / Mark As Conflicted /
  cherry-pick 진행 / 외부 머지툴·에디터 설정 / LFS 감지
- 커밋 검색: worker 모듈 617(MiniSearch) + 렌더러 모듈 55614·61029·35902·75301 — `src/renderer/src/search/` 가 같은 구조를 따른다.

상태: [x] 구현, [ ] 미구현. 실제 앱(2026-10-19)에서 확인한 것: 그래프·ref 배지·WIP, 줄 단위 스테이징(CRLF 환경), 커밋 검색, 커밋 상세, 병합 충돌 → 3-way 에디터 → continue, 커밋 Undo/Redo, git 콘솔, 대화형 리베이스 다이얼로그. 연동(GitHub/GitLab)은 단위 테스트만 — 실계정 토큰으로는 아직 미검증.

## 저장소
- [x] 저장소 열기 / 최근 저장소 / 탭으로 여러 저장소
- [x] init / clone (URL, 연동 계정의 원격 목록에서)
- [x] 저장소별 user.name / user.email
- [x] 파일 시스템 변경 감지 → 자동 새로고침, 주기적 자동 fetch

## 그래프
- [x] 전체 ref 커밋 그래프 (lane, 머지선, 색상), 가상 스크롤
- [x] ref 배지(로컬/원격/태그/HEAD), WIP 노드
- [x] 커밋 검색 (메시지·작성자·이메일·SHA, 단어 AND·접두사, 다음/이전 순환)
- [ ] 작성자 필터 UI (검색 엔진은 authorEmails 필터 지원), 브랜치 표시/숨김

## 변경·커밋
- [x] 스테이지/언스테이지/폐기: 파일 · 헌크 · 줄 단위
- [x] 커밋 (요약+본문, amend, --no-verify)
- [ ] signoff 체크박스 (API 는 지원, UI 미노출)
- [x] diff 보기 (unified / side-by-side, 공백 무시), 바이너리 파일 표시
- [x] 파일 히스토리, blame
- [x] .gitignore 추가

## 브랜치·태그
- [x] 생성 / 체크아웃 / 이름 변경 / 삭제 (로컬·원격)
- [x] upstream 설정, ahead/behind 표시
- [x] 태그 생성(경량·annotated) / 삭제 / push
- [x] detached HEAD 체크아웃

## 원격
- [x] fetch (prune, all), pull (merge / rebase / ff-only), push (set-upstream, force-with-lease, force, tags)
- [x] 원격 추가 / 삭제 / 이름 변경 / URL 변경

## 히스토리 조작
- [x] merge (ff / no-ff / squash), rebase, interactive rebase (pick/reword/squash/fixup/drop/순서)
- [x] cherry-pick, revert, reset (soft / mixed / hard)
- [x] 진행 중 작업 continue / skip / abort (merge, rebase, cherry-pick, revert)
- [x] 충돌 해결: 충돌 파일 목록, 3-way(base/ours/theirs) 에디터, ours/theirs 일괄 선택, 해결 표시, 외부 머지툴
- [x] Undo / Redo (커밋, 체크아웃, 리셋, 브랜치 생성·삭제)

## 기타
- [x] stash (untracked 포함, keep-index, 메시지) / apply / pop / drop / stash 에서 브랜치
- [x] submodule 목록 / init·update / 열기
- [x] worktree 목록 / 추가 / 삭제
- [x] LFS 감지 / track / pull / fetch
- [x] bisect (start / good / bad / skip / reset)
- [x] patch 생성(format-patch) / 적용(apply, am)
- [x] reflog 보기
- [x] git 콘솔: 임의의 `git <args>` 실행 (셸 미경유) — UI 에 없는 명령의 출구

## 연동
- [x] 계정 연결 4종 — GitHub, GitHub Enterprise Server, GitLab.com, GitLab Self-Managed (예: https://gitlab.nexon.com; http·포트·하위 경로 설치 지원). PAT 는 OS 키체인 암호화 저장, 토큰 생성 페이지 바로가기
- [x] 연결 계정 토큰을 해당 서버(scheme://host[:port])의 git HTTPS 인증에 자동 사용 — 다른 서버는 GCM/store 등 기존 helper 그대로
- [x] 그 밖의 인증은 앱 다이얼로그로 (GIT_ASKPASS/SSH_ASKPASS: 아이디·비밀번호, SSH 키 passphrase, 호스트 키 확인)
- [x] 리모트 → 계정 매칭: https/ssh/scp 형식, SSH 포트가 웹과 달라도 호스트명으로 매칭
- [x] 원격 저장소 목록 → clone
- [x] PR / MR 목록 · 생성 · 브라우저로 열기, PR 브랜치 체크아웃
- [ ] PR / MR 앱 내 상세(댓글·리뷰·승인)

## UI 조작 (GitKraken 12.6 대비, 2026-10-19 보완)

근거: GitKraken 12.6 번들의 i18n 키(`en-us.json`)·단축키(`keyBindings/*.json`)·네이티브 메뉴 + help.gitkraken.com 문서.

- [x] 그래프: 브랜치/태그 열 분리, 열 표시/숨기기(헤더 우클릭·⚙)·폭 조절(저장됨), 작성자 이니셜 아바타, 날짜 상대/절대
- [x] 그래프: Ctrl/Shift 다중 선택 → 합쳐진 변경/두 커밋 비교, N개 cherry-pick·squash·revert·patch
- [x] 그래프: 브랜치 라벨 드래그 앤 드롭 → 병합 / 리베이스 / 대화형 리베이스 / fast-forward / reset / push / force push / upstream / PR 시작
- [x] 그래프: 선택 커밋 다시 클릭 시 해제, J/K·Shift+화살표·Ctrl+Home/End·PageUp/Down, "커밋 더 불러오기"
- [x] Solo / Hide (라벨 hover 아이콘, 우클릭, 섹션 전체), "보는 중 N/M · 모두 보기" 바
- [x] 커밋 메뉴: 작업 디렉터리와 비교, HEAD 메시지 수정, annotated 태그, worktree 만들기
- [x] 브랜치 메뉴: fast-forward(현재/upstream), Pull ff-only, reset 여기로, worktree, annotated 태그, Solo/Hide
- [x] 왼쪽 패널: 브랜치 폴더 트리, 다중 선택 일괄 삭제, 모든 섹션 필터(Ctrl+Alt+F), 접힘 상태 저장, 폭 조절, 원격 편집(push URL), worktree 잠금/브랜치 함께 삭제/prune, LFS push/prune
- [x] 툴바: 저장소·브랜치 breadcrumb(검색해서 전환), Pull 기본 동작 선택(Fetch/merge/ff-only/rebase), Push·Stash·Pop 드롭다운, Actions(명령 팔레트), 작업 중 버튼 비활성
- [x] Push 거부 시 Pull 후 재시도 / Force Push(with lease) 선택
- [x] 커밋 패널: 경로/트리 보기, 파일 다중 선택, staged↔unstaged 드래그, S/U, Ctrl+Enter·Ctrl+Shift+Enter·Ctrl+Shift+M, 커밋 후 push, 요약 72자 카운터, Ignore(파일/확장자/폴더)·파일 stash·patch·삭제·기본 프로그램 열기
- [x] 커밋/stash 파일 메뉴: 이 커밋의 파일로 복원
- [x] Diff: Hunk / Inline(파일 전체) / Split, 단어 단위 강조, 이전/다음 변경(F7), 줄 바꿈, 파일 보기, 히스토리·Blame·편집 버튼, 줄 우클릭 스테이지
- [x] 머지 도구: 이전/다음 충돌(Alt+↑↓), 모두 A/B, Ctrl+S 저장 후 다음 충돌 파일로
- [x] 대화형 리베이스: 드래그로 순서 변경, P/R/S/F/E/D 키, 초기화
- [x] 명령 팔레트(Ctrl+P), 단축키 표(Ctrl+/), 탭(Ctrl+T/W/Tab/1-9, Ctrl+Shift+T 다시 열기, 가운데 클릭 닫기, 드래그 순서, 우클릭 메뉴), 확대(Ctrl+=/-/0), F11, Ctrl+J/K 패널 토글
- [x] Bisect 배너의 Good/Bad/Skip 버튼
- [ ] 미구현: 그래프 안 stash 노드, ghost branch·hover 강조, 열 순서 드래그, Gitflow, 커밋 템플릿, GPG 서명 설정, 앱 내 파일 편집기
