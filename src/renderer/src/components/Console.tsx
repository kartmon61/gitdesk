import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errorText, refresh, repoApi } from '../actions'
import { useStore } from '../store'

interface Entry {
  cmd: string
  out: string
  err: boolean
}

/** Runs arbitrary `git …` command lines without a shell. Covers anything the UI lacks. */
export function Console(): ReactNode {
  const set = useStore((s) => s.set)
  const [entries, setEntries] = useState<Entry[]>([])
  const [line, setLine] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [hpos, setHpos] = useState(-1)
  const [running, setRunning] = useState(false)
  const out = useRef<HTMLPreElement>(null)
  const input = useRef<HTMLInputElement>(null)

  // Disabling the input while a command runs drops focus; take it back afterwards.
  useEffect(() => {
    if (!running) input.current?.focus()
  }, [running])
  useEffect(() => {
    out.current?.scrollTo(0, out.current.scrollHeight)
  }, [entries])

  const exec = async (): Promise<void> => {
    const cmd = line.trim()
    if (!cmd) return
    setLine('')
    setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 100))
    setHpos(-1)
    if (cmd === 'clear') return setEntries([])
    setRunning(true)
    try {
      const r = await repoApi().console(cmd)
      setEntries((e) => [...e, { cmd, out: (r.stdout + r.stderr).trimEnd() || `(exit ${r.code})`, err: r.code !== 0 }])
    } catch (e) {
      setEntries((x) => [...x, { cmd, out: errorText(e), err: true }])
    } finally {
      setRunning(false)
      await refresh()
    }
  }

  return (
    <div className="console">
      <div className="diff-head">
        <strong className="grow">Git 콘솔</strong>
        <span className="dim">셸을 거치지 않고 git 에 인자를 그대로 전달합니다 · ↑↓ 기록 · clear</span>
        <button className="icon-btn" onClick={() => set({ consoleOpen: false })}>
          ✕
        </button>
      </div>
      <pre ref={out} className="mono">
        {entries.map((e, i) => (
          <div key={i}>
            <div style={{ color: 'var(--accent)' }}>$ git {e.cmd.replace(/^git\s+/, '')}</div>
            <div style={{ color: e.err ? 'var(--red)' : undefined }}>{e.out}</div>
          </div>
        ))}
      </pre>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void exec()
        }}
      >
        <span className="mono" style={{ alignSelf: 'center' }}>
          git
        </span>
        <input
          ref={input}
          className="grow mono"
          value={line}
          disabled={running}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault()
              const p = Math.min(hpos + 1, history.length - 1)
              setHpos(p)
              setLine(history[p])
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              const p = hpos - 1
              setHpos(p)
              setLine(p >= 0 ? history[p] : '')
            } else if (e.key === 'Escape') set({ consoleOpen: false })
          }}
          placeholder="log --oneline -n 20"
        />
        <button className="btn" disabled={running}>
          실행
        </button>
      </form>
    </div>
  )
}
