// Commit search index, modelled on GitKraken 12.6's commitSearch worker (worker.bundle.js
// module 617): MiniSearch over message/author/email/sha, word segmentation with
// Intl.Segmenter, every word must match (AND) as a prefix, and the sha field is searched
// only for hex-looking words. Results come back in graph order, not by score.
import MiniSearch from 'minisearch'

export interface SearchDoc {
  /** Row index in the graph */
  id: number
  sha: string
  message: string
  author: string
  authorEmail: string
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const HEX = /^[\da-f]{4,}$/i
const EMOJI = /^\p{Emoji_Presentation}+$/u
const TEXT_FIELDS = ['message', 'author', 'authorEmail']

function segments(text: string): Intl.SegmentData[] {
  return [...segmenter.segment(text.toLocaleLowerCase())]
}

export function createCommitIndex(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>({
    fields: ['message', 'author', 'authorEmail', 'sha'],
    storeFields: ['sha'],
    // Index whole sha and email as single terms but split messages into words.
    tokenize: (text, field) => (field === 'sha' || field === 'authorEmail' ? [text] : segments(text).filter((s) => s.isWordLike || EMOJI.test(s.segment)).map((s) => s.segment)),
    processTerm: (term) => term.toLocaleLowerCase()
  })
}

export interface SearchFilter {
  /** Lower-cased author emails to keep; undefined = all authors */
  authorEmails?: Set<string>
}

/** Returns matching graph row ids in ascending (graph) order. */
export function searchCommits(index: MiniSearch<SearchDoc>, docs: Map<number, SearchDoc>, query: string, filter: SearchFilter = {}): number[] {
  const words = segments(query)
    .filter((s) => s.isWordLike || EMOJI.test(s.segment))
    .map((s) => s.segment)
  const keep = (id: number): boolean => {
    if (!filter.authorEmails) return true
    const d = docs.get(id)
    return !!d && filter.authorEmails.has(d.authorEmail.toLowerCase())
  }
  if (!words.length) {
    return filter.authorEmails ? [...docs.keys()].filter(keep).sort((a, b) => a - b) : []
  }
  const results = index.search(
    {
      combineWith: 'AND',
      queries: words.map((w) => ({ queries: [w], fields: HEX.test(w) ? [...TEXT_FIELDS, 'sha'] : TEXT_FIELDS }))
    },
    { prefix: true, filter: (r) => keep(r.id as number) }
  )
  return results.map((r) => r.id as number).sort((a, b) => a - b)
}
