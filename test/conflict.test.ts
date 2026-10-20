import { describe, expect, it } from 'vitest'
import { buildOutput, parseConflicts, unresolvedCount, type ConflictSegment } from '../src/shared/conflict'

const text = ['top', '<<<<<<< HEAD', 'mine', '||||||| base', 'orig', '=======', 'yours', '>>>>>>> feature', 'bottom', ''].join('\n')

describe('parseConflicts', () => {
  it('splits common and diff3 conflict segments', () => {
    const segs = parseConflicts(text)
    expect(segs.map((s) => s.type)).toEqual(['common', 'conflict', 'common'])
    const c = segs[1] as ConflictSegment
    expect(c).toMatchObject({ ours: ['mine'], base: ['orig'], theirs: ['yours'], oursLabel: 'HEAD', theirsLabel: 'feature' })
  })

  it('round-trips unresolved conflicts unchanged', () => {
    expect(buildOutput(parseConflicts(text))).toBe(text)
  })

  it('applies resolutions', () => {
    const segs = parseConflicts(text)
    expect(unresolvedCount(segs)).toBe(1)
    ;(segs[1] as ConflictSegment).resolution = 'both'
    expect(unresolvedCount(segs)).toBe(0)
    expect(buildOutput(segs)).toBe('top\nmine\nyours\nbottom\n')
  })

  it('keeps an unterminated marker as text', () => {
    const t = 'a\n<<<<<<< x\nb\n'
    expect(parseConflicts(t)).toEqual([{ type: 'common', lines: ['a', '<<<<<<< x', 'b', ''] }])
  })
})
