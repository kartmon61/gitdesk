// Shows git/ssh authentication questions from the main process as dialogs.
import type { AskpassRequest } from '@shared/api'
import { bridge } from './actions'
import { confirm, form } from './dialogs'

export async function answerAskpass(req: AskpassRequest): Promise<void> {
  let answer: string | null = null
  if (req.kind === 'login') {
    const r = await form(req.title, [
      { name: 'username', label: '사용자 이름', required: true },
      { name: 'password', label: '비밀번호 또는 토큰', type: 'password', required: true }
    ], { message: `${req.message}\n자주 쓰는 GitHub/GitLab 이라면 설정에서 계정을 연결하면 다시 묻지 않습니다.`, okLabel: '로그인' })
    if (r) answer = JSON.stringify({ username: String(r.username), password: String(r.password) })
  } else if (req.kind === 'confirm') {
    answer = (await confirm(req.title, req.message, '연결 (yes)', true)) ? 'yes' : 'no'
  } else {
    const r = await form(req.title, [{ name: 'value', label: req.message, type: req.kind === 'secret' ? 'password' : 'text' }], { okLabel: '확인' })
    if (r) answer = String(r.value)
  }
  await bridge.app.answerAskpass(req.id, answer)
}
