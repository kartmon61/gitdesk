/// <reference lib="webworker" />
import type MiniSearch from 'minisearch'
import { createCommitIndex, searchCommits, type SearchDoc } from '@shared/commitSearch'

export type WorkerRequest =
  | { type: 'reset'; repo: string }
  | { type: 'add'; repo: string; docs: SearchDoc[] }
  | { type: 'search'; repo: string; id: number; query: string; authorEmails?: string[] }

export type WorkerResponse = { type: 'result'; id: number; rows: number[] }

interface Entry {
  index: MiniSearch<SearchDoc>
  docs: Map<number, SearchDoc>
}

const indexes = new Map<string, Entry>()

function entry(repo: string): Entry {
  let e = indexes.get(repo)
  if (!e) {
    e = { index: createCommitIndex(), docs: new Map() }
    indexes.set(repo, e)
  }
  return e
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  if (msg.type === 'reset') indexes.delete(msg.repo)
  else if (msg.type === 'add') {
    const e = entry(msg.repo)
    e.index.addAll(msg.docs)
    for (const d of msg.docs) e.docs.set(d.id, d)
  } else {
    const e = entry(msg.repo)
    const rows = searchCommits(e.index, e.docs, msg.query, { authorEmails: msg.authorEmails ? new Set(msg.authorEmails) : undefined })
    const res: WorkerResponse = { type: 'result', id: msg.id, rows }
    self.postMessage(res)
  }
}
