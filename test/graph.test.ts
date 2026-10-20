import { describe, expect, it } from 'vitest'
import { layoutGraph } from '../src/shared/graph'
import type { Commit } from '../src/shared/types'

const c = (sha: string, ...parents: string[]): Commit => ({
  sha,
  parents,
  author: '',
  authorEmail: '',
  authorTime: 0,
  committer: '',
  committerTime: 0,
  subject: sha
})

describe('layoutGraph', () => {
  it('keeps a linear history in one lane', () => {
    const { rows, width } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(width).toBe(1)
    expect(rows[2].down).toEqual([])
  })

  it('opens a lane for a merged branch and closes it at the fork point', () => {
    // m merges f into main; f and b both descend from a.
    const { rows, width } = layoutGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0])
    expect(width).toBe(2)
    expect(rows[0].merge).toBe(true)
    expect(rows[0].down).toContainEqual({ from: 0, to: 1, color: rows[1].color })
    // At a, lane 1 (waiting for a) bends into lane 0.
    expect(rows[3].up).toContainEqual({ from: 1, to: 0, color: rows[1].color })
  })

  it('places independent branch tips in separate lanes', () => {
    const { rows } = layoutGraph([c('x', 'a'), c('y', 'a'), c('a')])
    expect(rows[0].lane).toBe(0)
    expect(rows[1].lane).toBe(1)
    expect(rows[2].lane).toBe(0)
    expect(rows[1].color).not.toBe(rows[0].color)
  })

  it('reuses a freed lane', () => {
    const { rows } = layoutGraph([c('x', 'a'), c('y', 'a'), c('a'), c('z')])
    expect(rows[3].lane).toBe(0)
  })

  it('joins a merge parent into the lane already waiting for it', () => {
    // t1 and m both need p; the merge edge must target t1's lane.
    const { rows } = layoutGraph([c('t1', 'p'), c('m', 'q', 'p'), c('q', 'p'), c('p')])
    expect(rows[1].lane).toBe(1)
    expect(rows[1].down).toContainEqual({ from: 1, to: 0, color: rows[0].color })
  })
})
