import { describe, expect, it } from 'vitest'
import { createCommitIndex, searchCommits, type SearchDoc } from '../src/shared/commitSearch'

const docs: SearchDoc[] = [
  { id: 0, sha: 'abc1234def', message: 'Fix login redirect bug', author: 'Kim Jinho', authorEmail: 'jinho@nexon.co.kr' },
  { id: 1, sha: 'feed0000aa', message: '로그인 화면 개선', author: 'Lee', authorEmail: 'lee@x.com' },
  { id: 2, sha: '0123fixabc', message: 'Add search worker 🚀', author: 'Park', authorEmail: 'park@x.com' },
  { id: 3, sha: 'ffff9999bb', message: 'fix: typo in readme', author: 'Kim Jinho', authorEmail: 'jinho@nexon.co.kr' }
]

function setup() {
  const index = createCommitIndex()
  index.addAll(docs)
  return { index, map: new Map(docs.map((d) => [d.id, d])) }
}

describe('searchCommits', () => {
  it('requires every word to match as a prefix', () => {
    const { index, map } = setup()
    expect(searchCommits(index, map, 'fix log')).toEqual([0])
    expect(searchCommits(index, map, 'fi')).toEqual([0, 3])
  })

  it('returns results in graph order', () => {
    const { index, map } = setup()
    expect(searchCommits(index, map, 'kim')).toEqual([0, 3])
  })

  it('searches sha only for hex-looking words', () => {
    const { index, map } = setup()
    expect(searchCommits(index, map, 'feed')).toEqual([1])
    // "fix" is not hex, so the sha "0123fixabc" must not match it.
    expect(searchCommits(index, map, 'fix')).toEqual([0, 3])
  })

  it('matches Korean words and emoji', () => {
    const { index, map } = setup()
    expect(searchCommits(index, map, '로그인')).toEqual([1])
    expect(searchCommits(index, map, '🚀')).toEqual([2])
  })

  it('filters by author email', () => {
    const { index, map } = setup()
    expect(searchCommits(index, map, 'fix', { authorEmails: new Set(['nobody@x.com']) })).toEqual([])
    expect(searchCommits(index, map, '', { authorEmails: new Set(['park@x.com']) })).toEqual([2])
  })
})
