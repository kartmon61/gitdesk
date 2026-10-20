// Commit graph lane layout. Pure and incremental-friendly: rows are computed top to bottom
// from commits in display order (newest first), as `git log --date-order` emits them.
import type { Commit } from './types'

export interface GraphEdge {
  /** Lane at the top of the row (where the line enters) */
  from: number
  /** Lane at the bottom of the row (where the line leaves) */
  to: number
  color: number
}

export interface GraphRow {
  /** Lane of this commit's node */
  lane: number
  color: number
  /** Lines passing through or ending at this row, from row top to row middle */
  up: GraphEdge[]
  /** Lines leaving this row, from row middle to row bottom */
  down: GraphEdge[]
  merge: boolean
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Maximum number of lanes used by any row */
  width: number
}

interface Lane {
  sha: string
  color: number
}

/**
 * Assigns each commit a lane. A lane is reserved for the next commit expected on it
 * (the first parent of the commit above); merges open new lanes for extra parents.
 * Colors stay with a branch line while it continues.
 */
export function layoutGraph(commits: Commit[]): GraphLayout {
  const lanes: (Lane | null)[] = []
  const rows: GraphRow[] = []
  let nextColor = 0
  let width = 0

  for (const c of commits) {
    // Lanes currently waiting for this commit.
    const waiting: number[] = []
    lanes.forEach((l, i) => {
      if (l && l.sha === c.sha) waiting.push(i)
    })

    let lane: number
    let color: number
    if (waiting.length) {
      lane = waiting[0]
      color = lanes[lane]!.color
    } else {
      lane = lanes.indexOf(null)
      if (lane === -1) lane = lanes.length
      color = nextColor++
    }

    // Lines entering this row: every active lane continues straight, except lanes that
    // were waiting for this commit, which bend into its node.
    const up: GraphEdge[] = []
    lanes.forEach((l, i) => {
      if (!l) return
      up.push({ from: i, to: waiting.includes(i) ? lane : i, color: l.color })
    })

    // This commit's lane now waits for its first parent; other waiting lanes close.
    for (const i of waiting) lanes[i] = null
    const [first, ...others] = c.parents
    lanes[lane] = first ? { sha: first, color } : null

    const down: GraphEdge[] = []
    lanes.forEach((l, i) => {
      if (l && i !== lane) down.push({ from: i, to: i, color: l.color })
    })
    if (first) down.push({ from: lane, to: lane, color })

    // Extra parents of a merge: join an existing lane waiting for that parent, or open one.
    for (const p of others) {
      let target = lanes.findIndex((l) => l?.sha === p)
      let pColor: number
      if (target === -1) {
        target = lanes.indexOf(null)
        if (target === -1) target = lanes.length
        pColor = nextColor++
        lanes[target] = { sha: p, color: pColor }
        down.push({ from: lane, to: target, color: pColor })
      } else {
        pColor = lanes[target]!.color
        down.push({ from: lane, to: target, color: pColor })
      }
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    width = Math.max(width, lanes.length, lane + 1)
    rows.push({ lane, color, up, down, merge: others.length > 0 })
  }

  return { rows, width }
}
