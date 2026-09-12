/**
 * The pack corpus, as the dashboard reads it.
 *
 * `GET /corpus` lists every source document the configured packs grade against;
 * `GET /corpus/<id>` returns one with its text. The list is fetched once per server and
 * cached here, because it is a directory listing of files on the operator's own disk and
 * re-reading it on every open buys nothing.
 */

export interface CorpusDocument {
  /** `<pack>/<kind>/<case>` — also the path segment that fetches the text. */
  id: string
  pack: string
  /** `default` is prose notes; the reference pack also ships `transcript` and `exam`. */
  kind: string
  case: string
  /** The eval case grading this document. Several documents can share one. */
  caseName?: string
  path: string
  bytes: number
  lines: number
  preview: string
  note?: string
  difficulty?: number
  class?: string
  evals: string[]
}

export interface CorpusListing {
  documents: CorpusDocument[]
  synthetic: boolean
  note: string
}

const cache = new Map<string, CorpusListing>()

export const fetchCorpus = async (base: string): Promise<CorpusListing> => {
  const cached = cache.get(base)
  if (cached) return cached
  const res = await fetch(`${base}/corpus`, { cache: 'no-store' })
  if (!res.ok) {
    // A server older than this endpoint answers 404, which is a different problem from a
    // server that is down, and the difference is the whole of what the operator should do
    // next. Say which one it is.
    throw new Error(
      res.status === 404
        ? `${base} has no /corpus endpoint — it is running a build from before the corpus was served`
        : `could not list the corpus — HTTP ${res.status}`,
    )
  }
  const listing = (await res.json()) as CorpusListing
  cache.set(base, listing)
  return listing
}

export const fetchCorpusDocument = async (base: string, id: string): Promise<string> => {
  const res = await fetch(`${base}/corpus/${id.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`could not read ${id} — HTTP ${res.status}`)
  const body = (await res.json()) as { text?: string }
  if (typeof body.text !== 'string') throw new Error(`${id} came back without text`)
  return body.text
}

/** Plural label for a `documents` kind. `default` is the pack's unnamed prose corpus. */
export const kindLabel = (kind: string): string =>
  kind === 'default' ? 'Notes' : kind === 'transcript' ? 'Transcripts' : kind === 'exam' ? 'Exams' : kind

/**
 * Readable name for the answer key that grades a document, from its manifest key.
 *
 * `vitalSignsCases` is how a pack author names the file; "Vital signs" is what it holds.
 * Derived rather than tabled, so a pack this dashboard has never seen still groups under
 * words instead of under camelCase.
 */
export const familyLabel = (evalKey: string): string => {
  const words = evalKey
    .replace(/Cases$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  return words.length === 0 ? evalKey : words[0]!.toUpperCase() + words.slice(1)
}

/**
 * One browsable section: the documents of a single kind graded by a single answer key.
 *
 * The corpus is grouped this way because "62 notes" is not a thing anyone browses. Split by
 * what grades them it becomes vital signs, patient summaries and shock — three questions
 * rather than one pile — and the group a document is in is the first thing that tells you
 * whether it is the one you want.
 */
export interface CorpusGroup {
  key: string
  kind: string
  /** The manifest key of the first answer key that reaches these documents. */
  evalKey: string
  label: string
  documents: CorpusDocument[]
  /**
   * Documents clustered by the case they belong to, where a case owns more than one. A
   * patient-summary case is three notes of one record, and listing them flat repeats one
   * description three times while hiding that they are a sequence.
   */
  runs: { caseName: string; documents: CorpusDocument[] }[]
  /** Documents whose case owns only them, listed on their own. */
  singles: CorpusDocument[]
}

/**
 * Group documents by kind and grading answer key, preserving the server's ordering.
 *
 * A document graded by several answer keys is filed under the first: the vital-signs notes
 * that the note-format corpus also reads belong with the vital signs, and offering them
 * twice would make the corpus look bigger than it is.
 */
export const groupDocuments = (documents: readonly CorpusDocument[]): CorpusGroup[] => {
  const groups = new Map<string, CorpusGroup>()

  for (const doc of documents) {
    const evalKey = doc.evals[0] ?? ''
    const key = `${doc.kind}/${evalKey}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        kind: doc.kind,
        evalKey,
        label: evalKey ? familyLabel(evalKey) : 'Ungraded',
        documents: [],
        runs: [],
        singles: [],
      }
      groups.set(key, group)
    }
    group.documents.push(doc)
  }

  for (const group of groups.values()) {
    const byCase = new Map<string, CorpusDocument[]>()
    // A document no answer key reached has no case to be clustered by. Bucketing those
    // together under one absent key would invent a record out of everything unattributed
    // and label it with a case name that does not exist, so they never enter the map.
    const unattributed: CorpusDocument[] = []
    for (const doc of group.documents) {
      if (!doc.caseName) {
        unattributed.push(doc)
        continue
      }
      const bucket = byCase.get(doc.caseName)
      if (bucket) bucket.push(doc)
      else byCase.set(doc.caseName, [doc])
    }
    for (const [caseName, docs] of byCase) {
      if (docs.length > 1) group.runs.push({ caseName, documents: docs })
      else group.singles.push(docs[0]!)
    }
    group.singles.push(...unattributed)
  }

  // Prose first, payloads last, and alphabetical within a kind. The server sorts documents
  // by id, which would otherwise leave the sections in whatever order the filenames fell —
  // notes interleaved with exams, and a three-document section above a thirty.
  return [...groups.values()].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || a.label.localeCompare(b.label),
  )
}

const KIND_ORDER = ['default', 'transcript', 'exam']

const kindRank = (kind: string): number => {
  const at = KIND_ORDER.indexOf(kind)
  // A kind this dashboard has never heard of sorts after the ones it has, rather than
  // silently ahead of the notes because its name happens to start with a.
  return at < 0 ? KIND_ORDER.length : at
}

/** Case-insensitive match across every field an operator would recognise a document by. */
export const matchesQuery = (doc: CorpusDocument, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return true
  return q
    .split(/\s+/)
    .every((term) =>
      doc.case.toLowerCase().includes(term) ||
      doc.kind.toLowerCase().includes(term) ||
      kindLabel(doc.kind).toLowerCase().includes(term) ||
      (doc.class ?? '').toLowerCase().includes(term) ||
      (doc.note ?? '').toLowerCase().includes(term) ||
      doc.preview.toLowerCase().includes(term),
    )
}
