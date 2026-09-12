/**
 * The corpus a pack grades against, enumerated for a reader rather than for a run.
 *
 * The eval loop reaches documents one case at a time through `pack.document()`, because a
 * run only ever needs the case it is grading. A human choosing something to paste into a
 * text box needs the opposite: everything the pack holds, named, described, and cheap to
 * scan. That is this module.
 *
 * IT DOES NOT GO THROUGH `pack.document()`, and that is the point. `document()` records
 * every file it opens so `digest()` can state what a run actually read — the property that
 * makes a result reproducible. A dashboard browsing the corpus would write its own reading
 * into the digest of whatever run came next, and the record would claim the run consulted
 * notes it never saw. Reads here are plain, and the pack's opened-file set is untouched.
 *
 * Nothing served from here is a measurement. It is the input side of one, offered so an
 * operator can drive the harness with the same bytes the eval grades.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Pack } from './pack.ts'

/** One source document a pack holds, with whatever its answer key says about it. */
export interface CorpusDocument {
  /** `<pack>/<kind>/<case>` — stable, and the path segment that fetches the text. */
  id: string
  pack: string
  /** The `documents` kind this came from: `default` for notes, `transcript`, `exam`, … */
  kind: string
  /** The document's filename stem — what `{case}` substitutes to in the template. */
  case: string
  /**
   * The eval case that grades this document, when an answer key reaches it. Often the same
   * string as `case`, but not always: a patient-summary case names three notes, so all three
   * carry its name and a reader can see they are one record rather than three.
   */
  caseName?: string
  /** Path relative to the pack root, so a reader can find the file on disk. */
  path: string
  bytes: number
  lines: number
  /** First non-empty line, trimmed — enough to recognise a document in a list. */
  preview: string
  /** The answer key's prose about what this case discriminates, when it has one. */
  note?: string
  /** The case's own difficulty and class, when its answer key states them. */
  difficulty?: number
  class?: string
  /** Which eval files declare a case of this name, by manifest key. */
  evals: string[]
}

/** Case metadata as the eval files carry it. Everything past `name` is optional. */
interface CaseMeta {
  /** The case's own name, which is not always the document's filename stem. */
  caseName: string
  note?: string
  difficulty?: number
  class?: string
  evals: string[]
}

const PREVIEW_CHARS = 140

/**
 * The `documents` templates a pack declares, read back off the parsed manifest.
 *
 * `loadPack` normalises a bare string to the `default` kind before it validates, so the
 * same normalisation happens here rather than trusting callers to have loaded a table.
 */
const templatesOf = (pack: Pack): Record<string, string> => {
  const raw = pack.manifest.documents
  if (typeof raw === 'string') return { default: raw }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  }
  return {}
}

/**
 * Every document stem the pack's templates can reach, as one set.
 *
 * Needed before the answer keys are read, because attributing a case to its documents means
 * recognising which of the case's own string fields name a document. Without the set, a
 * case's `class: "block"` is indistinguishable from a reference to a note called `block`.
 */
const knownStems = (pack: Pack): Set<string> => {
  const stems = new Set<string>()
  for (const template of Object.values(templatesOf(pack))) {
    for (const stem of casesForTemplate(pack.root, template)) stems.add(stem)
  }
  return stems
}

/**
 * Case metadata for a pack, indexed by the DOCUMENT stem each case covers.
 *
 * Built from the manifest's `files` table rather than by walking `evals/`: this repository's
 * pack keeps its answer keys there, but the harness reads files by key and a pack is free to
 * file them anywhere. Any declared JSON file holding a `cases` array is an answer key, which
 * is a shape test rather than a path convention.
 *
 * A CASE IS NOT ALWAYS A DOCUMENT, and the index is keyed by document for that reason. Three
 * shapes appear in the reference pack alone: a case whose name is the document's stem; a
 * summary case naming several notes in `notes`, because the call it grades assembles a whole
 * record into one message; and a note-format case naming another corpus's note in `source`.
 * Keying on `name` alone left 29 of 62 notes with no description and no eval attribution —
 * they are the ones that most need it, since three of them are one patient's history and a
 * list that cannot say so is a list of unrelated slugs.
 *
 * So any string field, or any element of a string array, that names a known document stem is
 * a reference to it. That is general rather than a list of blessed field names: a pack may
 * call the field whatever it likes and this still finds it, while a field holding prose or a
 * class never collides because no document is named that.
 *
 * A document can be graded by several files — the note-format corpus grades the vital-signs
 * notes — so the first description wins and every file that reaches it is listed.
 */
