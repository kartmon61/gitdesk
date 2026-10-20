// Main-thread side of commit search. Indexing is chunked so search can start while a
// large history is still being added, mirroring GitKraken's INDEX_BATCH_SIZE of 500.
import type { Commit } from '@shared/types'
import type { WorkerRequest, WorkerResponse } from './worker'

const BATCH = 500

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const pending = new Map<number, (rows: number[]) => void>()
let nextId = 0

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  pending.get(ev.data.id)?.(ev.data.rows)
  pending.delete(ev.data.id)
}

function post(msg: WorkerRequest): void {
  worker.postMessage(msg)
}

export function indexCommits(repo: string, commits: Commit[]): void {
  post({ type: 'reset', repo })
  for (let i = 0; i < commits.length; i += BATCH) {
    const docs = commits.slice(i, i + BATCH).map((c, j) => ({
      id: i + j,
      sha: c.sha,
      message: c.subject,
      author: c.author,
      authorEmail: c.authorEmail
    }))
    post({ type: 'add', repo, docs })
  }
}

const latest = new Map<string, number>()

/**
 * Searches graph rows. A newer search in the same context supersedes older ones:
 * stale results resolve to null so callers can ignore them.
 */
export function search(repo: string, query: string, context = 'searchBar', authorEmails?: string[]): Promise<number[] | null> {
  const id = ++nextId
  latest.set(context, id)
  return new Promise((resolve) => {
    pending.set(id, (rows) => resolve(latest.get(context) === id ? rows : null))
    post({ type: 'search', repo, id, query, authorEmails })
  })
}
