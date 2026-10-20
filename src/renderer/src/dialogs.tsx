// Promise-based dialogs and context menus rendered by a single host component.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'

export interface Field {
  name: string
  label: string
  type?: 'text' | 'textarea' | 'checkbox' | 'select' | 'password' | 'directory'
  value?: string | boolean
  options?: { value: string; label: string }[]
  placeholder?: string
  required?: boolean
}

type Values = Record<string, string | boolean>

interface FormDialog {
  kind: 'form'
  title: string
  message?: string
  fields: Field[]
  okLabel?: string
  danger?: boolean
  resolve: (v: Values | null) => void
}

interface CustomDialog {
  kind: 'custom'
  render: (close: () => void) => ReactNode
}

export interface MenuItem {
  label: string
  onClick?: () => void
  disabled?: boolean
  separator?: boolean
  /** Shows a check column (true = checked) for toggles */
  checked?: boolean
  /** Right-aligned hint such as a keyboard shortcut */
  hint?: string
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

const useDialogs = create<{ stack: (FormDialog | CustomDialog)[]; menu: MenuState | null }>(() => ({ stack: [], menu: null }))

function push(d: FormDialog | CustomDialog): void {
  useDialogs.setState((s) => ({ stack: [...s.stack, d] }))
}

/** True while a dialog, picker or context menu is open; global shortcuts stand down. */
export function modalOpen(): boolean {
  const s = useDialogs.getState()
  return s.stack.length > 0 || !!s.menu
}

/** Text entry targets where single-key shortcuts must not fire. */
export function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)
}

function pop(d: FormDialog | CustomDialog): void {
  useDialogs.setState((s) => ({ stack: s.stack.filter((x) => x !== d) }))
}

export function form(title: string, fields: Field[], opts: { message?: string; okLabel?: string; danger?: boolean } = {}): Promise<Values | null> {
  return new Promise((resolve) => push({ kind: 'form', title, fields, ...opts, resolve }))
}

export async function prompt(title: string, label: string, value = '', placeholder?: string): Promise<string | null> {
  const r = await form(title, [{ name: 'v', label, value, placeholder, required: true }])
  return r ? String(r.v) : null
}

export async function confirm(title: string, message: string, okLabel = '확인', danger = false): Promise<boolean> {
  return (await form(title, [], { message, okLabel, danger })) !== null
}

/** Opens a custom dialog; `render` receives a close callback. */
export function openDialog(render: (close: () => void) => ReactNode): void {
  push({ kind: 'custom', render })
}

export function contextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  useDialogs.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}

function FormView({ d }: { d: FormDialog }): ReactNode {
  const [values, setValues] = useState<Values>(() => Object.fromEntries(d.fields.map((f) => [f.name, f.value ?? (f.type === 'checkbox' ? false : '')])))
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  // Focus something inside the form so Enter submits even when it has no text field (confirm, select-first forms).
  useEffect(() => {
    const f = formRef.current
    const target = first.current ?? f?.querySelector<HTMLElement>('input:not([type=checkbox]),textarea,select') ?? f?.querySelector<HTMLElement>('button[type=submit]')
    target?.focus()
  }, [])
  const close = (v: Values | null): void => {
    pop(d)
    d.resolve(v)
  }
  const missing = d.fields.some((f) => f.required && !String(values[f.name]).trim())
  return (
    <form
      ref={formRef}
      className="dialog"
      onSubmit={(e) => {
        e.preventDefault()
        if (!missing) close(values)
      }}
    >
      <h3>{d.title}</h3>
      {d.message && <div style={{ whiteSpace: 'pre-wrap' }}>{d.message}</div>}
      {d.fields.map((f, i) => {
        const set = (v: string | boolean): void => setValues((s) => ({ ...s, [f.name]: v }))
        if (f.type === 'checkbox')
          return (
            <label key={f.name} className="check">
              <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(e.target.checked)} /> {f.label}
            </label>
          )
        return (
          <label key={f.name}>
            {f.label}
            {f.type === 'textarea' ? (
              <textarea ref={i === 0 ? first : undefined} rows={5} value={String(values[f.name])} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />
            ) : f.type === 'select' ? (
              <select value={String(values[f.name])} onChange={(e) => set(e.target.value)}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === 'directory' ? (
              <div className="row">
                <input className="grow" value={String(values[f.name])} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const dir = await window.gitdesk.app.pickDirectory(f.label)
                    if (dir) set(dir)
                  }}
                >
                  찾아보기…
                </button>
              </div>
            ) : (
              <input
                ref={i === 0 ? first : undefined}
                type={f.type === 'password' ? 'password' : 'text'}
                value={String(values[f.name])}
                placeholder={f.placeholder}
                onChange={(e) => set(e.target.value)}
              />
            )}
          </label>
        )
      })}
      <div className="buttons">
        <button type="button" className="btn" onClick={() => close(null)}>
          취소
        </button>
        <button type="submit" className={`btn ${d.danger ? 'danger' : 'primary'}`} disabled={missing}>
          {d.okLabel ?? '확인'}
        </button>
      </div>
    </form>
  )
}