const caseIndex = (pack: Pack): Map<string, CaseMeta> => {
  const index = new Map<string, CaseMeta>()
  const files = pack.manifest.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return index
  const stems = knownStems(pack)

  for (const [key, rel] of Object.entries(files as Record<string, unknown>)) {
    if (typeof rel !== 'string' || !rel.endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(resolve(pack.root, rel), 'utf8'))
    } catch {
      // A declared file that is missing or malformed is the eval loop's problem to report,
      // with the context to report it well. Listing a corpus is not the place to fail over
      // an answer key nobody asked for yet.
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const cases = (parsed as Record<string, unknown>).cases
    if (!Array.isArray(cases)) continue

    for (const entry of cases) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const caseName = record.name
      if (typeof caseName !== 'string' || caseName.length === 0) continue

      const referenced = new Set<string>()
      if (stems.has(caseName)) referenced.add(caseName)
      for (const [field, value] of Object.entries(record)) {
        // `name` is handled above; a case whose name is not a document must not claim one
        // that happens to share a string with its prose.
        if (field === 'name') continue
        for (const candidate of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) {
          if (typeof candidate === 'string' && stems.has(candidate)) referenced.add(candidate)
        }
      }

      for (const stem of referenced) {
        const existing = index.get(stem)
        if (existing) {
          if (!existing.evals.includes(key)) existing.evals.push(key)
          continue
        }
        index.set(stem, {
          caseName,
          note: typeof record.note === 'string' ? record.note : undefined,
          difficulty: typeof record.difficulty === 'number' ? record.difficulty : undefined,
          class: typeof record.class === 'string' ? record.class : undefined,
          evals: [key],
        })
      }
    }
  }
  return index
}

/**
 * Case names for one `documents` template, from the files actually on disk.
 *
 * The template is a path with `{case}` in it, so the directory it names is the corpus and
 * the text either side of `{case}` is the filename's fixed part. A file that does not match
 * both halves is some other thing living in the same directory, and is not a case.
 */
const casesForTemplate = (root: string, template: string): string[] => {
  const marker = '{case}'
  const at = template.indexOf(marker)
  if (at < 0) return []
  const dir = resolve(root, dirname(template))
  const base = template.slice(template.lastIndexOf('/', at) + 1)
  const cut = base.indexOf(marker)
  const prefix = base.slice(0, cut)
  const suffix = base.slice(cut + marker.length)

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // A declared corpus directory that is not there yet is an empty corpus, not an error:
    // the list is a browsing aid, and a pack mid-authoring should still open.
    return []
  }
  return entries
    .filter((name) => name.length > prefix.length + suffix.length)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => name.slice(prefix.length, name.length - suffix.length))
    .sort()
}

const previewOf = (text: string): string => {
  const first = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  const trimmed = first.trim()
  return trimmed.length <= PREVIEW_CHARS ? trimmed : `${trimmed.slice(0, PREVIEW_CHARS - 1)}…`
}

/**
 * Every source document in these packs, sorted by pack, then kind, then case name.
 *
 * Each document is opened once, for its size and its first line. That is the cost of a
 * list an operator can actually recognise entries in, and on a corpus of this size it is
 * a few hundred kilobytes read on a request that is not in any run's path.
 */
export const listCorpus = (packs: readonly Pack[]): CorpusDocument[] => {
  const out: CorpusDocument[] = []

  for (const pack of packs) {
    const cases = caseIndex(pack)
    for (const [kind, template] of Object.entries(templatesOf(pack)).sort(([a], [b]) => a.localeCompare(b))) {
      for (const stem of casesForTemplate(pack.root, template)) {
        const rel = template.replaceAll('{case}', stem)
        const abs = resolve(pack.root, rel)
        let text: string
        let bytes: number
        try {
          text = readFileSync(abs, 'utf8')
          bytes = statSync(abs).size
        } catch {
          continue
        }
        const meta = cases.get(stem)
        out.push({
          id: `${pack.name}/${kind}/${stem}`,
          pack: pack.name,
          kind,
          case: stem,
          caseName: meta?.caseName,
          path: rel,
          bytes,
          lines: text.split('\n').length,
          preview: previewOf(text),
          note: meta?.note,
          difficulty: meta?.difficulty,
          class: meta?.class,
          evals: meta?.evals ?? [],
        })
      }
    }
  }

  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export class CorpusError extends Error {}

/**
 * The text of one document, by the id `listCorpus` gave it.
 *
 * Resolved by enumerating the corpus and matching the id, never by joining the id onto a
 * path. The id arrives over HTTP, and a path built from it is a file read an outside caller
 * chooses the target of — `../../etc/passwd` is a case name as far as string concatenation
 * is concerned. Matching against the list means the only readable files are the ones the
 * pack's own templates already named.
 */
export const readCorpusDocument = (packs: readonly Pack[], id: string): { document: CorpusDocument; text: string } => {
  const document = listCorpus(packs).find((entry) => entry.id === id)
  if (!document) throw new CorpusError(`no corpus document '${id}'`)
  const pack = packs.find((entry) => entry.name === document.pack)
  if (!pack) throw new CorpusError(`no corpus document '${id}'`)
  return { document, text: readFileSync(resolve(pack.root, document.path), 'utf8') }
}
