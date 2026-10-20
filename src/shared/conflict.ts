// Parses a working-tree file containing git conflict markers into editable segments.

export interface CommonSegment {
  type: 'common'
  lines: string[]
}

export type Resolution = 'ours' | 'theirs' | 'both' | 'theirs-ours' | 'base' | 'none' | 'custom'

export interface ConflictSegment {
  type: 'conflict'
  ours: string[]
  theirs: string[]
  /** Present when the file uses diff3/zdiff3 conflict style */
  base?: string[]
  baseLabel?: string
  oursLabel: string
  theirsLabel: string
  resolution: Resolution
  custom?: string[]
}

export type Segment = CommonSegment | ConflictSegment

const START = /^<{7}(?: (.*))?$/
const BASE = /^\|{7}(?: (.*))?$/
const MID = /^={7}$/
const END = /^>{7}(?: (.*))?$/

export function parseConflicts(text: string): Segment[] {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const segments: Segment[] = []
  let common: string[] = []
  let i = 0
  while (i < lines.length) {
    const start = START.exec(lines[i])
    if (!start) {
      common.push(lines[i++])
      continue
    }
    // Find the matching end; an unterminated marker is treated as ordinary text.
    let j = i + 1
    while (j < lines.length && !END.test(lines[j])) j++
    if (j >= lines.length) {
      common.push(lines[i++])
      continue
    }
    if (common.length) segments.push({ type: 'common', lines: common })
    common = []
    const ours: string[] = []
    const theirs: string[] = []
    let base: string[] | undefined
    let baseLabel: string | undefined
    let part: 'ours' | 'base' | 'theirs' = 'ours'
    for (let k = i + 1; k < j; k++) {
      const l = lines[k]
      const b = part === 'ours' ? BASE.exec(l) : null
      if (b) {
        part = 'base'
        base = []
        baseLabel = b[1]
      } else if (part !== 'theirs' && MID.test(l)) part = 'theirs'
      else if (part === 'ours') ours.push(l)
      else if (part === 'base') base!.push(l)
      else theirs.push(l)
    }
    segments.push({
      type: 'conflict',
      ours,
      theirs,
      base,
      baseLabel,
      oursLabel: start[1] ?? 'ours',
      theirsLabel: END.exec(lines[j])![1] ?? 'theirs',
      resolution: 'none'
    })
    i = j + 1
  }
  if (common.length) segments.push({ type: 'common', lines: common })
  return segments
}

export function resolvedLines(s: ConflictSegment): string[] | null {
  switch (s.resolution) {
    case 'ours':
      return s.ours
    case 'theirs':
      return s.theirs
    case 'both':
      return [...s.ours, ...s.theirs]
    case 'theirs-ours':
      return [...s.theirs, ...s.ours]
    case 'base':
      return s.base ?? []
    case 'custom':
      return s.custom ?? []
    default:
      return null
  }
}

export function unresolvedCount(segments: Segment[]): number {
  return segments.filter((s) => s.type === 'conflict' && s.resolution === 'none').length
}

/** Builds the output file. Unresolved conflicts keep their markers. */
export function buildOutput(segments: Segment[], eol = '\n'): string {
  const out: string[] = []
  for (const s of segments) {
    if (s.type === 'common') {
      out.push(...s.lines)
      continue
    }
    const r = resolvedLines(s)
    if (r) out.push(...r)
    else {
      out.push(`<<<<<<< ${s.oursLabel}`, ...s.ours)
      if (s.base) out.push(s.baseLabel ? `||||||| ${s.baseLabel}` : '|||||||', ...s.base)
      out.push('=======', ...s.theirs, `>>>>>>> ${s.theirsLabel}`)
    }
  }
  return out.join(eol)
}
