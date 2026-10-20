import { useState, type ReactNode } from 'react'
import type { RebaseAction, RebaseTodoItem } from '@shared/types'
import { errorText, repoApi, run, shortSha } from '../actions'
import { openDialog } from '../dialogs'
import { toast } from '../store'

const ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: 'pick', label: 'pick' },
  { value: 'reword', label: 'reword' },
  { value: 'squash', label: 'squash' },
  { value: 'fixup', label: 'fixup' },
  { value: 'edit', label: 'edit' },
  { value: 'drop', label: 'drop' }
]

function RebaseDialog({ base, initial, close }: { base: string; initial: RebaseTodoItem[]; close: () => void }): ReactNode {
  const [items, setItems] = useState(initial)
  const [focus, setFocus] = useState(0)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const update = (i: number, patch: Partial<RebaseTodoItem>): void => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const move = (i: number, d: number): void =>
    setItems((xs) => {
      const j = i + d
      if (j < 0 || j >= xs.length) return xs
      const next = [...xs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const moveTo = (from: number, to: number): void =>
    setItems((xs) => {
      const next = [...xs]
      const [it] = next.splice(from, 1)
      next.splice(to, 0, it)
      return next
    })
  // GitKraken keys: P pick, R reword, S squash, F fixup, E edit, D drop; arrows move focus, Alt+arrows reorder.
  const KEYS: Record<string, RebaseAction> = { p: 'pick', r: 'reword', s: 'squash', f: 'fixup', e: 'edit', d: 'drop' }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    const k = e.key.toLowerCase()
    if (KEYS[k]) {
      e.preventDefault()
      update(focus, { action: KEYS[k] })
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const d = e.key === 'ArrowUp' ? -1 : 1
      if (e.altKey) {
        move(focus, d)
        setFocus((f) => Math.max(0, Math.min(items.length - 1, f + d)))
      } else setFocus((f) => Math.max(0, Math.min(items.length - 1, f + d)))
    }
  }
  // squash/fixup need a commit above them to fold into.
  const firstKept = items.findIndex((x) => x.action !== 'drop')
  const invalid = firstKept >= 0 && (items[firstKept].action === 'squash' || items[firstKept].action === 'fixup')

  return (
    <div className="dialog" style={{ width: 760 }}>
      <h3>대화형 리베이스 — {shortSha(base)} 이후 {items.length}개 커밋</h3>
      <div className="dim">위가 오래된 커밋입니다. 끌어서 순서를 바꾸고, 키보드 P(pick) R(reword) S(squash) F(fixup) E(edit) D(drop) · Alt+↑↓ 이동.</div>
      <div className="rebase-list" tabIndex={0} onKeyDown={onKey} ref={(el) => {
        if (el && document.activeElement === document.body) el.focus()
      }}>
        {items.map((it, i) => (
          <div
            key={it.sha}
            className={`rebase-item${i === focus ? ' focus' : ''}${dragFrom === i ? ' dragging' : ''}`}
            draggable
            onClick={() => setFocus(i)}
            onDragStart={(e) => {
              setDragFrom(i)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (dragFrom !== null && dragFrom !== i) moveTo(dragFrom, i)
              setFocus(i)
              setDragFrom(null)
            }}
            onDragEnd={() => setDragFrom(null)}
          >
            <span className="dim" style={{ cursor: 'grab' }}>⠿</span>
            <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0}>
              ▲
            </button>
            <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === items.length - 1}>
              ▼
            </button>
            <select value={it.action} onChange={(e) => update(i, { action: e.target.value as RebaseAction })}>
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="mono dim">{shortSha(it.sha)}</span>
            {it.action === 'reword' ? (
              <input className="grow" value={it.message ?? it.subject} onChange={(e) => update(i, { message: e.target.value })} />
            ) : (
              <span className="grow ellipsis" style={{ textDecoration: it.action === 'drop' ? 'line-through' : undefined }}>
                {it.subject}
              </span>
            )}
          </div>
        ))}
      </div>
      {invalid && <div style={{ color: 'var(--red)' }}>첫 커밋은 squash/fixup 할 수 없습니다.</div>}
      <div className="buttons">
        <button className="btn" onClick={() => setItems(initial)}>
          초기화 (Reset)
        </button>
        <span className="grow" />
        <button className="btn" onClick={close}>
          취소
        </button>
        <button
          className="btn primary"
          disabled={invalid}
          onClick={async () => {
            close()
            await run('대화형 리베이스', () => repoApi().interactiveRebase(base, items))
          }}
        >
          리베이스 시작
        </button>
      </div>
    </div>
  )
}

export async function openInteractiveRebase(base: string): Promise<void> {
  try {
    const items = await repoApi().rebaseTodo(base)
    if (!items.length) return toast('리베이스할 커밋이 없습니다 (HEAD 가 이미 기준에 포함돼 있음)')
    openDialog((close) => <RebaseDialog base={base} initial={items} close={close} />)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}