export function DialogHost(): ReactNode {
  const { stack, menu } = useDialogs()
  // One Escape closes only the topmost menu or dialog; captured so nothing behind it reacts too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      const s = useDialogs.getState()
      const top = s.stack[s.stack.length - 1]
      if (s.menu) useDialogs.setState({ menu: null })
      else if (top) {
        pop(top)
        if (top.kind === 'form') top.resolve(null)
      } else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])
  useEffect(() => {
    if (!menu) return
    const close = (): void => useDialogs.setState({ menu: null })
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  return (
    <>
      {stack.map((d, i) => (
        <div className="overlay" key={i}>
          {d.kind === 'form' ? <FormView d={d} /> : d.render(() => pop(d))}
        </div>
      ))}
      {menu && (
        <div
          className="menu"
          ref={(el) => {
            if (!el) return
            const r = el.getBoundingClientRect()
            el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`
            el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))}px`
          }}
          style={{ left: menu.x, top: menu.y, maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }}
        >
          {menu.items.map((it, i) =>
            it.separator ? (
              <div key={i} className="menu-sep" />
            ) : (
              <div
                key={i}
                className={`menu-item${it.disabled ? ' disabled' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (it.disabled) return
                  useDialogs.setState({ menu: null })
                  void Promise.resolve()
                    .then(() => it.onClick?.())
                    .catch((err: unknown) => window.dispatchEvent(new CustomEvent('gitdesk-error', { detail: err })))
                }}
              >
                {it.checked !== undefined && <span className="menu-check">{it.checked ? '✓' : ''}</span>}
                <span className="grow">{it.label}</span>
                {it.hint && <span className="dim menu-hint">{it.hint}</span>}
              </div>
            )
          )}
        </div>
      )}
    </>
  )
}

export interface PickItem {
  label: string
  detail?: string
  /** Group heading shown above the first item of each group */
  group?: string
  hint?: string
  onPick: () => void
}

/** Searchable list dialog used by the command palette and the breadcrumb pickers. */
function Picker({ title, items, placeholder, close }: { title?: string; items: PickItem[]; placeholder: string; close: () => void }): ReactNode {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = items.filter((it) => {
    const hay = `${it.label} ${it.detail ?? ''} ${it.group ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    list.current?.querySelector('.pick.sel')?.scrollIntoView({ block: 'nearest' })
  }, [idx])
  const pick = (it: PickItem | undefined): void => {
    if (!it) return
    close()
    it.onPick()
  }
  return (
    <div className="dialog picker" onClick={(e) => e.stopPropagation()}>
      {title && <div className="dim" style={{ fontSize: 12 }}>{title}</div>}
      <input
        autoFocus
        value={q}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setIdx((i) => Math.min(shown.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setIdx((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) pick(shown[idx])
        }}
      />
      <div className="pick-list" ref={list}>
        {shown.length === 0 && <div className="empty">일치하는 항목이 없습니다</div>}
        {shown.map((it, i) => (
          <div key={`${it.group}-${it.label}-${i}`}>
            {it.group && (i === 0 || shown[i - 1].group !== it.group) && <div className="pick-group">{it.group}</div>}
            <div className={`pick${i === idx ? ' sel' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => pick(it)}>
              <span className="grow ellipsis">{it.label}</span>
              {it.detail && <span className="dim ellipsis pick-detail">{it.detail}</span>}
              {it.hint && <span className="dim menu-hint">{it.hint}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function pickFromList(items: PickItem[], placeholder: string, title?: string): void {
  openDialog((close) => (
    <div className="picker-backdrop" onClick={close}>
      <Picker title={title} items={items} placeholder={placeholder} close={close} />
    </div>
  ))
}
